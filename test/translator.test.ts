import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as jsonUtils from "../src/json-utils";
import type { TranslatorConfig } from "../src/config";

// Mock provider that returns predictable translations
const mockTranslate = jest.fn(
  async (
    keys: Record<string, string>,
    locale: string,
  ): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(keys)) {
      result[key] = `[${locale}] ${value}`;
    }
    return result;
  },
);

const mockProvider = { translate: mockTranslate };

jest.unstable_mockModule("../src/providers/base", () => ({
  createProvider: () => Promise.resolve(mockProvider),
}));

// Import translate AFTER setting up mocks
const { translate } = await import("../src/translator");

// ─── helpers ──────────────────────────────────────────────────────────────────

function baseOptions(tmpDir: string) {
  return {
    batchSize: 20,
    concurrency: 2,
    cache: false,
    cacheDir: join(tmpDir, ".cache"),
    dryRun: false,
  };
}

function makeSingleFileConfig(
  tmpDir: string,
  overrides: Partial<TranslatorConfig> = {},
): TranslatorConfig {
  return {
    provider: { name: "openai", model: "gpt-4o" },
    prompt: { system: "Translate to {locale}" },
    input: { base: join(tmpDir, "en.json") },
    output: {
      dir: join(tmpDir, "out"),
      filename: "{locale}.json",
      merge: false,
    },
    locales: ["fr", "de"],
    options: baseOptions(tmpDir),
    ...overrides,
  } as TranslatorConfig;
}

function makeFolderConfig(
  tmpDir: string,
  overrides: Partial<TranslatorConfig> = {},
): TranslatorConfig {
  return {
    provider: { name: "openai", model: "gpt-4o" },
    prompt: { system: "Translate to {locale}" },
    input: { baseDir: join(tmpDir, "en") },
    output: {
      baseDir: join(tmpDir, "locales"),
      filename: "{locale}.json",
      merge: false,
    },
    locales: ["fr", "de"],
    options: baseOptions(tmpDir),
    ...overrides,
  } as TranslatorConfig;
}

// ─── single-file mode ─────────────────────────────────────────────────────────

