import { describe, test, expect, afterEach } from "@jest/globals";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  flattenJson,
  unflattenJson,
  mergeJson,
  walkJsonFiles,
  writeJsonFile,
} from "../src/json-utils";

describe("flattenJson", () => {
  test("correctly flattens nested objects", () => {
    const input = {
      a: {
        b: "hello",
        c: {
          d: "world",
        },
      },
      e: "top",
    };
    expect(flattenJson(input)).toEqual({
      "a.b": "hello",
      "a.c.d": "world",
      e: "top",
    });
  });

  test("skips non-string values", () => {
    const input = {
      name: "Alice",
      age: 30,
      active: true,
      tags: ["a", "b"],
      extra: null,
    };
    expect(flattenJson(input as Record<string, unknown>)).toEqual({
      name: "Alice",
    });
  });

  test("handles empty object", () => {
    expect(flattenJson({})).toEqual({});
  });

  test("uses prefix when provided", () => {
    expect(flattenJson({ x: "val" }, "pre")).toEqual({ "pre.x": "val" });
  });
});

describe("unflattenJson", () => {
  test("correctly restores nested structure", () => {
    const flat = {
      "a.b": "hello",
      "a.c.d": "world",
      e: "top",
    };
    expect(unflattenJson(flat)).toEqual({
      a: {
        b: "hello",
        c: {
          d: "world",
        },
      },
      e: "top",
    });
  });

  test("handles empty flat object", () => {
    expect(unflattenJson({})).toEqual({});
  });
});

describe("flattenJson → unflattenJson round-trip", () => {
  test("is lossless for string-only nested objects", () => {
    const original = {
      greeting: {
        hello: "Hello",
        bye: "Goodbye",
      },
      common: {
        yes: "Yes",
        no: "No",
        nested: {
          deep: "Deep value",
        },
      },
    };
    const flat = flattenJson(original);
    const restored = unflattenJson(flat);
    expect(restored).toEqual(original);
  });
});

describe("mergeJson", () => {
  test("translated values win over existing", () => {
    const existing = { a: "old", b: "keep" };
    const translated = { a: "new" };
    expect(mergeJson(existing, translated)).toEqual({ a: "new", b: "keep" });
  });

  test("deep merges nested objects", () => {
    const existing = { level1: { a: "old", b: "keep" } };
    const translated = { level1: { a: "new" } };
    expect(mergeJson(existing, translated)).toEqual({
      level1: { a: "new", b: "keep" },
    });
  });

  test("preserves existing keys not in translated", () => {
    const existing = { x: "exists", y: "also exists" };
    const translated = { x: "translated" };
    const result = mergeJson(existing, translated);
    expect(result.y).toBe("also exists");
  });
});

describe("walkJsonFiles", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns relative paths of all .json files", async () => {
    tmpDir = join(tmpdir(), `walk-test-${Date.now()}`);
    await writeJsonFile(join(tmpDir, "a.json"), {});
    await writeJsonFile(join(tmpDir, "b.json"), {});

    const files = await walkJsonFiles(tmpDir);
    expect(files.sort()).toEqual(["a.json", "b.json"]);
  });

  test("recurses into subdirectories and preserves relative path", async () => {
    tmpDir = join(tmpdir(), `walk-test-${Date.now()}`);
    await writeJsonFile(join(tmpDir, "home.json"), {});
    await writeJsonFile(join(tmpDir, "battles", "create.json"), {});
    await writeJsonFile(join(tmpDir, "battles", "live.json"), {});

    const files = await walkJsonFiles(tmpDir);
    expect(files.sort()).toEqual([
      join("battles", "create.json"),
      join("battles", "live.json"),
      "home.json",
    ]);
  });

  test("ignores non-.json files", async () => {
    tmpDir = join(tmpdir(), `walk-test-${Date.now()}`);
    await writeJsonFile(join(tmpDir, "data.json"), {});
    // Create a non-json file manually
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, "readme.md"), "hello");

    const files = await walkJsonFiles(tmpDir);
    expect(files).toEqual(["data.json"]);
  });

  test("returns empty array for empty directory", async () => {
    tmpDir = join(tmpdir(), `walk-test-${Date.now()}`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });

    const files = await walkJsonFiles(tmpDir);
    expect(files).toEqual([]);
  });

  test("trailing slash on root dir does not corrupt relative paths", async () => {
    // Regression: baseDir passed with trailing slash caused first char of each
    // filename to be stripped when using string slicing (fixed by path.relative)
    tmpDir = join(tmpdir(), `walk-test-${Date.now()}`);
    await writeJsonFile(join(tmpDir, "affiliations.json"), {});
    await writeJsonFile(join(tmpDir, "battles", "battleLive.json"), {});

    const dirWithSlash = tmpDir + "/";
    const files = await walkJsonFiles(dirWithSlash);
    expect(files.sort()).toEqual([
      "affiliations.json",
      join("battles", "battleLive.json"),
    ]);
  });
});
