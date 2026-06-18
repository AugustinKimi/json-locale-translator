import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as jsonUtils from "../src/json-utils";
import type { TranslatorConfig } from "../src/config";

// ─── Configurable mock provider ────────────────────────────────────────────────
// Receives a { id: source } batch and returns { id: translated }. Default echoes
// "[locale] <source>"; individual tests override via translateImpl.

type Batch = Record<string, string>;
let translateImpl: (keys: Batch, locale: string) => Batch = (keys, locale) => {
  const out: Batch = {};
  for (const [id, value] of Object.entries(keys)) out[id] = `[${locale}] ${value}`;
  return out;
};

const mockTranslate = jest.fn(
  async (keys: Batch, locale: string): Promise<Batch> =>
    translateImpl(keys, locale),
);
const mockProvider = { translate: mockTranslate };

jest.unstable_mockModule("../src/providers/base", () => ({
  createProvider: () => Promise.resolve(mockProvider),
}));

const { translate } = await import("../src/translator");
const { adopt } = await import("../src/adopt");

// ─── helpers ──────────────────────────────────────────────────────────────────

function options(tmpDir: string, overrides: Record<string, unknown> = {}) {
  return {
    batchSize: 20,
    concurrency: 2,
    cache: true,
    cacheDir: join(tmpDir, ".cache"),
    dryRun: false,
    cacheKeying: "source" as const,
    prune: false,
    indent: 2,
    ...overrides,
  };
}

