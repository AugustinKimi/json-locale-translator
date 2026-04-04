const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 5 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseDelayMs?: number;
  /** Upper cap on backoff delay in ms. Default: 30000 */
  maxDelayMs?: number;
  /** Injectable delay function — override in tests to avoid real waits. */
  delayFn?: (ms: number) => Promise<void>;
}

/**
 * Returns true for errors that are worth retrying:
 *  - 429 Rate Limit
 *  - 5xx Server errors
 *  - Network-level errors (no HTTP status)
 */
export function isRetryable(err: unknown): boolean {
  const status =
    (err as Record<string, unknown>)?.status ??
    (err as Record<string, unknown>)?.statusCode;
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status <= 599);
  }
  // Network-level errors without an HTTP status code
  if (err instanceof Error) {
    return /econnreset|enotfound|socket hang up|network|etimedout/i.test(
      err.message,
    );
  }
  return false;
}

function computeDelay(
  err: unknown,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // Respect Retry-After header if the SDK surfaces it (seconds as a string)
  const headers = (err as Record<string, unknown>)?.headers as
    | Record<string, string>
    | undefined;
  if (headers?.["retry-after"]) {
    const ms = parseFloat(headers["retry-after"]) * 1000;
    if (!isNaN(ms) && ms > 0) return Math.min(ms, maxDelayMs);
  }
  // Exponential backoff: base * 2^attempt, capped, +/- 15 % jitter
  const exp = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = exp * (Math.random() * 0.3 - 0.15);
  return Math.round(exp + jitter);
}

/**
 * Calls `fn()` and retries with exponential backoff when the error is
 * considered retryable (rate limits, server errors, network errors).
 * Non-retryable errors (4xx except 429, bad input, etc.) are re-thrown
 * immediately without consuming additional attempts.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    delayFn = defaultDelay,
  } = options;

  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;

      if (!isLast && isRetryable(err)) {
        const delay = computeDelay(err, attempt, baseDelayMs, maxDelayMs);
        const status = (err as Record<string, unknown>)?.status;
        const label =
          status === 429
            ? `Rate limit reached — waiting ${(delay / 1000).toFixed(1)}s for the limit to reset`
            : `API error (${status ?? "network"}) — retrying in ${(delay / 1000).toFixed(1)}s`;
        process.stderr.write(
          `[warn] ${label} (attempt ${attempt + 1}/${maxAttempts})...\n`,
        );
        await delayFn(delay);
      } else {
        throw err;
      }
    }
  }

  // Exhausted all attempts
  throw lastErr;
}
