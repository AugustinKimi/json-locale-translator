# Changelog

All notable changes to this project are documented here.

## 0.3.0

### ⚠️ Breaking: cache format changed

The translation cache moved from an opaque `{ <sha256>: translation }` map to a
human-readable, diffable format:

```json
{
  "_model": "gpt-4o",
  "entries": { "<source string or path>": "<translation>" }
}
```

The legacy hash-based cache **cannot be migrated losslessly** (it never stored
the source strings). On the first run, a legacy cache file is detected, ignored,
and a notice is printed. **Run `json-translate adopt` once** to rebuild the cache
from your existing translated files — no re-translation, no API cost. The whole
cache is also invalidated automatically when the configured model changes.

### Added

- **Structure preservation.** The flatten/unflatten model has been replaced with
  a structure-preserving tree walk. Arrays of strings, arrays of objects, nested
  arrays, and numeric-keyed objects (`{"0":…}`) now round-trip correctly.
  Numbers, booleans, `null`, and empty/whitespace-only strings are preserved
  verbatim and never sent to the API.
- **`adopt` command / `adopt()` function.** Seed the cache from existing
  translated locale files so a later `translate` only hits the API for new or
  changed strings. Reports per locale: entries seeded, untranslated source
  leaves, and target-only orphans.
- **Placeholder integrity check.** After each leaf is translated, the multiset of
  interpolation tokens (`{{name}}`, `{name}`, `%s`/`%d`/`%1$s`, `<tag>`) must
  match between source and translation. On mismatch the leaf is retried once;
  if it still fails the original value is kept, a `[warn]` is emitted, and it is
  counted in the run summary. Configurable via `options.placeholderPatterns`.
- **`options.cacheKeying: 'source' | 'path'`** (default `'source'`). `'path'`
  keys cache entries by `<relFile>#<path>` so the same source string can have
  different, context-specific translations in different places.
- **`options.prune` / `--prune`** (default `false`). Removes target keys (and
  stale cache entries) that no longer exist in the source.
- **`options.indent`** (default `2`). Controls written-JSON indentation.

### Changed

- Output files end in exactly one trailing newline (already the case; now
  covered by tests and the configurable `indent`).
- All existing `translator.config.{ts,js,json}` files keep working — every new
  option is additive with a safe default.
