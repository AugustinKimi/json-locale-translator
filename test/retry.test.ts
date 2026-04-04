import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import { retryWithBackoff, isRetryable } from "../src/retry";

// ─── isRetryable ──────────────────────────────────────────────────────────────

describe("isRetryable", () => {
  test("returns true for 429", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  test("returns true for 500", () => {
    expect(isRetryable({ status: 500 })).toBe(true);
  });

  test("returns true for 503", () => {
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  test("returns false for 400", () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });

  test("returns false for 401", () => {
    expect(isRetryable({ status: 401 })).toBe(false);
  });

  test("returns false for 404", () => {
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  test("returns true for ECONNRESET network error", () => {
    expect(isRetryable(new Error("read ECONNRESET"))).toBe(true);
  });

  test("returns true for ETIMEDOUT network error", () => {
    expect(isRetryable(new Error("connect ETIMEDOUT"))).toBe(true);
  });

  test("returns true for socket hang up", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
  });

  test("returns false for a plain non-network error", () => {
    expect(isRetryable(new Error("invalid key"))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isRetryable("some string")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  test("reads statusCode as fallback when status is absent", () => {
    expect(isRetryable({ statusCode: 429 })).toBe(true);
    expect(isRetryable({ statusCode: 400 })).toBe(false);
  });
});

// ─── retryWithBackoff ─────────────────────────────────────────────────────────

describe("retryWithBackoff", () => {
  // No-op delay so tests run instantly
  const noDelay = async () => {};

  test("returns result on first success", async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValueOnce("ok");
    const result = await retryWithBackoff(fn, { delayFn: noDelay });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on 429 and succeeds on second attempt", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce("ok");

    const result = await retryWithBackoff(fn, { delayFn: noDelay });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("retries on 500 and succeeds on third attempt", async () => {
    const serverErr = Object.assign(new Error("Server Error"), { status: 500 });
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(serverErr)
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce("ok");

    const result = await retryWithBackoff(fn, {
      delayFn: noDelay,
      maxAttempts: 5,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("throws immediately on non-retryable error (400)", async () => {
    const badRequest = Object.assign(new Error("Bad Request"), { status: 400 });
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(badRequest);

    await expect(retryWithBackoff(fn, { delayFn: noDelay })).rejects.toThrow(
      "Bad Request",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("exhausts all attempts and throws the last error", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(rateLimitErr);

    await expect(
      retryWithBackoff(fn, { delayFn: noDelay, maxAttempts: 3 }),
    ).rejects.toThrow("Too Many Requests");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("calls delayFn between retries", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limit"), {
      status: 429,
    });
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce("ok");

    await retryWithBackoff(fn, { delayFn, baseDelayMs: 100, maxDelayMs: 1000 });
    expect(delayFn).toHaveBeenCalledTimes(1);
    const [delayMs] = delayFn.mock.calls[0] as [number];
    expect(delayMs).toBeGreaterThan(0);
    expect(delayMs).toBeLessThanOrEqual(1000);
  });

  test("respects Retry-After header when present", async () => {
    const rateLimitErr = Object.assign(new Error("Rate limit"), {
      status: 429,
      headers: { "retry-after": "2" }, // 2 seconds
    });
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce("ok");

    await retryWithBackoff(fn, { delayFn, maxDelayMs: 60000 });
    const [delayMs] = delayFn.mock.calls[0] as [number];
    expect(delayMs).toBe(2000); // exactly 2 s from the header
  });

  test("logs a rate-limit warning to stderr", async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce("ok");

    await retryWithBackoff(fn, { delayFn: noDelay });

    const allOutput = (stderrSpy.mock.calls as string[][]).flat().join("\n");
    expect(allOutput).toMatch(/Rate limit reached/);
    expect(allOutput).toMatch(/waiting.*for the limit to reset/);
    stderrSpy.mockRestore();
  });

  test("logs a server-error warning to stderr", async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const serverErr = Object.assign(new Error("Internal Server Error"), {
      status: 502,
    });
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce("ok");

    await retryWithBackoff(fn, { delayFn: noDelay });

    const allOutput = (stderrSpy.mock.calls as string[][]).flat().join("\n");
    expect(allOutput).toMatch(/API error \(502\)/);
    stderrSpy.mockRestore();
  });

  test("does not delay on non-retryable errors", async () => {
    const delayFn = jest.fn<(ms: number) => Promise<void>>();
    const fn = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("Auth failed"));

    await expect(retryWithBackoff(fn, { delayFn })).rejects.toThrow(
      "Auth failed",
    );
    expect(delayFn).not.toHaveBeenCalled();
  });
});
