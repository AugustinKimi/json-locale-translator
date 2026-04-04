import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// ─── SDK mocks (must come before importing the providers) ─────────────────────
//
// Both providers now call  create(...).withResponse()  which returns
// { data, response: { headers } }.  Mocks must reflect that shape.

type WithResponseResult = { withResponse: () => Promise<unknown> };

const mockOpenAICreate = jest.fn<() => WithResponseResult>();
jest.unstable_mockModule("openai", () => ({
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

const mockAnthropicCreate = jest.fn<() => WithResponseResult>();
jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicCreate },
  })),
}));

const { OpenAIProvider } = await import("../src/providers/openai");
const { AnthropicProvider } = await import("../src/providers/anthropic");

// ─── helpers ──────────────────────────────────────────────────────────────────

const OPENAI_CONFIG = {
  name: "openai" as const,
  model: "gpt-4o",
  apiKey: "test-key",
};
const ANTHROPIC_CONFIG = {
  name: "anthropic" as const,
  model: "claude-3-5-sonnet-20241022",
  apiKey: "test-key",
};
const SYSTEM_PROMPT = "Translate to {locale}.";

const SOURCE_KEYS = {
  greeting: "Hello",
  farewell: "Goodbye",
  question: "How are you?",
};

const TRANSLATED_FR = {
  greeting: "Bonjour",
  farewell: "Au revoir",
  question: "Comment allez-vous?",
};

/** Fake Headers object — no rate-limit info by default. */
function makeHeaders(entries: Record<string, string> = {}) {
  return { get: (name: string): string | null => entries[name] ?? null };
}

/**
 * Wrap a successful OpenAI completion payload in the .withResponse() shape.
 * Pass `headers` to simulate provider rate-limit response headers.
 */
function openaiApiResponse(
  content: string,
  headers: Record<string, string> = {},
): WithResponseResult {
  const data = { choices: [{ message: { content } }] };
  return {
    withResponse: () =>
      Promise.resolve({ data, response: { headers: makeHeaders(headers) } }),
  };
}

/** Wrap a raw OpenAI data payload (for edge-case tests). */
function openaiApiRaw(
  data: unknown,
  headers: Record<string, string> = {},
): WithResponseResult {
  return {
    withResponse: () =>
      Promise.resolve({ data, response: { headers: makeHeaders(headers) } }),
  };
}

/** Make .withResponse() reject with the given error. */
function apiError(err: Error): WithResponseResult {
  return { withResponse: () => Promise.reject(err) };
}

/** Wrap a successful Anthropic messages payload in the .withResponse() shape. */
function anthropicApiResponse(
  text: string,
  headers: Record<string, string> = {},
): WithResponseResult {
  const data = { content: [{ type: "text", text }] };
  return {
    withResponse: () =>
      Promise.resolve({ data, response: { headers: makeHeaders(headers) } }),
  };
}

/** Wrap a raw Anthropic data payload (for edge-case tests). */
function anthropicApiRaw(
  data: unknown,
  headers: Record<string, string> = {},
): WithResponseResult {
  return {
    withResponse: () =>
      Promise.resolve({ data, response: { headers: makeHeaders(headers) } }),
  };
}

// ─── OpenAI provider ──────────────────────────────────────────────────────────

