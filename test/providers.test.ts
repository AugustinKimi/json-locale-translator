import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// ─── SDK mocks (must come before importing the providers) ─────────────────────

const mockOpenAICreate = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule("openai", () => ({
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

const mockAnthropicCreate = jest.fn<() => Promise<unknown>>();
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

/** Build a realistic OpenAI chat completion response object. */
function openaiReply(content: string) {
  return { choices: [{ message: { content } }] };
}

/** Build a realistic Anthropic messages response object. */
function anthropicReply(text: string) {
  return { content: [{ type: "text", text }] };
}

// ─── OpenAI provider ──────────────────────────────────────────────────────────

describe("OpenAIProvider", () => {
  let provider: InstanceType<typeof OpenAIProvider>;

  beforeEach(() => {
    provider = new OpenAIProvider(OPENAI_CONFIG);
    mockOpenAICreate.mockReset();
  });

  test("happy path — clean JSON response is parsed and returned", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      openaiReply(JSON.stringify(TRANSLATED_FR)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in ```json … ``` code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockOpenAICreate.mockResolvedValueOnce(openaiReply(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in plain ``` … ``` code fence", async () => {
    const fenced = "```\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockOpenAICreate.mockResolvedValueOnce(openaiReply(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles response with surrounding whitespace / newlines", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      openaiReply("\n\n  " + JSON.stringify(TRANSLATED_FR) + "  \n"),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("retry — first response is invalid JSON, second is valid", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(openaiReply("Sorry, I cannot translate that."))
      .mockResolvedValueOnce(openaiReply(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
  });

  test("throws after two consecutive invalid JSON responses", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(openaiReply("not json at all"))
      .mockResolvedValueOnce(openaiReply("still not json"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/not valid JSON after retry/);
  });

  test("throws when API call fails on first attempt", async () => {
    mockOpenAICreate.mockRejectedValueOnce(new Error("network timeout"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/OpenAI API call failed/);
  });

  test("throws when retry API call also fails", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(openaiReply("not json"))
      .mockRejectedValueOnce(new Error("rate limited"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/OpenAI API call failed on retry/);
  });

  test("throws on empty response content", async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    });

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Empty response/);
  });

  test("missing key in response — falls back to original value", async () => {
    // Response is missing 'question'
    const partial = { greeting: "Bonjour", farewell: "Au revoir" };
    mockOpenAICreate.mockResolvedValueOnce(
      openaiReply(JSON.stringify(partial)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result.greeting).toBe("Bonjour");
    expect(result.farewell).toBe("Au revoir");
    expect(result.question).toBe(SOURCE_KEYS.question); // original kept
  });

  test("large batch — all keys translated correctly", async () => {
    const largeKeys: Record<string, string> = {};
    const largeTranslated: Record<string, string> = {};
    for (let i = 0; i < 80; i++) {
      largeKeys[`key_${i}`] = `English value ${i}`;
      largeTranslated[`key_${i}`] = `French value ${i}`;
    }
    mockOpenAICreate.mockResolvedValueOnce(
      openaiReply(JSON.stringify(largeTranslated)),
    );

    const result = await provider.translate(largeKeys, "fr", SYSTEM_PROMPT);
    expect(Object.keys(result)).toHaveLength(80);
    expect(result.key_0).toBe("French value 0");
    expect(result.key_79).toBe("French value 79");
  });

  test("preserves nested-looking keys (dot-notation flat keys)", async () => {
    const flat = { "nav.home": "Home", "nav.about": "About" };
    const translated = { "nav.home": "Accueil", "nav.about": "À propos" };
    mockOpenAICreate.mockResolvedValueOnce(
      openaiReply(JSON.stringify(translated)),
    );

    const result = await provider.translate(flat, "fr", SYSTEM_PROMPT);
    expect(result["nav.home"]).toBe("Accueil");
    expect(result["nav.about"]).toBe("À propos");
  });
});

// ─── Anthropic provider ───────────────────────────────────────────────────────

describe("AnthropicProvider", () => {
  let provider: InstanceType<typeof AnthropicProvider>;

  beforeEach(() => {
    provider = new AnthropicProvider(ANTHROPIC_CONFIG);
    mockAnthropicCreate.mockReset();
  });

  test("happy path — clean JSON response is parsed and returned", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicReply(JSON.stringify(TRANSLATED_FR)),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in ```json … ``` code fence", async () => {
    const fenced = "```json\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockAnthropicCreate.mockResolvedValueOnce(anthropicReply(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles JSON wrapped in plain ``` … ``` code fence", async () => {
    const fenced = "```\n" + JSON.stringify(TRANSLATED_FR) + "\n```";
    mockAnthropicCreate.mockResolvedValueOnce(anthropicReply(fenced));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("handles response with surrounding whitespace / newlines", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicReply("\n  " + JSON.stringify(TRANSLATED_FR) + "  \n"),
    );

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
  });

  test("retry — first response is invalid JSON, second is valid", async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce(anthropicReply("I cannot do that."))
      .mockResolvedValueOnce(anthropicReply(JSON.stringify(TRANSLATED_FR)));

    const result = await provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT);
    expect(result).toEqual(TRANSLATED_FR);
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2);
  });

  test("throws after two consecutive invalid JSON responses", async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce(anthropicReply("not json"))
      .mockResolvedValueOnce(anthropicReply("also not json"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/not valid JSON after retry/);
  });

  test("throws when API call fails on first attempt", async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error("overloaded"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Anthropic API call failed/);
  });

  test("throws when retry API call also fails", async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce(anthropicReply("not json"))
      .mockRejectedValueOnce(new Error("overloaded"));

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Anthropic API call failed on retry/);
  });

  test("throws when response content block is not text type", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    });

    await expect(
      provider.translate(SOURCE_KEYS, "fr", SYSTEM_PROMPT),
    ).rejects.toThrow(/Unexpected response content type/);
  });

  test("missing key in response — falls back to original value", async () => {
    const partial = { greeting: "Bonjour", farewell: "Au revoir" };
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicReply(JSON.stringify(partial)),
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
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicReply(JSON.stringify(largeTranslated)),
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
    mockAnthropicCreate.mockResolvedValueOnce(
      anthropicReply(JSON.stringify(translatedSpecial)),
    );

    const result = await provider.translate(special, "fr", SYSTEM_PROMPT);
    expect(result.html).toBe("<b>Gras</b>");
    expect(result.template).toBe("Bonjour {name}, vous avez {count} messages");
    expect(result.emoji).toBe("Bienvenue 🎉");
  });
});
