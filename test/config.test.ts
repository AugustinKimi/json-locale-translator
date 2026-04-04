import { defineConfig, ConfigSchema } from "../src/config";

describe("defineConfig", () => {
  test("returns config as-is", () => {
    const config = {
      provider: { name: "openai" as const, model: "gpt-4o" },
      prompt: { system: "Translate to {locale}" },
      input: { base: "./locales/en.json" },
      output: { dir: "./locales" },
      locales: ["fr", "de"],
    };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("ConfigSchema", () => {
  const validConfig = {
    provider: {
      name: "anthropic" as const,
      model: "claude-3-5-sonnet-20241022",
    },
    prompt: { system: "Translate to {locale}" },
    input: { base: "./locales/en.json" },
    output: { dir: "./locales" },
    locales: ["fr"],
  };

  const validFolderConfig = {
    provider: {
      name: "anthropic" as const,
      model: "claude-3-5-sonnet-20241022",
    },
    prompt: { system: "Translate to {locale}" },
    input: { baseDir: "./locales/en" },
    output: { baseDir: "./locales" },
    locales: ["fr"],
  };

  // ── single-file mode ──────────────────────────────────────────────────────

  test("validates a correct single-file config", () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.provider.name).toBe("anthropic");
    expect(result.locales).toEqual(["fr"]);
    expect(result.input.base).toBe("./locales/en.json");
  });

  test("applies default values for optional fields", () => {
    const result = ConfigSchema.parse(validConfig);
    expect(result.output.filename).toBe("{locale}.json");
    expect(result.output.merge).toBe(true);
    expect(result.options.batchSize).toBe(20);
    expect(result.options.concurrency).toBe(3);
    expect(result.options.cache).toBe(true);
    expect(result.options.cacheDir).toBe(".translator-cache");
    expect(result.options.dryRun).toBe(false);
  });

  test("throws on missing required fields", () => {
    expect(() => ConfigSchema.parse({})).toThrow();
  });

  test("throws if locales is empty array", () => {
    expect(() => ConfigSchema.parse({ ...validConfig, locales: [] })).toThrow();
  });

  test("throws on invalid provider name", () => {
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        provider: { name: "unknown", model: "x" },
      }),
    ).toThrow();
  });

  test("accepts optional apiKey and baseURL", () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      provider: {
        name: "openai" as const,
        model: "gpt-4o",
        apiKey: "sk-test",
        baseURL: "https://proxy",
      },
    });
    expect(result.provider.apiKey).toBe("sk-test");
    expect(result.provider.baseURL).toBe("https://proxy");
  });

  test("accepts prompt overrides", () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      prompt: {
        system: "Translate to {locale}",
        overrides: { fr: "Use formal tone." },
      },
    });
    expect(result.prompt.overrides?.fr).toBe("Use formal tone.");
  });

  // ── folder mode ───────────────────────────────────────────────────────────

  test("validates a correct folder-mode config", () => {
    const result = ConfigSchema.parse(validFolderConfig);
    expect(result.input.baseDir).toBe("./locales/en");
    expect(result.output.baseDir).toBe("./locales");
    expect(result.input.base).toBeUndefined();
    expect(result.output.dir).toBeUndefined();
  });

  test("folder mode applies same defaults as single-file mode", () => {
    const result = ConfigSchema.parse(validFolderConfig);
    expect(result.output.merge).toBe(true);
    expect(result.options.batchSize).toBe(20);
    expect(result.options.cache).toBe(true);
  });

  // ── validation: at least one input/output field required ─────────────────

  test("throws when neither input.base nor input.baseDir is set", () => {
    expect(() => ConfigSchema.parse({ ...validConfig, input: {} })).toThrow();
  });

  test("throws when neither output.dir nor output.baseDir is set", () => {
    expect(() => ConfigSchema.parse({ ...validConfig, output: {} })).toThrow();
  });

  test("accepts input with both base and baseDir (baseDir takes precedence at runtime)", () => {
    // Schema should not reject having both; runtime picks the right mode
    expect(() =>
      ConfigSchema.parse({
        ...validConfig,
        input: { base: "./en.json", baseDir: "./en" },
      }),
    ).not.toThrow();
  });
});
