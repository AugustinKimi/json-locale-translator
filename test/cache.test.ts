import { describe, test, expect, afterEach } from "@jest/globals";
import { existsSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCache, saveCache, cacheKeyFor } from "../src/cache";
import { writeJsonFile } from "../src/json-utils";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir && existsSync(tmpDir)) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

function freshDir() {
  tmpDir = join(
    tmpdir(),
    `cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return tmpDir;
}

describe("cacheKeyFor", () => {
  test("source keying uses the source string", () => {
    expect(cacheKeyFor("source", "Hello", "home.json", "a.b")).toBe("Hello");
  });
  test("path keying uses relFile#path", () => {
    expect(cacheKeyFor("path", "Hello", "home.json", "a.b")).toBe(
      "home.json#a.b",
    );
  });
});

describe("save / load round-trip", () => {
  test("writes human-readable _model + entries and reads it back", async () => {
    const dir = freshDir();
    await saveCache(dir, "fr", "gpt-4o", { Hello: "Bonjour" });

    const onDisk = JSON.parse(
      await readFile(join(dir, "fr.json"), "utf-8"),
    ) as { _model: string; entries: Record<string, string> };
    expect(onDisk._model).toBe("gpt-4o");
    expect(onDisk.entries).toEqual({ Hello: "Bonjour" });

    const loaded = await loadCache(dir, "fr", "gpt-4o");
    expect(loaded.entries).toEqual({ Hello: "Bonjour" });
    expect(loaded.legacy).toBe(false);
    expect(loaded.modelChanged).toBe(false);
  });

  test("missing cache file → empty entries", async () => {
    const dir = freshDir();
    const loaded = await loadCache(dir, "de", "gpt-4o");
    expect(loaded.entries).toEqual({});
    expect(loaded.legacy).toBe(false);
  });
});

describe("model invalidation", () => {
  test("different _model invalidates entries", async () => {
    const dir = freshDir();
    await saveCache(dir, "fr", "gpt-4o", { Hello: "Bonjour" });
    const loaded = await loadCache(dir, "fr", "claude-3-5-sonnet");
    expect(loaded.entries).toEqual({});
    expect(loaded.modelChanged).toBe(true);
  });
});

describe("legacy format detection", () => {
  test("old hash→string format is detected and ignored", async () => {
    const dir = freshDir();
    // Legacy shape: opaque sha256 → translation, no _model/entries.
    await writeJsonFile(join(dir, "fr.json"), {
      a1b2c3: "Bonjour",
      d4e5f6: "Au revoir",
    });
    const loaded = await loadCache(dir, "fr", "gpt-4o");
    expect(loaded.entries).toEqual({});
    expect(loaded.legacy).toBe(true);
  });
});
