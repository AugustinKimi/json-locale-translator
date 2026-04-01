# json-locale-translator

Translate JSON locale files into multiple languages using AI providers (Anthropic Claude, OpenAI GPT).
Works as both a CLI tool and a programmatic Node.js library.

---

## Install

```bash
npm install json-locale-translator
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

1. Create a `translator.config.ts` in your project root:

```ts
import { defineConfig } from 'json-locale-translator'

export default defineConfig({
  provider: {
    name: 'openai',
    model: 'gpt-4o',
    // apiKey: 'sk-...',  // or set OPENAI_API_KEY env var
  },
  prompt: {
    system: 'You are a professional translator. Translate to {locale}.',
  },
  input: {
    base: './locales/en.json',
  },
  output: {
    dir: './locales',
    filename: '{locale}.json',
  },
  locales: ['fr', 'de', 'ja'],
})
```

2. Run the CLI:

```bash
npx json-translate
```

---

## Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `provider.name` | `'anthropic' \| 'openai'` | required | AI provider |
| `provider.model` | `string` | required | Model name (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`) |
| `provider.apiKey` | `string` | env var | API key (falls back to env var if omitted) |
| `provider.baseURL` | `string` | — | Custom base URL (for proxies / local models) |
| `prompt.system` | `string` | required | System prompt; `{locale}` is replaced at runtime |
| `prompt.overrides` | `Record<string, string>` | — | Per-locale extra instructions |
| `input.base` | `string` | required | Path to source JSON file |
| `output.dir` | `string` | required | Directory for translated files |
| `output.filename` | `string` | `{locale}.json` | Output filename template |
| `output.merge` | `boolean` | `true` | Merge with existing file if present |
| `locales` | `string[]` | required | Target locales (e.g. `['fr', 'de', 'ja']`) |
| `options.batchSize` | `number` | `20` | Keys per API call |
| `options.concurrency` | `number` | `3` | Parallel locale tasks |
| `options.cache` | `boolean` | `true` | Enable file-based cache |
| `options.cacheDir` | `string` | `.translator-cache` | Cache directory |
| `options.dryRun` | `boolean` | `false` | Preview without writing files |

---

## CLI Usage

```
json-translate [options]

Options:
  --config <path>    Path to config file (auto-detects if omitted)
  --locale <list>    Comma-separated locale override (e.g. --locale fr,de)
  --dry-run          Preview without writing files
  --help             Show usage
  --version          Show package version
```

---

## Programmatic Usage

```ts
import { translate, loadConfig } from 'json-locale-translator'

const config = await loadConfig('./translator.config.ts')
const results = await translate(config)

for (const result of results) {
  console.log(`${result.locale}: ${result.keysTranslated} translated, ${result.keysCached} cached`)
}
```

Or build a config inline:

```ts
import { translate, defineConfig } from 'json-locale-translator'

const config = defineConfig({
  provider: { name: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
  prompt: { system: 'Translate to {locale}.' },
  input: { base: './locales/en.json' },
  output: { dir: './locales' },
  locales: ['fr', 'de'],
})

await translate(config)
```

---

## Providers

### Anthropic Claude

```ts
provider: {
  name: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  // apiKey falls back to ANTHROPIC_API_KEY env var
}
```

### OpenAI GPT

```ts
provider: {
  name: 'openai',
  model: 'gpt-4o',
  // apiKey falls back to OPENAI_API_KEY env var
}
```

---

## Caching

By default, translations are cached in `.translator-cache/<locale>.json` using a SHA-256 hash of the source value, target locale, and model name. Cached translations are reused on subsequent runs, saving API calls for unchanged keys.

Disable with `options.cache: false` or clear the cache directory to force re-translation.

---

## Publishing

```bash
npm publish
```

The `prepublishOnly` script automatically runs `build` and `test` before publishing.