function singleFileConfig(
  tmpDir: string,
  overrides: Partial<TranslatorConfig> = {},
): TranslatorConfig {
  return {
    provider: { name: "openai", model: "gpt-4o" },
    prompt: { system: "Translate to {locale}" },
    input: { base: join(tmpDir, "en.json") },
    output: { dir: join(tmpDir, "out"), filename: "{locale}.json", merge: true },
    locales: ["fr"],
    options: options(tmpDir),
    ...overrides,
  } as TranslatorConfig;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `features-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mockTranslate.mockClear();
  translateImpl = (keys, locale) => {
    const out: Batch = {};
    for (const [id, value] of Object.entries(keys)) out[id] = `[${locale}] ${value}`;
    return out;
  };
});

afterEach(async () => {
  if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
});

// ─── structure preservation ────────────────────────────────────────────────────

describe("structure preservation through translate", () => {
  test("arrays, nested arrays, objects, numerics and primitives round-trip", async () => {
    const input = join(tmpDir, "en.json");
    const config = singleFileConfig(tmpDir, {
      input: { base: input },
      output: { dir: join(tmpDir, "out"), filename: "{locale}.json", merge: false },
      options: options(tmpDir, { cache: false }),
    });
    await jsonUtils.writeJsonFile(input, {
      title: "Hello",
      count: 7,
      enabled: true,
      missing: null,
      empty: "",
      tags: ["one", "two"],
      sections: [
        { heading: "H1", body: "B1" },
        { heading: "H2", nested: [["deep"]] },
      ],
      numericKeyed: { "0": "zero", "1": "one" },
    });

    const [result] = await translate(config);
    const written = await jsonUtils.readJsonFile(result.outputPath);

    expect(written).toEqual({
      title: "[fr] Hello",
      count: 7,
      enabled: true,
      missing: null,
      empty: "",
      tags: ["[fr] one", "[fr] two"],
      sections: [
        { heading: "[fr] H1", body: "[fr] B1" },
        { heading: "[fr] H2", nested: [["[fr] deep"]] },
      ],
      numericKeyed: { "0": "[fr] zero", "1": "[fr] one" },
    });
    expect(Array.isArray(written.tags)).toBe(true);
    expect(Array.isArray((written as Record<string, unknown>).numericKeyed)).toBe(
      false,
    );
  });
});

// ─── trailing newline ───────────────────────────────────────────────────────────

describe("output formatting", () => {
  test("written files end in exactly one newline", async () => {
    const input = join(tmpDir, "en.json");
    const config = singleFileConfig(tmpDir, {
      input: { base: input },
      options: options(tmpDir, { cache: false }),
    });
    await jsonUtils.writeJsonFile(input, { a: "A" });

    const [result] = await translate(config);
    const raw = await readFile(result.outputPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
  });

  test("indent option controls spacing", async () => {
    const input = join(tmpDir, "en.json");
    const config = singleFileConfig(tmpDir, {
      input: { base: input },
      options: options(tmpDir, { cache: false, indent: 4 }),
    });
    await jsonUtils.writeJsonFile(input, { a: "A" });

    const [result] = await translate(config);
    const raw = await readFile(result.outputPath, "utf-8");
    expect(raw).toContain('\n    "a"');
  });
});

// ─── adopt ──────────────────────────────────────────────────────────────────────

describe("adopt", () => {
  test("seeds cache so a subsequent translate makes zero API calls", async () => {
    const input = join(tmpDir, "en.json");
    const outFr = join(tmpDir, "out", "fr.json");
    const config = singleFileConfig(tmpDir, { input: { base: input } });

    await jsonUtils.writeJsonFile(input, {
      greeting: "Hello",
      sections: [{ title: "About" }],
    });
    // Existing, already-translated target file.
    await jsonUtils.writeJsonFile(outFr, {
      greeting: "Bonjour",
      sections: [{ title: "À propos" }],
    });

    const adoptResults = await adopt(config);
    expect(adoptResults[0].seeded).toBe(2);
    expect(adoptResults[0].missing).toBe(0);

    const results = await translate(config);
    expect(mockTranslate).toHaveBeenCalledTimes(0);

    const written = await jsonUtils.readJsonFile(results[0].outputPath);
    expect(written).toEqual({
      greeting: "Bonjour",
      sections: [{ title: "À propos" }],
    });
    expect(results[0].keysCached).toBe(2);
  });

  test("reports missing source leaves and target-only orphans", async () => {
    const input = join(tmpDir, "en.json");
    const outFr = join(tmpDir, "out", "fr.json");
    const config = singleFileConfig(tmpDir, { input: { base: input } });

    await jsonUtils.writeJsonFile(input, { a: "A", b: "B", c: "C" });
    await jsonUtils.writeJsonFile(outFr, { a: "Atrad", orphan: "stale" });

    const [r] = await adopt(config);
    expect(r.seeded).toBe(1); // only "a" has a translation
    expect(r.missing).toBe(2); // b and c not yet translated
    expect(r.orphans).toBe(1); // "orphan" exists only in target
  });
});

// ─── path-aware cache keying ─────────────────────────────────────────────────────

describe("cacheKeying: 'path'", () => {
  test("same source string maps to different translations per path", async () => {
    const input = join(tmpDir, "en.json");
    const outFr = join(tmpDir, "out", "fr.json");
    const config = singleFileConfig(tmpDir, {
      input: { base: input },
      output: { dir: join(tmpDir, "out"), filename: "{locale}.json", merge: false },
      options: options(tmpDir, { cacheKeying: "path" }),
    });

    // Same English string "Open" in two places.
    await jsonUtils.writeJsonFile(input, {
      door: { label: "Open" },
      status: { label: "Open" },
    });
    // Existing translations differ by context.
    await jsonUtils.writeJsonFile(outFr, {
      door: { label: "Ouvrir" },
      status: { label: "Ouvert" },
    });

    await adopt(config);
    const results = await translate(config);
    expect(mockTranslate).toHaveBeenCalledTimes(0);

    const written = (await jsonUtils.readJsonFile(results[0].outputPath)) as {
      door: { label: string };
      status: { label: string };
    };
    expect(written.door.label).toBe("Ouvrir");
    expect(written.status.label).toBe("Ouvert");
  });
});

// ─── placeholder integrity ───────────────────────────────────────────────────────

describe("placeholder integrity", () => {
  test("mismatch is retried then original is kept with a warning", async () => {
    const input = join(tmpDir, "en.json");
    const config = singleFileConfig(tmpDir, {
      input: { base: input },
      output: { dir: join(tmpDir, "out"), filename: "{locale}.json", merge: false },
      options: options(tmpDir, { cache: false }),
    });
    await jsonUtils.writeJsonFile(input, { greet: "Hello {name}" });

    // Provider always drops the placeholder.
    translateImpl = (keys) => {
      const out: Batch = {};
      for (const id of Object.keys(keys)) out[id] = "Bonjour";
      return out;
    };

    const [result] = await translate(config);
    // First batch + one retry batch = 2 calls.
    expect(mockTranslate).toHaveBeenCalledTimes(2);
    expect(result.placeholderWarnings).toBe(1);

    const written = (await jsonUtils.readJsonFile(result.outputPath)) as {
      greet: string;
    };
    // Original kept because placeholders could not be preserved.
    expect(written.greet).toBe("Hello {name}");
  });

  test("matching placeholders pass through unchanged", async () => {
    const input = join(tmpDir, "en.json");
    const config = singleFileConfig(tmpDir, {
      input: { base: input },
      output: { dir: join(tmpDir, "out"), filename: "{locale}.json", merge: false },
      options: options(tmpDir, { cache: false }),
    });
    await jsonUtils.writeJsonFile(input, { greet: "Hi {name}" });

    translateImpl = (keys) => {
      const out: Batch = {};
      for (const id of Object.keys(keys)) out[id] = "Salut {name}";
      return out;
    };

    const [result] = await translate(config);
    expect(mockTranslate).toHaveBeenCalledTimes(1);
    expect(result.placeholderWarnings).toBe(0);
    const written = (await jsonUtils.readJsonFile(result.outputPath)) as {
      greet: string;
    };
    expect(written.greet).toBe("Salut {name}");
  });
});

// ─── prune ────────────────────────────────────────────────────────────────────────

describe("prune", () => {
  test("removes orphan target keys only when enabled", async () => {
    const input = join(tmpDir, "en.json");
    const outFr = join(tmpDir, "out", "fr.json");

    // Without prune: orphan preserved (merge default true).
    const noPrune = singleFileConfig(tmpDir, {
      input: { base: input },
      options: options(tmpDir, { cache: false }),
    });
    await jsonUtils.writeJsonFile(input, { a: "A" });
    await jsonUtils.writeJsonFile(outFr, { a: "old", orphan: "keep-me" });

    await translate(noPrune);
    let written = (await jsonUtils.readJsonFile(outFr)) as Record<string, unknown>;
    expect(written.orphan).toBe("keep-me");

    // With prune: orphan removed.
    const withPrune = singleFileConfig(tmpDir, {
      input: { base: input },
      options: options(tmpDir, { cache: false, prune: true }),
    });
    const [result] = await translate(withPrune);
    written = (await jsonUtils.readJsonFile(outFr)) as Record<string, unknown>;
    expect(written.orphan).toBeUndefined();
    expect(written.a).toBe("[fr] A");
    expect(result.prunedKeys).toBe(1);
  });
});