describe("translate – single-file mode", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `translator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mockTranslate.mockClear();
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes locale files for each locale", async () => {
    const inputFile = join(tmpDir, "en.json");
    const config = makeSingleFileConfig(tmpDir, {
      input: { base: inputFile },
      output: {
        dir: join(tmpDir, "out"),
        filename: "{locale}.json",
        merge: false,
      },
    });
    await jsonUtils.writeJsonFile(inputFile, {
      greeting: "Hello",
      farewell: "Goodbye",
    });

    const results = await translate(config);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.locale).sort()).toEqual(["de", "fr"]);

    for (const result of results) {
      expect(existsSync(result.outputPath)).toBe(true);
      const written = (await jsonUtils.readJsonFile(
        result.outputPath,
      )) as Record<string, string>;
      expect(written.greeting).toContain(result.locale);
    }
  });

  test("dry-run does not write files", async () => {
    const inputFile = join(tmpDir, "en.json");
    const config = makeSingleFileConfig(tmpDir, {
      input: { base: inputFile },
      output: {
        dir: join(tmpDir, "out"),
        filename: "{locale}.json",
        merge: false,
      },
      options: { ...baseOptions(tmpDir), dryRun: true },
    });
    await jsonUtils.writeJsonFile(inputFile, { hello: "Hello" });

    const results = await translate(config);

    expect(results.every((r) => r.dryRun)).toBe(true);
    for (const result of results) {
      expect(existsSync(result.outputPath)).toBe(false);
    }
  });

  test("merge mode preserves existing keys not in source", async () => {
    const inputFile = join(tmpDir, "en.json");
    const outDir = join(tmpDir, "out");
    const config = makeSingleFileConfig(tmpDir, {
      input: { base: inputFile },
      output: { dir: outDir, filename: "{locale}.json", merge: true },
      locales: ["fr"],
    });
    await jsonUtils.writeJsonFile(inputFile, { greeting: "Hello" });
    await jsonUtils.writeJsonFile(join(outDir, "fr.json"), {
      extra_key: "Existing value",
    });

    const results = await translate(config);
    expect(results).toHaveLength(1);

    const written = (await jsonUtils.readJsonFile(
      results[0].outputPath,
    )) as Record<string, string>;
    expect(written.greeting).toContain("fr");
    expect(written.extra_key).toBe("Existing value");
  });

  test("returns correct keysTranslated and keysCached counts", async () => {
    const inputFile = join(tmpDir, "en.json");
    const config = makeSingleFileConfig(tmpDir, {
      input: { base: inputFile },
      output: {
        dir: join(tmpDir, "out"),
        filename: "{locale}.json",
        merge: false,
      },
      locales: ["fr"],
    });
    await jsonUtils.writeJsonFile(inputFile, { a: "A", b: "B", c: "C" });

    const results = await translate(config);

    expect(results[0].keysTranslated).toBe(3);
    expect(results[0].keysCached).toBe(0);
  });
});

// ─── folder mode ──────────────────────────────────────────────────────────────

describe("translate – folder mode", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `translator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mockTranslate.mockClear();
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("mirrors folder structure for each locale", async () => {
    const inputDir = join(tmpDir, "en");
    const outputBaseDir = join(tmpDir, "locales");
    const config = makeFolderConfig(tmpDir, {
      input: { baseDir: inputDir },
      output: {
        baseDir: outputBaseDir,
        filename: "{locale}.json",
        merge: false,
      },
      locales: ["fr"],
    });

    await jsonUtils.writeJsonFile(join(inputDir, "account.json"), {
      name: "Name",
      email: "Email",
    });
    await jsonUtils.writeJsonFile(join(inputDir, "home.json"), {
      title: "Home",
    });
    await jsonUtils.writeJsonFile(
      join(inputDir, "battles", "battle-create.json"),
      { create: "Create battle" },
    );

    const results = await translate(config);

    expect(results).toHaveLength(1);
    expect(results[0].locale).toBe("fr");
    expect(results[0].filesTranslated).toBe(3);

    // Each source file should appear under locales/fr/ mirroring the input tree
    const frAccount = (await jsonUtils.readJsonFile(
      join(outputBaseDir, "fr", "account.json"),
    )) as Record<string, string>;
    expect(frAccount.name).toContain("fr");

    const frHome = (await jsonUtils.readJsonFile(
      join(outputBaseDir, "fr", "home.json"),
    )) as Record<string, string>;
    expect(frHome.title).toContain("fr");

    const frBattle = (await jsonUtils.readJsonFile(
      join(outputBaseDir, "fr", "battles", "battle-create.json"),
    )) as Record<string, string>;
    expect(frBattle.create).toContain("fr");
  });

  test("produces one output folder per locale", async () => {
    const inputDir = join(tmpDir, "en");
    const outputBaseDir = join(tmpDir, "locales");
    const config = makeFolderConfig(tmpDir, {
      input: { baseDir: inputDir },
      output: {
        baseDir: outputBaseDir,
        filename: "{locale}.json",
        merge: false,
      },
      locales: ["fr", "de"],
    });

    await jsonUtils.writeJsonFile(join(inputDir, "shared.json"), { ok: "OK" });

    const results = await translate(config);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.locale).sort()).toEqual(["de", "fr"]);

    for (const result of results) {
      // outputPath should point to the locale directory
      expect(result.outputPath).toContain(result.locale);
      expect(existsSync(join(result.outputPath, "shared.json"))).toBe(true);
    }
  });

  test("folder dry-run does not write files", async () => {
    const inputDir = join(tmpDir, "en");
    const outputBaseDir = join(tmpDir, "locales");
    const config = makeFolderConfig(tmpDir, {
      input: { baseDir: inputDir },
      output: {
        baseDir: outputBaseDir,
        filename: "{locale}.json",
        merge: false,
      },
      locales: ["fr"],
      options: { ...baseOptions(tmpDir), dryRun: true },
    });

    await jsonUtils.writeJsonFile(join(inputDir, "account.json"), {
      hello: "Hello",
    });

    const results = await translate(config);

    expect(results[0].dryRun).toBe(true);
    expect(existsSync(join(outputBaseDir, "fr", "account.json"))).toBe(false);
  });

  test("folder merge mode preserves existing keys", async () => {
    const inputDir = join(tmpDir, "en");
    const outputBaseDir = join(tmpDir, "locales");
    const config = makeFolderConfig(tmpDir, {
      input: { baseDir: inputDir },
      output: {
        baseDir: outputBaseDir,
        filename: "{locale}.json",
        merge: true,
      },
      locales: ["fr"],
    });

    await jsonUtils.writeJsonFile(join(inputDir, "account.json"), {
      name: "Name",
    });
    // Pre-existing translation with an extra key
    await jsonUtils.writeJsonFile(join(outputBaseDir, "fr", "account.json"), {
      legacy: "Old value",
    });

    const results = await translate(config);
    expect(results).toHaveLength(1);

    const written = (await jsonUtils.readJsonFile(
      join(outputBaseDir, "fr", "account.json"),
    )) as Record<string, string>;
    expect(written.name).toContain("fr");
    expect(written.legacy).toBe("Old value");
  });

  test("returns keysTranslated summed across all files", async () => {
    const inputDir = join(tmpDir, "en");
    const outputBaseDir = join(tmpDir, "locales");
    const config = makeFolderConfig(tmpDir, {
      input: { baseDir: inputDir },
      output: {
        baseDir: outputBaseDir,
        filename: "{locale}.json",
        merge: false,
      },
      locales: ["fr"],
    });

    await jsonUtils.writeJsonFile(join(inputDir, "a.json"), { x: "X", y: "Y" });
    await jsonUtils.writeJsonFile(join(inputDir, "b.json"), { z: "Z" });

    const results = await translate(config);

    expect(results[0].keysTranslated).toBe(3);
    expect(results[0].filesTranslated).toBe(2);
  });
});
