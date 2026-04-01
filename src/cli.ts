#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { translate } from './translator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function getVersion(): Promise<string> {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version: string }
    return pkg.version
  } catch {
    return 'unknown'
  }
}

function showHelp(): void {
  process.stdout.write(`
json-locale-translator — Translate JSON locale files using AI providers

Usage:
  json-translate [options]

Options:
  --config <path>    Path to config file (auto-detects if omitted)
  --locale <list>    Comma-separated locale override (e.g. --locale fr,de)
  --dry-run          Preview without writing files
  --help             Show this help message
  --version          Show package version

Examples:
  json-translate
  json-translate --config ./my-config.ts
  json-translate --locale fr,de
  json-translate --dry-run
`)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      locale: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    strict: false,
  })

  if (values.help) {
    showHelp()
    process.exit(0)
  }

  if (values.version) {
    const version = await getVersion()
    process.stdout.write(`json-locale-translator v${version}\n`)
    process.exit(0)
  }

  try {
    const config = await loadConfig(values.config as string | undefined)

    if (values.locale) {
      config.locales = (values.locale as string).split(',').map((l) => l.trim()).filter(Boolean)
    }

    if (values['dry-run']) {
      config.options.dryRun = true
    }

    const results = await translate(config)

    for (const result of results) {
      const status = result.dryRun ? '[dry-run]' : '✓'
      process.stdout.write(
        `${status} ${result.locale}  →  ${result.outputPath}   (${result.keysTranslated} translated, ${result.keysCached} cached)\n`,
      )
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

main()
