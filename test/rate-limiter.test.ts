import { describe, test, expect, jest } from "@jest/globals";
import { RateLimiter } from "../src/rate-limiter";

// ─── Header parsing helpers ───────────────────────────────────────────────────

describe("RateLimiter.parseOpenAiDuration", () => {
  test("parses seconds only: '30s' → 30000", () => {
    expect(RateLimiter.parseOpenAiDuration("30s")).toBe(30_000);
  });

  test("parses minutes only: '1m' → 60000", () => {
    expect(RateLimiter.parseOpenAiDuration("1m")).toBe(60_000);
  });

  test("parses minutes and seconds: '6m0s' → 360000", () => {
    expect(RateLimiter.parseOpenAiDuration("6m0s")).toBe(360_000);
  });

  test("parses '1m30s' → 90000", () => {
    expect(RateLimiter.parseOpenAiDuration("1m30s")).toBe(90_000);
  });

  test("parses fractional seconds: '1.5s' → 1500", () => {
    expect(RateLimiter.parseOpenAiDuration("1.5s")).toBe(1_500);
  });

  test("parses milliseconds: '500ms' → 500", () => {
    expect(RateLimiter.parseOpenAiDuration("500ms")).toBe(500);
  });

  test("parses '0s' → 0", () => {
    expect(RateLimiter.parseOpenAiDuration("0s")).toBe(0);
  });
});

describe("RateLimiter.parseIsoDateTime", () => {
  test("parses an ISO-8601 datetime to epoch ms", () => {
    const iso = "2026-04-04T12:00:00.000Z";
    expect(RateLimiter.parseIsoDateTime(iso)).toBe(new Date(iso).getTime());
  });
});

// ─── update() — OpenAI headers ────────────────────────────────────────────────

describe("RateLimiter.update — OpenAI headers", () => {
  function makeHeaders(entries: Record<string, string>) {
    return { get: (name: string): string | null => entries[name] ?? null };
  }

  test("reads x-ratelimit-limit-requests and remaining", () => {
    const limiter = new RateLimiter();
    limiter.update(
      makeHeaders({
        "x-ratelimit-limit-requests": "500",
        "x-ratelimit-remaining-requests": "42",
        "x-ratelimit-reset-requests": "60s",
      }),
    );
    const state = limiter.currentState;
    expect(state.requestsLimit).toBe(500);
    expect(state.requestsRemaining).toBe(42);
    expect(state.requestsResetAt).toBeGreaterThan(Date.now());
  });

  test("reads x-ratelimit-limit-tokens and remaining", () => {
    const limiter = new RateLimiter();
    limiter.update(
      makeHeaders({
        "x-ratelimit-limit-tokens": "100000",
        "x-ratelimit-remaining-tokens": "50000",
        "x-ratelimit-reset-tokens": "30s",
      }),
    );
    const state = limiter.currentState;
    expect(state.tokensLimit).toBe(100_000);
    expect(state.tokensRemaining).toBe(50_000);
    expect(state.tokensResetAt).toBeGreaterThan(Date.now());
  });

  test("ignores absent headers (values stay null)", () => {
    const limiter = new RateLimiter();
    limiter.update(makeHeaders({ "x-ratelimit-remaining-requests": "10" }));
    expect(limiter.currentState.requestsLimit).toBeNull();
    expect(limiter.currentState.requestsRemaining).toBe(10);
  });
});

// ─── update() — Anthropic headers ────────────────────────────────────────────

describe("RateLimiter.update — Anthropic headers", () => {
  function makeHeaders(entries: Record<string, string>) {
    return { get: (name: string): string | null => entries[name] ?? null };
  }

  test("reads anthropic-ratelimit-requests-* headers", () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const limiter = new RateLimiter();
    limiter.update(
      makeHeaders({
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "750",
        "anthropic-ratelimit-requests-reset": resetAt,
      }),
    );
    const state = limiter.currentState;
    expect(state.requestsLimit).toBe(1000);
    expect(state.requestsRemaining).toBe(750);
    expect(state.requestsResetAt).toBeCloseTo(
      new Date(resetAt).getTime(),
      -3, // within 1 second
    );
  });

  test("reads anthropic-ratelimit-tokens-* headers", () => {
    const resetAt = new Date(Date.now() + 30_000).toISOString();
    const limiter = new RateLimiter();
    limiter.update(
      makeHeaders({
        "anthropic-ratelimit-tokens-limit": "200000",
        "anthropic-ratelimit-tokens-remaining": "180000",
        "anthropic-ratelimit-tokens-reset": resetAt,
      }),
    );
    const state = limiter.currentState;
    expect(state.tokensLimit).toBe(200_000);
    expect(state.tokensRemaining).toBe(180_000);
  });
});

