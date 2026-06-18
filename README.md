# jsonai-translator

Translate JSON locale files into multiple languages using AI (Anthropic Claude or OpenAI GPT).  
Works as a **CLI tool** and as a **Node.js library**.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
  - [Single-file mode](#single-file-mode)
  - [Folder mode](#folder-mode)
- [Config Reference](#config-reference)
- [Modes in Depth](#modes-in-depth)
  - [Single-file mode](#single-file-mode-1)
  - [Folder mode](#folder-mode-1)
- [CLI Usage](#cli-usage)
- [Providers](#providers)
- [Prompt Customisation](#prompt-customisation)
- [Caching](#caching)
- [Migrating an existing i18n project](#migrating-an-existing-i18n-project)
- [Structure Preservation](#structure-preservation)
- [Placeholder Integrity](#placeholder-integrity)
- [Prune](#prune)
- [Merge Mode](#merge-mode)
- [Dry Run](#dry-run)
- [Programmatic Usage](#programmatic-usage)
- [TypeScript Config](#typescript-config)

---

## Install

```bash
npm install jsonai-translator
```

Install your preferred AI provider as a peer dependency:

```bash
# Anthropic Claude
npm install @anthropic-ai/sdk

# OpenAI GPT
npm install openai
```

---

## Quick Start

### Single-file mode

Translate one JSON file (e.g. `en.json`) into multiple locale files.

```ts
// translator.config.ts
import { defineConfig } from "jsonai-translator";

export default defineConfig({
  provider: {
    name: "openai",
    model: "gpt-4o",
    // apiKey: 'sk-…'  — or set OPENAI_API_KEY env var
  },
  prompt: {
    system: "You are a professional translator. Translate to {locale}.",
  },
  input: {
    base: "./locales/en.json",
  },
  output: {
    dir: "./locales",
    filename: "{locale}.json", // default
  },
  locales: ["fr", "de", "ja"],
});
```

```bash
npx json-translate
```

Given `locales/en.json`, this produces `locales/fr.json`, `locales/de.json`, `locales/ja.json`.

---

### Folder mode

Translate an entire locale directory tree, preserving all sub-folders and file names.

```ts
// translator.config.ts
import { defineConfig } from "jsonai-translator";

export default defineConfig({
  provider: {
    name: "anthropic",
    model: "claude-3-5-sonnet-20241022",
  },
  prompt: {
    system: "You are a professional translator. Translate to {locale}.",
  },
  input: {
    baseDir: "./locales/en", // source locale folder
  },
  output: {
    baseDir: "./locales", // target root — one sub-folder per locale is created
  },
  locales: ["fr", "de", "ja"],
});
```

```bash
npx json-translate
```

**Example — input tree:**

```
locales/
  en/
    home.json
    account/
      profile.json
      settings.json
```

**Output tree (one folder per locale, identical structure):**

```
locales/
  fr/
    home.json
    account/
      profile.json
      settings.json
  de/
    …
  ja/
    …
```

---

## Config Reference

### `provider`

| Field     | Type                      | Required | Description                                                            |
| --------- | ------------------------- | -------- | ---------------------------------------------------------------------- |
| `name`    | `'anthropic' \| 'openai'` | ✓        | AI provider to use                                                     |
| `model`   | `string`                  | ✓        | Model identifier (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`)         |
| `apiKey`  | `string`                  | —        | API key — falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` env var |
| `baseURL` | `string`                  | —        | Custom base URL (proxies, local models via OpenAI-compatible APIs)     |

### `prompt`

| Field       | Type                     | Required | Description                                                             |
| ----------- | ------------------------ | -------- | ----------------------------------------------------------------------- |
| `system`    | `string`                 | ✓        | System prompt. `{locale}` is replaced with the target locale at runtime |
| `overrides` | `Record<string, string>` | —        | Extra instructions appended to the system prompt for a specific locale  |

### `input` — pick one

| Field     | Type     | Description                                          |
| --------- | -------- | ---------------------------------------------------- |
| `base`    | `string` | Path to a single source JSON file (single-file mode) |
| `baseDir` | `string` | Path to a source locale directory (folder mode)      |

At least one of `base` or `baseDir` must be set.

### `output` — pick one

| Field      | Type      | Default         | Description                                                                           |
| ---------- | --------- | --------------- | ------------------------------------------------------------------------------------- |
| `dir`      | `string`  | —               | Output directory for single-file mode                                                 |
| `baseDir`  | `string`  | —               | Output root directory for folder mode. Each locale gets a sub-folder                  |
| `filename` | `string`  | `{locale}.json` | Output file name template (single-file mode). `{locale}` is replaced                  |
| `merge`    | `boolean` | `true`          | When `true`, translated keys are merged into the existing file instead of overwriting |

At least one of `dir` or `baseDir` must be set.

### `locales`

`string[]` — required, must be non-empty. List of target locale codes (e.g. `['fr', 'de', 'ja']`).

### `options`

| Field         | Type      | Default             | Description                                               |
| ------------- | --------- | ------------------- | --------------------------------------------------------- |
| `batchSize`           | `number`              | `20`                | Number of keys sent per API request (1–100)                                                          |
| `concurrency`         | `number`              | `3`                 | Maximum parallel locale tasks (1–10)                                                                 |
| `cache`               | `boolean`             | `true`              | Cache translations to avoid re-translating unchanged keys                                            |
| `cacheDir`            | `string`              | `.translator-cache` | Directory where cache files are stored                                                               |
| `cacheKeying`         | `'source' \| 'path'`  | `'source'`          | `'source'` dedupes identical strings app-wide; `'path'` keys by `<relFile>#<path>` for context-specific translations |
| `prune`               | `boolean`             | `false`             | Remove target keys (and stale cache entries) no longer present in the source                         |
| `indent`              | `number`              | `2`                 | Indentation width for written JSON files (files always end in one `\n`)                              |
| `placeholderPatterns` | `string[]`            | _(sensible defaults)_ | Regex strings for interpolation tokens that must round-trip unchanged                              |
| `dryRun`              | `boolean`             | `false`             | Preview what would be written without touching any files                                             |

---

## Modes in Depth

### Single-file mode

Set `input.base` to a single JSON file. For each locale, one output file is produced in `output.dir` named according to `output.filename` (default: `{locale}.json`).

```
locales/en.json  →  locales/fr.json, locales/de.json, …
```

Nested JSON, arrays (including arrays of objects), and non-string values are fully supported — see [Structure Preservation](#structure-preservation). Only string leaves are translated; everything else round-trips untouched.

### Folder mode

Set `input.baseDir` to the directory of your source locale. Every `.json` file inside that directory (recursively) is translated and written under `output.baseDir/{locale}/`, mirroring the exact same relative path.

- Sub-directories are created automatically.
- Caching works the same way — entries are shared per locale across files (see [Cache keying](#cache-keying)), so unchanged strings are skipped across subsequent runs.
- `output.merge: true` works per file — existing translated files are merged individually.

---

## CLI Usage

```
npx json-translate [command] [options]
```

| Command   | Description                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------- |
| (default) | Translate the configured source into the target locales                                             |
| `adopt`   | Seed the cache from existing translated files (no API calls) — see [Migrating an existing i18n project](#migrating-an-existing-i18n-project) |

| Option            | Description                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `--config <path>` | Path to a config file. Defaults to auto-detecting `translator.config.ts / .js / .json` in the current directory |
| `--locale <list>` | Comma-separated locale list, overrides `locales` in config (e.g. `--locale fr,de`)                              |
| `--adopt`         | Run `adopt` instead of translating (same as the `adopt` command)                                                |
| `--prune`         | Remove target keys / cache entries no longer present in the source                                              |
| `--dry-run`       | Preview output paths and key counts without writing any files                                                   |
| `--help`          | Print usage                                                                                                     |
| `--version`       | Print package version                                                                                           |

**Examples:**

```bash
# Auto-detect config in current directory
npx json-translate

# Use a specific config
npx json-translate --config ./config/translator.config.ts

# Translate only French and German this run
npx json-translate --locale fr,de

# Preview what would happen
npx json-translate --dry-run
```

**Output format:**

```
✓ fr  →  ./locales/fr.json          (42 translated, 8 cached)
✓ de  →  ./locales/de.json          (42 translated, 8 cached)

# Folder mode adds a file count:
✓ fr  →  ./locales/fr               (97 translated, 15 cached, 5 files)
```

---

## Providers

### Anthropic Claude

```ts
provider: {
  name: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
}
```

The SDK reads `ANTHROPIC_API_KEY` from the environment, or pass `apiKey` explicitly.

### OpenAI GPT

```ts
provider: {
  name: 'openai',
  model: 'gpt-4o',
}
```

The SDK reads `OPENAI_API_KEY` from the environment, or pass `apiKey` explicitly.

### Custom / Local Models

Any OpenAI-compatible API can be used by setting `provider.baseURL`:

```ts
provider: {
  name: 'openai',
  model: 'llama-3',
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'sk-placeholder',
}
```

---

## Prompt Customisation

The `{locale}` placeholder in `prompt.system` is replaced with the target locale at runtime.

```ts
prompt: {
  system: 'You are a professional translator. Translate the following JSON values to {locale}. Keep JSON keys unchanged. Preserve placeholders like {name} or %s.',
}
```

### Per-locale overrides

Use `prompt.overrides` to append extra instructions for a specific locale:

```ts
prompt: {
  system: 'Translate to {locale}.',
  overrides: {
    fr: 'Use formal "vous" rather than "tu".',
    de: 'Use formal "Sie" form.',
    ja: 'Use polite keigo register.',
  },
}
```

The override text is appended to the system prompt (separated by a newline) only for that locale.

---

## Caching

Translations are cached in `<cacheDir>/<locale>.json` (default: `.translator-cache/fr.json`, etc.) in a **human-readable, diffable** format:

```json
{
  "_model": "gpt-4o",
  "entries": {
    "Hello": "Bonjour",
    "Goodbye": "Au revoir"
  }
}
```

- Entries are reviewable in PRs and **hand-editable** — fix a translation directly in the cache and it will be used on the next run.
- The whole file is invalidated automatically when `_model` differs from the configured model.
- Unchanged keys are never sent to the AI again; only modified or new keys consume API credits.

### Cache keying

`options.cacheKeying` controls how entries are keyed:

- **`'source'`** (default) — keyed by the source string, so identical strings are deduped app-wide. Editing a source string changes its key and triggers re-translation.
- **`'path'`** — keyed by `<relFile>#<dotted.path>`, so the **same English string can have different, context-specific translations** in different places (e.g. `"Open"` → `"Ouvrir"` for a button but `"Ouvert"` for a status). Because path-mode keys are location-based, editing a source string in place is not auto-detected — clear the cache or use `--prune` to refresh.

> **Upgrading from < 0.3.0?** The old opaque `{ <hash>: translation }` cache cannot be migrated losslessly. It is detected and ignored on first run with a notice. Run `json-translate adopt` once to rebuild it from your existing translations — see below.

**Disable caching:**

```ts
options: {
  cache: false;
}
```

**Clear the cache** (force full re-translation):

```bash
rm -rf .translator-cache
```

---

## Migrating an existing i18n project

If your repo **already has translated locale files**, you don't want the tool to
re-translate everything (cost) or overwrite good translations. The `adopt`
command bootstraps the cache from what you already have, so a normal run then
only fills genuinely new or changed keys.

```bash
# 1. Seed the cache from existing translations — makes NO API calls.
npx json-translate adopt

# 2. Translate — only new/changed keys hit the API.
npx json-translate
```

`adopt` walks the source tree and each existing target file in parallel; for
every source string whose path already holds a string in the target, it writes
that pair into the cache. It reports, per locale:

```
✓ fr  →  412 seeded, 8 to translate, 3 orphan(s)  (12 files)
```

- **seeded** — entries written to the cache from existing translations.
- **to translate** — source strings with no existing translation (filled on the next run).
- **orphan(s)** — keys present only in the target file (removable with `--prune`).

No hand-written migration script required.

---

## Structure Preservation

Source files are translated by walking the JSON tree and replacing **only string
leaves**, then writing the result back into a deep clone of the source. This means:

- Arrays of strings, **arrays of objects**, and nested arrays are translated in place.
- Numeric-keyed objects (`{"0": …}`) stay objects; real arrays stay arrays.
- Numbers, booleans, `null`, and empty/whitespace-only strings are preserved verbatim and never sent to the API.
- Key order and overall shape are byte-identical except for translated strings.

```jsonc
// en/seo.json
{ "sections": [ { "title": "Welcome", "content": "..." } ], "maxItems": 10 }

// fr/seo.json — structure intact, only strings translated
{ "sections": [ { "title": "Bienvenue", "content": "..." } ], "maxItems": 10 }
```

---

## Placeholder Integrity

Interpolation tokens must survive translation. After each leaf is translated, the
**multiset of placeholders** is compared between source and translation. The
defaults detect `{{name}}`, `{name}`, `%s` / `%d` / `%1$s`, and `<tag>` markers.

On mismatch the leaf is retried once; if it still fails, the **original source
value is kept**, a `[warn]` is logged, and it is counted in the run summary
(`placeholderWarnings`). Customise the token set with regex strings:

```ts
options: {
  placeholderPatterns: ["\\{\\{[^{}]+\\}\\}", ":[a-z_]+"], // {{x}} and :token
}
```

---

## Prune

By default, `merge` keeps target keys that no longer exist in the source. Set
`options.prune: true` (or pass `--prune`) to remove those orphans and evict their
stale cache entries:

```ts
options: {
  prune: true;
}
```

It is `false` by default to stay safe.

---

## Merge Mode

When `output.merge` is `true` (the default), the translator merges freshly translated keys into the existing output file. Keys present in the existing file but missing from the source are preserved.

This is useful when:

- you have manually corrected some translations and don't want them overwritten
- you add new keys to the source without touching old ones

Set `output.merge: false` to always write a clean file from the translation result only.

---

## Dry Run

Pass `--dry-run` on the CLI or set `options.dryRun: true` in config to preview the run without writing any files. The tool logs what it _would_ write to `stderr` and returns results with `dryRun: true`.

```bash
npx json-translate --dry-run
```

```
[dry-run] Would write 42 keys to ./locales/fr.json
[dry-run] Would write 42 keys to ./locales/de.json
```

---

## Programmatic Usage

```ts
import { translate, loadConfig } from "jsonai-translator";

// Load from a config file
const config = await loadConfig("./translator.config.ts");
const results = await translate(config);

for (const result of results) {
  console.log(
    `${result.locale}: ${result.keysTranslated} translated, ${result.keysCached} cached → ${result.outputPath}`,
  );
}
```

### `TranslationResult`

```ts
interface TranslationResult {
  locale: string; // e.g. 'fr'
  keysTranslated: number; // keys sent to the AI this run
  keysCached: number; // keys retrieved from cache
  outputPath: string; // output file path (single-file) or directory (folder mode)
  filesTranslated?: number; // number of files processed (folder mode only)
  dryRun: boolean;
  placeholderWarnings?: number; // leaves whose placeholders could not be preserved
  prunedKeys?: number; // keys removed when prune is enabled
}
```

### `adopt`

```ts
import { adopt, loadConfig } from "jsonai-translator";

const config = await loadConfig();
const results = await adopt(config); // seeds the cache, no API calls

for (const r of results) {
  console.log(`${r.locale}: ${r.seeded} seeded, ${r.missing} to translate, ${r.orphans} orphans`);
}
```

```ts
interface AdoptLocaleResult {
  locale: string;
  seeded: number; // cache entries seeded from existing translations
  missing: number; // source leaves with no existing translation
  orphans: number; // target-only keys (removable with prune)
  filesProcessed: number;
}
```

---

## TypeScript Config

Use `defineConfig` for full type-checking in your config file:

```ts
import { defineConfig } from "jsonai-translator";

export default defineConfig({
  provider: { name: "openai", model: "gpt-4o" },
  prompt: {
    system: "Translate all values to {locale}. Do not translate keys.",
    overrides: {
      fr: "Use formal register.",
    },
  },
  // Single-file mode
  input: { base: "./src/locales/en.json" },
  output: { dir: "./src/locales", filename: "{locale}.json", merge: true },

  // — OR — folder mode
  // input: { baseDir: './src/locales/en' },
  // output: { baseDir: './src/locales' },

  locales: ["fr", "de", "es", "ja", "zh"],
  options: {
    batchSize: 30,
    concurrency: 5,
    cache: true,
    cacheDir: ".translator-cache",
    cacheKeying: "source", // or 'path' for context-specific translations
    prune: false,
    indent: 2,
    // placeholderPatterns: ["\\{\\{[^{}]+\\}\\}", "\\{[^{}]+\\}"],
    dryRun: false,
  },
});
```

Config files can be `.ts`, `.js`, or `.json`. TypeScript files are loaded via dynamic `import()` (no extra build step needed).
