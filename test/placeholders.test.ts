import { describe, test, expect } from "@jest/globals";
import {
  extractPlaceholders,
  placeholdersMatch,
  DEFAULT_PLACEHOLDER_PATTERNS,
} from "../src/placeholders";

describe("extractPlaceholders", () => {
  test("detects double-brace, single-brace, printf and tag tokens", () => {
    expect(extractPlaceholders("Hi {{name}}, you have {count} new %s <bold>!</bold>"))
      .toEqual(["{{name}}", "{count}", "%s", "<bold>", "</bold>"]);
  });

  test("printf positional tokens", () => {
    expect(extractPlaceholders("%1$s and %2$d")).toEqual(["%1$s", "%2$d"]);
  });

  test("plain percent sign is not a placeholder", () => {
    expect(extractPlaceholders("100% done")).toEqual([]);
  });
});

describe("placeholdersMatch", () => {
  test("matches identical placeholders regardless of surrounding text/order", () => {
    expect(
      placeholdersMatch("Hello {name}, {count} items", "{count} éléments, bonjour {name}"),
    ).toBe(true);
  });

  test("fails when a placeholder is dropped", () => {
    expect(placeholdersMatch("Hi {{name}}", "Bonjour")).toBe(false);
  });

  test("fails when a placeholder name is changed", () => {
    expect(placeholdersMatch("Hi {{name}}", "Bonjour {{nom}}")).toBe(false);
  });

  test("fails when count differs", () => {
    expect(placeholdersMatch("{a} {a}", "{a}")).toBe(false);
  });

  test("matches when no placeholders are present", () => {
    expect(placeholdersMatch("Hello", "Bonjour")).toBe(true);
  });

  test("matches tag markers", () => {
    expect(
      placeholdersMatch("<bold>Hi</bold>", "<bold>Salut</bold>"),
    ).toBe(true);
  });

  test("honours custom patterns", () => {
    // Only treat :tokens: as placeholders.
    const patterns = [":[a-z]+:"];
    expect(placeholdersMatch("hi :name:", "salut :name:", patterns)).toBe(true);
    expect(placeholdersMatch("hi {name}", "salut", patterns)).toBe(true);
  });

  test("default patterns are exported and usable", () => {
    expect(DEFAULT_PLACEHOLDER_PATTERNS.length).toBeGreaterThan(0);
  });
});
