import { describe, test, expect } from "@jest/globals";
import {
  collectStringLeaves,
  deepClone,
  getAtPath,
  setAtPath,
  pruneToSource,
} from "../src/tree";

describe("collectStringLeaves", () => {
  test("collects string leaves with dotted path keys including array indices", () => {
    const source = {
      home: {
        title: "Welcome",
        sections: [
          { title: "First", content: "A" },
          { title: "Second", content: "B" },
        ],
      },
    };
    const leaves = collectStringLeaves(source);
    expect(leaves.map((l) => l.pathKey).sort()).toEqual([
      "home.sections.0.content",
      "home.sections.0.title",
      "home.sections.1.content",
      "home.sections.1.title",
      "home.title",
    ]);
  });

  test("array of strings produces indexed paths", () => {
    const leaves = collectStringLeaves({ tags: ["a", "b", "c"] });
    expect(leaves.map((l) => [l.pathKey, l.value])).toEqual([
      ["tags.0", "a"],
      ["tags.1", "b"],
      ["tags.2", "c"],
    ]);
  });

  test("skips empty and whitespace-only strings", () => {
    const leaves = collectStringLeaves({
      a: "real",
      b: "",
      c: "   ",
      d: "\n\t",
    });
    expect(leaves.map((l) => l.pathKey)).toEqual(["a"]);
  });

  test("does not collect numbers, booleans, or null", () => {
    const leaves = collectStringLeaves({
      n: 1,
      b: true,
      z: null,
      s: "x",
    });
    expect(leaves.map((l) => l.pathKey)).toEqual(["s"]);
  });

  test("numeric-keyed object is walked like an object (keys preserved)", () => {
    const leaves = collectStringLeaves({ obj: { "0": "a", "1": "b" } });
    expect(leaves.map((l) => l.pathKey)).toEqual(["obj.0", "obj.1"]);
  });
});

describe("deepClone", () => {
  test("preserves arrays as arrays and objects as objects", () => {
    const source = {
      arr: ["a", { x: "y" }],
      numericKeyed: { "0": "z", "1": "w" },
    };
    const clone = deepClone(source);
    expect(Array.isArray(clone.arr)).toBe(true);
    expect(Array.isArray(clone.numericKeyed)).toBe(false);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    expect(clone.arr).not.toBe(source.arr);
  });

  test("preserves primitives verbatim", () => {
    const source = { n: 1, b: false, z: null, e: "" };
    expect(deepClone(source)).toEqual(source);
  });
});

describe("getAtPath / setAtPath", () => {
  test("reads and writes nested array+object paths", () => {
    const tree = { a: { b: [{ c: "old" }] } };
    expect(getAtPath(tree, ["a", "b", 0, "c"])).toBe("old");
    setAtPath(tree, ["a", "b", 0, "c"], "new");
    expect(tree.a.b[0].c).toBe("new");
  });

  test("getAtPath returns undefined for missing paths", () => {
    expect(getAtPath({ a: "x" }, ["a", "b"])).toBeUndefined();
    expect(getAtPath({ a: ["x"] }, ["a", "nope"])).toBeUndefined();
  });
});

describe("structure-preserving round-trip", () => {
  test("translating leaves preserves types and structure byte-identically except strings", () => {
    const source = {
      title: "Hello",
      count: 42,
      enabled: true,
      missing: null,
      empty: "",
      tags: ["one", "two"],
      sections: [
        { heading: "H1", body: "B1" },
        { heading: "H2", body: "B2", nested: [["deep"]] },
      ],
      numericKeyed: { "0": "zero", "1": "one" },
    };

    const clone = deepClone(source);
    for (const leaf of collectStringLeaves(source)) {
      setAtPath(clone, leaf.path, `[fr] ${leaf.value}`);
    }

    expect(clone).toEqual({
      title: "[fr] Hello",
      count: 42,
      enabled: true,
      missing: null,
      empty: "",
      tags: ["[fr] one", "[fr] two"],
      sections: [
        { heading: "[fr] H1", body: "[fr] B1" },
        { heading: "[fr] H2", body: "[fr] B2", nested: [["[fr] deep"]] },
      ],
      numericKeyed: { "0": "[fr] zero", "1": "[fr] one" },
    });
    expect(Array.isArray(clone.tags)).toBe(true);
    expect(Array.isArray(clone.numericKeyed)).toBe(false);
  });
});

describe("pruneToSource", () => {
  test("removes object keys not present in source", () => {
    const target = { a: "x", stale: "y", nested: { keep: "1", drop: "2" } };
    const source = { a: "x", nested: { keep: "1" } };
    const removed = pruneToSource(target, source);
    expect(target).toEqual({ a: "x", nested: { keep: "1" } });
    expect(removed).toBe(2);
  });

  test("trims extra array items", () => {
    const target = { list: ["a", "b", "c"] };
    const source = { list: ["a", "b"] };
    pruneToSource(target, source);
    expect(target.list).toEqual(["a", "b"]);
  });
});