describe("OpenAIProvider", () => {
  let provider: InstanceType<typeof OpenAIProvider>;
  const noDelay = async () => {};

  beforeEach(() => {
    provider = new OpenAIProvider(OPENAI_CONFIG, noDelay);
    mockOpenAICreate.mockReset();
  });

  test("happy path — clean JSON response is parsed and returned", async () => {
    mockOpenAICreate.mockReturnValueOnce(
      openaiApiResponse(JSON.stringify(TRANSLATED_FR)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in ```json … ``` code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockOpenAICreate.mockReturnValueOnce(openaiApiResponse(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in plain ``` … ``` code fence", async () => {
    const fenced = "```\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockOpenAICreate.mockReturnValueOnce(openaiApiResponse(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles response with surrounding whitespace / newlines", async () => {
    mockOpenAICreate.mockReturnValueOnce(
      openaiApiResponse("\n\n  " + JSON.stringify(TRANSLATED_FR) + "  \n"),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("retry — first response is invalid JSON, second is valid", async () => {
    mockOpenAICreate
      .mockReturnValueOnce(openaiApiResponse("Sorry, I cannot translate that."))
      .mockReturnValueOnce(openaiApiResponse(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
  });

  test("throws after two consecutive invalid JSON responses", async () => {
    mockOpenAICreate
      .mockReturnValueOnce(openaiApiResponse("not json at all"))
      .mockReturnValueOnce(openaiApiResponse("still not json"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/not valid JSON after retry/);
  });

  test("rate limit (429) — waits and retries, succeeds on second attempt", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    mockOpenAICreate
      .mockReturnValueOnce(apiError(rateLimitErr))
      .mockReturnValueOnce(openaiApiResponse(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
  });

  test("rate limit (429) — logs the waiting message to stderr", async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    mockOpenAICreate
      .mockReturnValueOnce(apiError(rateLimitErr))
      .mockReturnValueOnce(openaiApiResponse(JSON.stringify(TRANSLATED_FR)));

    await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);

    const warnLines = (stderrSpy.mock.calls as string[][])
      .flat()
      .filter((m) => m.includes("Rate limit reached"));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    expect(warnLines[0]).toMatch(/waiting.*for the limit to reset/);
    stderrSpy.mockRestore();
  });

  test("rate limit exhausted after maxAttempts — throws", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    mockOpenAICreate.mockReturnValue(apiError(rateLimitErr));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/OpenAI API call failed/);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(5);
  });

  test("server error (500) — retries and succeeds", async () => {
    const serverErr = Object.assign(new Error("Internal Server Error"), {
      status: 500,
    });
    mockOpenAICreate
      .mockReturnValueOnce(apiError(serverErr))
      .mockReturnValueOnce(openaiApiResponse(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
  });

  test("non-retryable error (400) — fails immediately without retrying", async () => {
    const badRequestErr = Object.assign(new Error("Bad Request"), {
      status: 400,
    });
    mockOpenAICreate.mockReturnValue(apiError(badRequestErr));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/OpenAI API call failed/);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
  });

  test("throws when retry API call also fails", async () => {
    mockOpenAICreate
      .mockReturnValueOnce(openaiApiResponse("not json"))
      .mockReturnValueOnce(apiError(new Error("rate limited")));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/OpenAI API call failed on retry/);
  });

  test("throws on empty response content", async () => {
    mockOpenAICreate.mockReturnValueOnce(
      openaiApiRaw({ choices: [{ message: { content: null } }] }),
    );

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Empty response/);
  });

  test("missing key in response — falls back to original value", async () => {
    const partial = { greeting: "Bonjour", farewell: "Au revoir" };
    mockOpenAICreate.mockReturnValueOnce(
      openaiApiResponse(JSON.stringify(partial)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result.greeting).toBe("Bonjour");
    expect(result.farewell).toBe("Au revoir");
    expect(result.question).toBe(SOURCE_KEYS.question);
  });

  test("large batch — all keys translated correctly", async () => {
    const largeKeys: Record<string, string> = {};
    const largeTranslated: Record<string, string> = {};
    for (let i = 0; i < 80; i++) {
      largeKeys[`key_${i}`] = `English value ${i}`;
      largeTranslated[`key_${i}`] = `French value ${i}`;
    }
    mockOpenAICreate.mockReturnValueOnce(
      openaiApiResponse(JSON.stringify(largeTranslated)),
    );

    const result = await provider.translate(largeKeys, "fr", SYSTEM_PROMPT);
    expect(Object.keys(result)).toHaveLength(80);
    expect(result.key_0).toBe("French value 0");
    expect(result.key_79).toBe("French value 79");
  });

  test("preserves nested-looking keys (dot-notation flat keys)", async () => {
    const flat = { "nav.home": "Home", "nav.about": "About" };
    const translated = { "nav.home": "Accueil", "nav.about": "À propos" };
    mockOpenAICreate.mockReturnValueOnce(
      openaiApiResponse(JSON.stringify(translated)),
    );

    const result = await provider.translate(flat, "fr", SYSTEM_PROMPT);
    expect(result["nav.home"]).toBe("Accueil");
    expect(result["nav.about"]).toBe("À propos");
  });

  test("reads x-ratelimit headers and throttles subsequent requests", async () => {
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const throttlingProvider = new OpenAIProvider(OPENAI_CONFIG, delayFn);

    // First response: 2 requests remaining in 10 s window
    mockOpenAICreate
      .mockReturnValueOnce(
        openaiApiResponse(JSON.stringify(TRANSLATED_FR), {
          "x-ratelimit-remaining-requests": "2",
          "x-ratelimit-reset-requests": "10s",
        }),
      )
      .mockReturnValueOnce(openaiApiResponse(JSON.stringify(TRANSLATED_FR)));

    await throttlingProvider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    // Second call: rate limiter should compute a delay ≥ MIN_THROTTLE_MS (200 ms)
    await throttlingProvider.translate(SOURCE_KEYS, "de", SYSTEM_PROMPT);

    expect(delayFn).toHaveBeenCalled();
    const [delayMs] = delayFn.mock.calls[0] as [number];
    expect(delayMs).toBeGreaterThanOrEqual(200);
  });
});

// ─── Anthropic provider ───────────────────────────────────────────────────────

describe("AnthropicProvider", () => {
  let provider: InstanceType<typeof AnthropicProvider>;
  const noDelay = async () => {};

  beforeEach(() => {
    provider = new AnthropicProvider(ANTHROPIC_CONFIG, noDelay);
    mockAnthropicCreate.mockReset();
  });

  test("happy path — clean JSON response is parsed and returned", async () => {
    mockAnthropicCreate.mockReturnValueOnce(
      anthropicApiResponse(JSON.stringify(TRANSLATED_FR)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in ```json … ``` code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockAnthropicCreate.mockReturnValueOnce(anthropicApiResponse(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in plain ``` … ``` code fence", async () => {
    const fenced = "```\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockAnthropicCreate.mockReturnValueOnce(anthropicApiResponse(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles response with surrounding whitespace / newlines", async () => {
    mockAnthropicCreate.mockReturnValueOnce(
      anthropicApiResponse("\n  " + JSON.stringify(TRANSLATED_FR) + "  \n"),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("retry — first response is invalid JSON, second is valid", async () => {
    mockAnthropicCreate
      .mockReturnValueOnce(anthropicApiResponse("I cannot do that."))
      .mockReturnValueOnce(anthropicApiResponse(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
  });

  test("throws after two consecutive invalid JSON responses", async () => {
    mockAnthropicCreate
      .mockReturnValueOnce(anthropicApiResponse("not json"))
      .mockReturnValueOnce(anthropicApiResponse("also not json"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/not valid JSON after retry/);
  });

  test("rate limit (429) — waits and retries, succeeds on second attempt", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    mockAnthropicCreate
      .mockReturnValueOnce(apiError(rateLimitErr))
      .mockReturnValueOnce(anthropicApiResponse(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
  });

  test("rate limit (429) — logs the waiting message to stderr", async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    mockAnthropicCreate
      .mockReturnValueOnce(apiError(rateLimitErr))
      .mockReturnValueOnce(anthropicApiResponse(JSON.stringify(TRANSLATED_FR)));

    await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);

    const warnLines = (stderrSpy.mock.calls as string[][])
      .flat()
      .filter((m) => m.includes("Rate limit reached"));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    expect(warnLines[0]).toMatch(/waiting.*for the limit to reset/);
    stderrSpy.mockRestore();
  });

  test("rate limit exhausted after maxAttempts — throws", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    mockAnthropicCreate.mockReturnValue(apiError(rateLimitErr));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Anthropic API call failed/);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5);
  });

  test("server error (500) — retries and succeeds", async () => {
    const serverErr = Object.assign(new Error("Internal Server Error"), {
      status: 500,
    });
    mockAnthropicCreate
      .mockReturnValueOnce(apiError(serverErr))
      .mockReturnValueOnce(anthropicApiResponse(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
  });

  test("non-retryable error (400) — fails immediately without retrying", async () => {
    const badRequestErr = Object.assign(new Error("Bad Request"), {
      status: 400,
    });
    mockAnthropicCreate.mockReturnValue(apiError(badRequestErr));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Anthropic API call failed/);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  test("throws when retry API call also fails", async () => {
    mockAnthropicCreate
      .mockReturnValueOnce(anthropicApiResponse("not json"))
      .mockReturnValueOnce(apiError(new Error("overloaded")));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Anthropic API call failed on retry/);
  });

  test("throws when response content block is not text type", async () => {
    mockAnthropicCreate.mockReturnValueOnce(
      anthropicApiRaw({
        content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      }),
    );

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Unexpected response content type/);
  });

  test("missing key in response — falls back to original value", async () => {
    const partial = { greeting: "Bonjour", farewell: "Au revoir" };
    mockAnthropicCreate.mockReturnValueOnce(
      anthropicApiResponse(JSON.stringify(partial)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result.greeting).toBe("Bonjour");
    expect(result.farewell).toBe("Au revoir");
    expect(result.question).toBe(SOURCE_KEYS.question);
  });

  test("large batch — all keys translated correctly", async () => {
    const largeKeys: Record<string, string> = {};
    const largeTranslated: Record<string, string> = {};
    for (let i = 0; i < 80; i++) {
      largeKeys[`key_${i}`] = `English value ${i}`;
      largeTranslated[`key_${i}`] = `Japanese value ${i}`;
    }
    mockAnthropicCreate.mockReturnValueOnce(
      anthropicApiResponse(JSON.stringify(largeTranslated)),
    );

    const result = await provider.translate(largeKeys, "ja", SYSTEM_PROMPT);
    expect(Object.keys(result)).toHaveLength(80);
    expect(result.key_0).toBe("Japanese value 0");
    expect(result.key_79).toBe("Japanese value 79");
  });

  test("values containing special characters are preserved", async () => {
    const special = {
      html: "<b>Bold</b>",
      template: "Hello {name}, you have {count} messages",
      emoji: "Welcome 🎉",
    };
    const translatedSpecial = {
      html: "<b>Gras</b>",
      template: "Bonjour {name}, vous avez {count} messages",
      emoji: "Bienvenue 🎉",
    };
    mockAnthropicCreate.mockReturnValueOnce(
      anthropicApiResponse(JSON.stringify(translatedSpecial)),
    );

    const result = await provider.translate(special, "fr", SYSTEM_PROMPT);
    expect(result.html).toBe("<b>Gras</b>");
    expect(result.template).toBe("Bonjour {name}, vous avez {count} messages");
    expect(result.emoji).toBe("Bienvenue 🎉");
  });

  test("reads anthropic-ratelimit headers and throttles subsequent requests", async () => {
    const delayFn = jest
      .fn<(ms: number) => Promise<void>>()
      .mockResolvedValue(undefined);
    const throttlingProvider = new AnthropicProvider(ANTHROPIC_CONFIG, delayFn);

    // First response: 3 requests remaining, window resets in 20 s
    const resetAt = new Date(Date.now() + 20_000).toISOString();
    mockAnthropicCreate
      .mockReturnValueOnce(
        anthropicApiResponse(JSON.stringify(TRANSLATED_FR), {
          "anthropic-ratelimit-requests-remaining": "3",
          "anthropic-ratelimit-requests-reset": resetAt,
        }),
      )
      .mockReturnValueOnce(anthropicApiResponse(JSON.stringify(TRANSLATED_FR)));

    await throttlingProvider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    // Second call: rate limiter should compute a delay ≥ MIN_THROTTLE_MS (200 ms)
    await throttlingProvider.translate(SOURCE_KEYS, "de", SYSTEM_PROMPT);

    expect(delayFn).toHaveBeenCalled();
    const [delayMs] = delayFn.mock.calls[0] as [number];
    expect(delayMs).toBeGreaterThanOrEqual(200);
  });
});
