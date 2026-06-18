#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { translate } from "./translator.js";
import { adopt } from "./adopt.js";
import { createReporter, resolveUiOptions } from "./ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getPackageInfo(): Promise<{ name: string; version: string }> {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
      name?: string;
      version?: string;
    };
    return {
      name: pkg.name ?? "json-locale-translator",
      version: pkg.version ?? "unknown",
    };
  } catch {
    return { name: "json-locale-translator", version: "unknown" };
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
  --source <label>   Source language label for display (e.g. --source en);
                     pass an empty string to hide it. Defaults to input.locale,
                     else auto-derived from the input path.
  --adopt            Run adopt instead of translate (same as the adopt command)
  --prune            Remove target keys / cache entries no longer in the source
  --dry-run          Preview without writing files
  --quiet            Only print errors and the final summary
  --json             Emit a single machine-readable JSON result (no decoration)
  --no-color         Disable colored output (also respects NO_COLOR)
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
      source: { type: "string" },
      adopt: { type: "boolean" },
      prune: { type: "boolean" },
      "dry-run": { type: "boolean" },
      quiet: { type: "boolean" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
    strict: false,
  });

  const pkg = await getPackageInfo();

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values.version) {
    process.stdout.write(`${pkg.name} v${pkg.version}\n`);
    process.exit(0);
  }

  const isAdopt = positionals.includes("adopt") || Boolean(values.adopt);

  // ── adopt: keeps its simple, deterministic line output ─────────────────────
  if (isAdopt) {
    try {
      const config = await loadConfig(values.config as string | undefined);
      applyOverrides(config, values);
      const results = await adopt(config);
      for (const result of results) {
        process.stdout.write(
          `✓ ${result.locale}  →  ${result.seeded} seeded, ${result.missing} to translate, ${result.orphans} orphan(s)  (${result.filesProcessed} files)\n`,
        );
      }
      process.stdout.write(
        `\nCache seeded. Run \`json-translate\` to fill only new/changed keys.\n`,
      );
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    return;
  }

  // ── translate: full terminal UI ────────────────────────────────────────────
  const ui = createReporter(
    resolveUiOptions({
      json: Boolean(values.json),
      quiet: Boolean(values.quiet),
      noColor: Boolean(values["no-color"]),
      name: pkg.name,
      version: pkg.version,
    }),
  );

  // Close the rails cleanly on Ctrl+C instead of leaving a half-rendered spinner.
  const onSigint = (): void => {
    ui.cancel();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);

  ui.begin();

  try {
    const config = await loadConfig(values.config as string | undefined);
    applyOverrides(config, values);

    const startedAt = Date.now();
    const results = await translate(config, ui);
    ui.finish({ results, durationMs: Date.now() - startedAt });

    // A single failed file shouldn't crash the run, but it should still surface
    // as a non-zero exit code for CI and scripting.
    const errorCount = results.reduce(
      (n, r) => n + (r.errors?.length ?? 0),
      0,
    );
    if (errorCount > 0) process.exitCode = 1;
  } catch (err) {
    ui.fatal(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/** Apply CLI flag overrides onto a loaded config, in place. */
function applyOverrides(
  config: Awaited<ReturnType<typeof loadConfig>>,
  values: Record<string, unknown>,
): void {
  if (typeof values.locale === "string") {
    config.locales = values.locale
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  // `--source ""` is meaningful (hide the label), so check presence, not truthiness.
  if (typeof values.source === "string") {
    config.input.locale = values.source;
  }
  if (values["dry-run"]) config.options.dryRun = true;
  if (values.prune) config.options.prune = true;
}

main();