// ─── throttle() ───────────────────────────────────────────────────────────────

describe("RateLimiter.throttle", () => {
  function makeHeaders(entries: Record<string, string>) {
    return { get: (name: string): string | null => entries[name] ?? null };
  }

  test("does nothing when no rate-limit state is known", async () => {
    const delayFn = jest.fn<(ms: number) => Promise<void>>();
    const limiter = new RateLimiter(delayFn);
    await limiter.throttle();
    expect(delayFn).not.toHaveBeenCalled();
  });

  test("does nothing when remaining is high relative to window", async () => {
    const delayFn = jest.fn<(ms: number) => Promise<void>>();
    const limiter = new RateLimiter(delayFn);
    // 500 remaining requests in 60 s → delay ≈ 60000/400 = 150 ms < MIN_THROTTLE_MS (200)
    limiter.update(
      makeHeaders({
        "x-ratelimit-remaining-requests": "500",
        "x-ratelimit-reset-requests": "60s",
      }),
    );
    await limiter.throttle();
    expect(delayFn).not.toHaveBeenCalled();
  });

  test("waits when remaining is low relative to window", async () => {
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const limiter = new RateLimiter(delayFn);
    // 2 remaining requests in 10 s → delay = 10000 / floor(2 * 0.8) = 10000 ms
    limiter.update(
      makeHeaders({
        "x-ratelimit-remaining-requests": "2",
        "x-ratelimit-reset-requests": "10s",
      }),
    );
    await limiter.throttle();
    expect(delayFn).toHaveBeenCalledTimes(1);
    const [delayMs] = delayFn.mock.calls[0] as [number];
    expect(delayMs).toBeGreaterThanOrEqual(200);
  });

  test("logs to stderr when throttling", async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const limiter = new RateLimiter(delayFn);
    limiter.update(
      makeHeaders({
        "x-ratelimit-remaining-requests": "1",
        "x-ratelimit-reset-requests": "60s",
      }),
    );
    await limiter.throttle();
    const output = (stderrSpy.mock.calls as string[][]).flat().join("");
    expect(output).toMatch(/\[info\] Throttling/);
    stderrSpy.mockRestore();
  });

  test("waits for full token window when token budget < 10 %", async () => {
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const limiter = new RateLimiter(delayFn);
    // 5 % of token budget left, resets in 30 s
    limiter.update(
      makeHeaders({
        "x-ratelimit-limit-tokens": "100000",
        "x-ratelimit-remaining-tokens": "5000",
        "x-ratelimit-reset-tokens": "30s",
      }),
    );
    await limiter.throttle();
    expect(delayFn).toHaveBeenCalled();
    const [delayMs] = delayFn.mock.calls[0] as [number];
    // Should be close to 30 000 ms
    expect(delayMs).toBeGreaterThanOrEqual(28_000);
  });

  test("does not wait when token budget is above 10 %", async () => {
    const delayFn = jest.fn<(ms: number) => Promise<void>>();
    const limiter = new RateLimiter(delayFn);
    // 50 % left
    limiter.update(
      makeHeaders({
        "x-ratelimit-limit-tokens": "100000",
        "x-ratelimit-remaining-tokens": "50000",
        "x-ratelimit-reset-tokens": "30s",
      }),
    );
    await limiter.throttle();
    expect(delayFn).not.toHaveBeenCalled();
  });

  test("does not throttle when reset window has already passed", async () => {
    const delayFn = jest.fn<(ms: number) => Promise<void>>();
    const limiter = new RateLimiter(delayFn);
    // Simulate reset time in the past
    limiter.update(
      makeHeaders({
        "x-ratelimit-remaining-requests": "1",
        "x-ratelimit-reset-requests": "0s",
      }),
    );
    await limiter.throttle();
    expect(delayFn).not.toHaveBeenCalled();
  });
});
