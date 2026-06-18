/**
 * Interpolation-token (placeholder) integrity checking.
 *
 * Translation models frequently mangle interpolation tokens — dropping them,
 * duplicating them, or translating the variable name. After each leaf is
 * translated we assert that the *multiset* of placeholders is identical between
 * the source and the translation.
 *
 * The default patterns cover the most common i18n token styles:
 *   - `{{name}}`            ICU / mustache double-brace
 *   - `{name}`             single-brace (ICU, .NET, python-style)
 *   - `%s` `%d` `%1$s`     printf-style
 *   - `<tag>` `</tag>`     markup markers (e.g. `<bold>…</bold>`)
 */

export const DEFAULT_PLACEHOLDER_PATTERNS: string[] = [
  "\\{\\{[^{}]+\\}\\}", // {{ name }}
  "\\{[^{}]+\\}", // { name }
  "%(?:\\d+\\$)?[sd]", // %s, %d, %1$s
  "</?[A-Za-z][^>]*>", // <tag>, </tag>, <bold>
];

function buildRegex(patterns: string[]): RegExp {
  // Alternation order matters: more-specific patterns (e.g. `{{…}}`) must come
  // before more-general ones (`{…}`) so the longer token wins at each position.
  return new RegExp(patterns.map((p) => `(?:${p})`).join("|"), "g");
}

/** Extract every placeholder token from `text` (in order, with duplicates). */
export function extractPlaceholders(
  text: string,
  patterns: string[] = DEFAULT_PLACEHOLDER_PATTERNS,
): string[] {
  const re = buildRegex(patterns);
  const found: string[] = [];
  for (const match of text.matchAll(re)) {
    found.push(match[0]);
  }
  return found;
}

/**
 * Return `true` when `source` and `translation` contain the same multiset of
 * placeholder tokens (same tokens, same counts; order is irrelevant).
 */
export function placeholdersMatch(
  source: string,
  translation: string,
  patterns: string[] = DEFAULT_PLACEHOLDER_PATTERNS,
): boolean {
  const a = extractPlaceholders(source, patterns);
  const b = extractPlaceholders(translation, patterns);
  if (a.length !== b.length) return false;

  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of b) {
    const remaining = counts.get(token);
    if (!remaining) return false;
    counts.set(token, remaining - 1);
  }
  for (const remaining of counts.values()) {
    if (remaining !== 0) return false;
  }
  return true;
}
