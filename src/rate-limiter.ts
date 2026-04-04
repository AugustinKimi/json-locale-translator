/**
 * Proactive rate-limit throttler.
 *
 * After every successful API response both providers call `update()` with the
 * raw HTTP response headers.  Before every API request they call `throttle()`,
 * which computes a small delay so that the remaining request budget is spread
 * evenly across the remaining window — avoiding 429s in the first place rather
 * than waiting to recover from them.
 *
 * Supported header formats
 * ─────────────────────────
 * OpenAI   : x-ratelimit-{limit,remaining,reset}-{requests,tokens}
 *            reset value is a duration string like "6m0s", "30s", "1.5s"
 *
 * Anthropic: anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}
 *            reset value is an ISO-8601 datetime string
 */

export interface RateLimitState {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  /** Epoch ms at which the requests window resets. */
  requestsResetAt: number | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  /** Epoch ms at which the tokens window resets. */
  tokensResetAt: number | null;
}

/**
 * Minimum computed throttle delay worth actually sleeping for.
 * Below this the overhead isn't worth it.
 */
const MIN_THROTTLE_MS = 200;

/**
 * Only consume this fraction of the remaining budget per request.
 * Leaves a safety margin so we never accidentally exhaust the window.
 */
const HEADROOM_FRACTION = 0.8;

export class RateLimiter {
  private state: RateLimitState = {
    requestsLimit: null,
    requestsRemaining: null,
    requestsResetAt: null,
    tokensLimit: null,
    tokensRemaining: null,
    tokensResetAt: null,
  };

  constructor(
    private readonly _delayFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  // ─── Header parsers ────────────────────────────────────────────────────

  /**
   * Parse OpenAI's compact duration format → milliseconds.
   * Examples: "6m0s", "1m30s", "30s", "1.5s", "500ms"
   */
  static parseOpenAiDuration(str: string): number {
    let ms = 0;
    const minutes = str.match(/(\d+(?:\.\d+)?)m(?!s)/);
    const seconds = str.match(/(\d+(?:\.\d+)?)s/);
    const millis = str.match(/(\d+(?:\.\d+)?)ms/);
    if (minutes) ms += parseFloat(minutes[1]) * 60_000;
    if (seconds) ms += parseFloat(seconds[1]) * 1_000;
    if (millis) ms += parseFloat(millis[1]);
    return ms;
  }

  /** Parse Anthropic's ISO-8601 datetime reset value → epoch ms. */
  static parseIsoDateTime(str: string): number {
    return new Date(str).getTime();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Feed raw response headers into the limiter.
   * Accepts any object with a `.get(name: string): string | null` method
   * (both the Web `Headers` API and Node `fetch` response headers satisfy this).
   */
  update(headers: { get(name: string): string | null }): void {
    const now = Date.now();

    // ── OpenAI ──────────────────────────────────────────────────────────
    const oaiReqLimit = headers.get("x-ratelimit-limit-requests");
    const oaiReqRemaining = headers.get("x-ratelimit-remaining-requests");
    const oaiReqReset = headers.get("x-ratelimit-reset-requests");
    const oaiTokLimit = headers.get("x-ratelimit-limit-tokens");
    const oaiTokRemaining = headers.get("x-ratelimit-remaining-tokens");
    const oaiTokReset = headers.get("x-ratelimit-reset-tokens");

    if (oaiReqLimit !== null)
      this.state.requestsLimit = parseInt(oaiReqLimit, 10);
    if (oaiReqRemaining !== null)
      this.state.requestsRemaining = parseInt(oaiReqRemaining, 10);
    if (oaiReqReset !== null)
      this.state.requestsResetAt =
        now + RateLimiter.parseOpenAiDuration(oaiReqReset);
    if (oaiTokLimit !== null)
      this.state.tokensLimit = parseInt(oaiTokLimit, 10);
    if (oaiTokRemaining !== null)
      this.state.tokensRemaining = parseInt(oaiTokRemaining, 10);
    if (oaiTokReset !== null)
      this.state.tokensResetAt =
        now + RateLimiter.parseOpenAiDuration(oaiTokReset);

    // ── Anthropic ────────────────────────────────────────────────────────
    const anReqLimit = headers.get("anthropic-ratelimit-requests-limit");
    const anReqRemaining = headers.get(
      "anthropic-ratelimit-requests-remaining",
    );
    const anReqReset = headers.get("anthropic-ratelimit-requests-reset");
    const anTokLimit = headers.get("anthropic-ratelimit-tokens-limit");
    const anTokRemaining = headers.get("anthropic-ratelimit-tokens-remaining");
    const anTokReset = headers.get("anthropic-ratelimit-tokens-reset");

    if (anReqLimit !== null)
      this.state.requestsLimit = parseInt(anReqLimit, 10);
    if (anReqRemaining !== null)
      this.state.requestsRemaining = parseInt(anReqRemaining, 10);
    if (anReqReset !== null)
      this.state.requestsResetAt = RateLimiter.parseIsoDateTime(anReqReset);
    if (anTokLimit !== null) this.state.tokensLimit = parseInt(anTokLimit, 10);
    if (anTokRemaining !== null)
      this.state.tokensRemaining = parseInt(anTokRemaining, 10);
    if (anTokReset !== null)
      this.state.tokensResetAt = RateLimiter.parseIsoDateTime(anTokReset);
  }

  /**
   * Call this BEFORE making an API request.
   *
   * Computes how long to wait so that the remaining request budget is spread
   * evenly across the time left in the current window, then sleeps if that
   * delay is above the minimum threshold.
   *
   * Formula: delay = windowMs / (remaining * HEADROOM_FRACTION)
   *
   * A secondary token-budget check kicks in if token capacity drops below 10 %
   * of the limit, waiting until the token window fully resets.
   */
  async throttle(): Promise<void> {
    const now = Date.now();
    let delay = 0;

    // ── Request-based throttle ───────────────────────────────────────────
    if (
      this.state.requestsRemaining !== null &&
      this.state.requestsResetAt !== null &&
      this.state.requestsRemaining > 0
    ) {
      const windowMs = Math.max(this.state.requestsResetAt - now, 0);
      if (windowMs > 0) {
        const safeRemaining = Math.max(
          1,
          Math.floor(this.state.requestsRemaining * HEADROOM_FRACTION),
        );
        delay = Math.max(delay, windowMs / safeRemaining);
      }
    }

    // ── Token-based throttle (emergency) ─────────────────────────────────
    if (
      this.state.tokensRemaining !== null &&
      this.state.tokensLimit !== null &&
      this.state.tokensResetAt !== null
    ) {
      const fraction = this.state.tokensRemaining / this.state.tokensLimit;
      if (fraction < 0.1) {
        // Less than 10 % of token budget remains — wait out the full window
        const windowMs = Math.max(this.state.tokensResetAt - now, 0);
        delay = Math.max(delay, windowMs);
      }
    }

    if (delay >= MIN_THROTTLE_MS) {
      const secs = (delay / 1000).toFixed(1);
      process.stderr.write(
        `[info] Throttling: waiting ${secs}s to stay within rate limits\n`,
      );
      await this._delayFn(delay);
    }
  }

  /** Snapshot of the last-known rate-limit state (useful for logging / tests). */
  get currentState(): Readonly<RateLimitState> {
    return { ...this.state };
  }
}
