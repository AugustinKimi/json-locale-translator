#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { translate } from "./translator.js";
import { adopt } from "./adopt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getVersion(): Promise<string> {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function showHelp(): void {
  process.stdout.write(`
json-locale-translator — Translate JSON locale files using AI providers

Usage:
  json-translate [command] [options]

Commands:
  (default)          Translate source locale(s) into the configured targets
  adopt              Seed the cache from existing translated files (no API calls).
                     Run once on a project that already has translations so a
                     subsequent translate only fills new/changed keys.

Options:
  --config <path>    Path to config file (auto-detects if omitted)
  --locale <list>    Comma-separated locale override (e.g. --locale fr,de)
  --adopt            Run adopt instead of translate (same as the adopt command)
  --prune            Remove target keys / cache entries no longer in the source
  --dry-run          Preview without writing files
  --help             Show this help message
  --version          Show package version

Modes:
  Single-file   Set input.base and output.dir in your config.
  Folder        Set input.baseDir and output.baseDir to mirror an entire
                locale folder tree (e.g. en/ → fr/, de/).

Examples:
  json-translate
  json-translate adopt
  json-translate --config ./my-config.ts
  json-translate --locale fr,de
  json-translate --prune
  json-translate --dry-run
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      locale: { type: "string" },
      adopt: { type: "boolean" },
      prune: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    strict: false,
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values.version) {
    const version = await getVersion();
    process.stdout.write(`json-locale-translator v${version}\n`);
    process.exit(0);
  }

  try {
    const config = await loadConfig(values.config as string | undefined);

    if (values.locale) {
      config.locales = (values.locale as string)
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
    }

    if (values["dry-run"]) {
      config.options.dryRun = true;
    }

    if (values.prune) {
      config.options.prune = true;
    }

    const isAdopt = positionals.includes("adopt") || Boolean(values.adopt);

    if (isAdopt) {
      const results = await adopt(config);
      for (const result of results) {
        process.stdout.write(
          `✓ ${result.locale}  →  ${result.seeded} seeded, ${result.missing} to translate, ${result.orphans} orphan(s)  (${result.filesProcessed} files)\n`,
        );
      }
      process.stdout.write(
        `\nCache seeded. Run \`json-translate\` to fill only new/changed keys.\n`,
      );
      return;
    }

    const results = await translate(config);

    for (const result of results) {
      const status = result.dryRun ? "[dry-run]" : "✓";
      const filesSuffix =
        result.filesTranslated !== undefined
          ? `, ${result.filesTranslated} files`
          : "";
      const warnSuffix = result.placeholderWarnings
        ? `, ${result.placeholderWarnings} placeholder warning(s)`
        : "";
      const pruneSuffix = result.prunedKeys
        ? `, ${result.prunedKeys} pruned`
        : "";
      process.stdout.write(
        `${status} ${result.locale}  →  ${result.outputPath}   (${result.keysTranslated} translated, ${result.keysCached} cached${filesSuffix}${warnSuffix}${pruneSuffix})\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

main();
