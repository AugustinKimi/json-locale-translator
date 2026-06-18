/**
 * Terminal UI for the translate command — the *only* module that imports clack
 * or picocolors. The engine talks to it through the headless `Reporter`
 * contract in `reporter.ts`, so translation logic stays decoupled and testable.
 *
 * Four output modes, chosen by flags + environment:
 *   - rich   interactive TTY: intro/outro rails, a live progress bar, styled logs
 *   - plain  non-TTY / CI: stable, line-based, parseable output (no animation)
 *   - quiet  errors + a single final summary line only
 *   - json   one machine-readable JSON object, no decorative UI at all
 */

import * as p from "@clack/prompts";
import pico from "picocolors";
import {
  setDiagnostics,
  type Diagnostics,
  type FileDoneEvent,
  type FileErrorEvent,
  type FileStartEvent,
  type Reporter,
  type TranslationPlan,
} from "./reporter.js";
import type { TranslationError, TranslationResult } from "./config.js";

export type OutputMode = "rich" | "plain" | "quiet" | "json";

export interface UiOptions {
  mode: OutputMode;
  color: boolean;
  name: string;
  version: string;
}

export interface RunSummary {
  results: TranslationResult[];
  durationMs: number;
}

/** A reporter plus the run-level lifecycle the CLI drives around `translate`. */
export interface RunReporter extends Reporter {
  /** Open the run (intro rail / header). */
  begin(): void;
  /** Close the run with an aggregated summary. */
  finish(summary: RunSummary): void;
  /** Tear the UI down cleanly on Ctrl+C. */
  cancel(): void;
  /** Report a fatal, run-ending error (e.g. config load failure). */
  fatal(message: string): void;
}

/* ── Option resolution ──────────────────────────────────────────────────────*/

export interface ResolveInput {
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  name: string;
  version: string;
}

/**
 * Decide the output mode and whether color is allowed from flags + environment.
 * Precedence: --json › --quiet › interactive TTY (rich) › plain. Color is off
 * for json, when --no-color or NO_COLOR is set, or when stdout isn't a TTY.
 */
export function resolveUiOptions(input: ResolveInput): UiOptions {
  const interactive = process.stdout.isTTY === true && !p.isCI();

  let mode: OutputMode;
  if (input.json) mode = "json";
  else if (input.quiet) mode = "quiet";
  else if (interactive) mode = "rich";
  else mode = "plain";

  const color =
    mode !== "json" &&
    !input.noColor &&
    !process.env.NO_COLOR &&
    process.stdout.isTTY === true;

  return { mode, color, name: input.name, version: input.version };
}

/* ── Shared formatting helpers ──────────────────────────────────────────────*/

type Theme = ReturnType<typeof makeTheme>;

function makeTheme(enabled: boolean) {
  const c = pico.createColors(enabled);
  return {
    accent: c.cyan,
    dim: c.dim,
    bold: c.bold,
    ok: c.green,
    warn: c.yellow,
    err: c.red,
  };
}

const num = (n: number): string => n.toLocaleString("en-US");

function plural(n: number, word: string): string {
  return `${num(n)} ${word}${n === 1 ? "" : "s"}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** "en → fr" with the arrow dimmed; falls back to "→ fr" when no source label. */
function arrow(t: Theme, source: string, target: string): string {
  const sep = t.dim("→");
  return source ? `${source} ${sep} ${t.accent(target)}` : `${sep} ${t.accent(target)}`;
}

/** Per-file stat line, e.g. "1,204 translated · 12 cached · 1 warning". */
function fileStats(e: FileDoneEvent): string {
  const parts = [`${plural(e.translated, "key")} translated`];
  if (e.cached) parts.push(`${num(e.cached)} cached`);
  if (e.warnings) parts.push(plural(e.warnings, "warning"));
  if (e.pruned) parts.push(`${num(e.pruned)} pruned`);
  return parts.join(" · ");
}

function collectErrors(results: TranslationResult[]): TranslationError[] {
  return results.flatMap((r) => r.errors ?? []);
}

/* ── Reporter factories (one per mode) ──────────────────────────────────────*/

export function createReporter(opts: UiOptions): RunReporter {
  switch (opts.mode) {
    case "rich":
      return createRichReporter(opts);
    case "quiet":
      return createQuietReporter(opts);
    case "json":
      return createJsonReporter(opts);
    case "plain":
    default:
      return createPlainReporter(opts);
  }
}

/* ── rich: clack rails + live progress bar ──────────────────────────────────*/

function createRichReporter(opts: UiOptions): RunReporter {
  const t = makeTheme(opts.color);
  // A single live element drives the whole run. We use a progress bar when
  // there's more than one unit of work, and a spinner for a single file.
  let bar: ReturnType<typeof p.progress> | null = null;
  let spin: ReturnType<typeof p.spinner> | null = null;
  let plan: TranslationPlan | null = null;

  const liveMessage = (msg: string): void => {
    if (bar) bar.message(msg);
    else if (spin) spin.message(msg);
  };
  const stopLive = (msg?: string): void => {
    if (bar) bar.stop(msg);
    else if (spin) spin.stop(msg);
    bar = null;
    spin = null;
  };

  // Route deep diagnostics above the live element so the bar never tears.
  setDiagnostics({
    warn: (m) => p.log.warn(t.dim(m)),
    info: (m) => p.log.info(t.dim(m)),
  });

  return {
    begin() {
      p.intro(`${t.bold(opts.name)} ${t.dim(`v${opts.version}`)}`);
    },

    start(p0: TranslationPlan) {
      plan = p0;
      const tag = p0.dryRun ? ` ${t.warn("(dry run)")}` : "";
      p.log.step(`${t.bold("Plan")}${tag}`);
      p.log.info(`${t.dim("source")}   ${p0.sourcePath}`);
      p.log.info(
        `${t.dim("targets")}  ${p0.locales.map((l) => t.accent(l)).join(", ")}`,
      );
      p.log.info(
        `${t.dim("scope")}    ${plural(p0.fileCount, "file")} · ${plural(p0.totalKeys, "key")} · ${plural(p0.locales.length, "locale")}`,
      );

      const label = p0.dryRun ? "Previewing" : "Translating";
      if (p0.totalUnits > 1) {
        bar = p.progress({ style: "heavy", max: p0.totalUnits, size: 28 });
        bar.start(`${label}…`);
      } else {
        spin = p.spinner();
        spin.start(`${label}…`);
      }
    },

    fileStart(e: FileStartEvent) {
      const counts =
        e.toTranslate > 0
          ? t.dim(`${num(e.toTranslate)} to translate`)
          : t.dim("all cached");
      liveMessage(`${arrow(t, plan?.sourceLabel ?? "", e.locale)}  ${t.dim(e.relFile)} · ${counts}`);
    },

    fileDone(e: FileDoneEvent) {
      if (bar) bar.advance(1);
      const head = `${arrow(t, plan?.sourceLabel ?? "", e.locale)}  ${t.dim(e.relFile)}`;
      const stats = t.dim(fileStats(e));
      if (e.warnings > 0) {
        p.log.warn(`${head} — ${stats}`);
      } else if (e.translated === 0 && e.cached === 0) {
        p.log.warn(`${head} — ${t.dim("no translatable strings")}`);
      } else {
        p.log.success(`${head} — ${stats}`);
      }
    },

    fileError(e: FileErrorEvent) {
      if (bar) bar.advance(1);
      p.log.error(
        `${arrow(t, plan?.sourceLabel ?? "", e.locale)}  ${t.dim(e.relFile)} — ${t.err(e.message)}`,
      );
    },

    notice(message: string) {
      p.log.info(t.dim(message));
    },

    finish({ results, durationMs }: RunSummary) {
      stopLive(t.dim("done"));
      setDiagnostics(null);

      const errors = collectErrors(results);
      const totalTranslated = results.reduce((s, r) => s + r.keysTranslated, 0);
      const totalCached = results.reduce((s, r) => s + r.keysCached, 0);
      const totalWarn = results.reduce(
        (s, r) => s + (r.placeholderWarnings ?? 0),
        0,
      );
      const filesWritten = results.reduce(
        (s, r) => s + (r.filesTranslated ?? 1),
        0,
      );
      const dryRun = results.some((r) => r.dryRun);

      const lines = results.map(
        (r) =>
          `${t.accent(r.locale.padEnd(6))} ${t.dim("→")} ${r.outputPath}  ${t.dim(`${num(r.keysTranslated)} translated · ${num(r.keysCached)} cached`)}`,
      );
      p.note(lines.join("\n"), dryRun ? "Would write" : "Output");

      if (errors.length > 0) {
        const detail = errors
          .map((e) => `${t.accent(e.locale)} ${t.dim(e.relFile)} — ${e.message}`)
          .join("\n");
        p.log.error(`${t.bold(plural(errors.length, "file"))} failed\n${detail}`);
      }
      if (totalWarn > 0) {
        p.log.warn(`${plural(totalWarn, "placeholder warning")} — originals kept`);
      }

      const verb = dryRun ? "Would translate" : "Translated";
      const summary = `${verb} ${t.bold(plural(totalTranslated, "key"))} across ${plural(filesWritten, "file")} ${t.dim(`(${num(totalCached)} cached)`)} in ${t.bold(formatDuration(durationMs))}`;
      const tail = errors.length
        ? `${summary} ${t.dim("·")} ${t.err(plural(errors.length, "error"))}`
        : summary;
      p.outro(tail);
    },

    cancel() {
      stopLive();
      setDiagnostics(null);
      p.cancel(t.warn("Cancelled — partial output may have been written."));
    },

    fatal(message: string) {
      stopLive();
      setDiagnostics(null);
      p.cancel(t.err(message));
    },
  };
}

/* ── plain: parseable, line-based, no animation ─────────────────────────────*/

function createPlainReporter(opts: UiOptions): RunReporter {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const errOut = (line: string): void => void process.stderr.write(`${line}\n`);
  // Keep the original stderr diagnostics ([warn]/[info]) — they're already
  // line-based and parseable, and go to stderr so they never pollute stdout.

  return {
    begin() {
      out(`${opts.name} v${opts.version}`);
    },
    start(plan: TranslationPlan) {
      out(
        `plan source=${plan.sourcePath} locales=${plan.locales.join(",")} files=${plan.fileCount} keys=${plan.totalKeys} dry-run=${plan.dryRun}`,
      );
    },
    fileStart() {
      /* no per-start line in plain mode — fileDone carries the record */
    },
    fileDone(e: FileDoneEvent) {
      out(
        `ok locale=${e.locale} file=${e.relFile} translated=${e.translated} cached=${e.cached} warnings=${e.warnings} pruned=${e.pruned} output=${e.outputPath}`,
      );
    },
    fileError(e: FileErrorEvent) {
      errOut(`error locale=${e.locale} file=${e.relFile} message=${e.message}`);
    },
    notice(message: string) {
      errOut(`notice ${message}`);
    },
    finish({ results, durationMs }: RunSummary) {
      for (const r of results) {
        out(
          `result locale=${r.locale} output=${r.outputPath} translated=${r.keysTranslated} cached=${r.keysCached}`,
        );
      }
      const errors = collectErrors(results);
      const totalTranslated = results.reduce((s, r) => s + r.keysTranslated, 0);
      const totalCached = results.reduce((s, r) => s + r.keysCached, 0);
      const filesWritten = results.reduce(
        (s, r) => s + (r.filesTranslated ?? 1),
        0,
      );
      out(
        `done files=${filesWritten} translated=${totalTranslated} cached=${totalCached} errors=${errors.length} duration_ms=${Math.round(durationMs)}`,
      );
    },
    cancel() {
      errOut(`cancelled`);
    },
    fatal(message: string) {
      errOut(`fatal ${message}`);
    },
  };
}

/* ── quiet: errors + one final summary line ─────────────────────────────────*/

function createQuietReporter(opts: UiOptions): RunReporter {
  const t = makeTheme(opts.color);
  // Suppress transient operational chatter entirely.
  const silent: Diagnostics = { warn() {}, info() {} };

  return {
    begin() {
      setDiagnostics(silent);
    },
    start() {},
    fileStart() {},
    fileDone() {},
    fileError(e: FileErrorEvent) {
      process.stderr.write(
        `${t.err("error")} ${e.locale} ${e.relFile}: ${e.message}\n`,
      );
    },
    notice() {},
    finish({ results, durationMs }: RunSummary) {
      setDiagnostics(null);
      const errors = collectErrors(results);
      const totalTranslated = results.reduce((s, r) => s + r.keysTranslated, 0);
      const filesWritten = results.reduce(
        (s, r) => s + (r.filesTranslated ?? 1),
        0,
      );
      const base = `${plural(totalTranslated, "key")} across ${plural(filesWritten, "file")} in ${formatDuration(durationMs)}`;
      const line = errors.length
        ? `${base} · ${t.err(plural(errors.length, "error"))}`
        : base;
      process.stdout.write(`${line}\n`);
    },
    cancel() {
      setDiagnostics(null);
      process.stderr.write(`${t.warn("cancelled")}\n`);
    },
    fatal(message: string) {
      setDiagnostics(null);
      process.stderr.write(`${t.err("error")} ${message}\n`);
    },
  };
}

/* ── json: a single machine-readable object, nothing else ───────────────────*/

function createJsonReporter(_opts: UiOptions): RunReporter {
  let plan: TranslationPlan | null = null;
  // No decorative UI, and no stderr chatter that a consumer might confuse for
  // output — suppress diagnostics for the duration of the run.
  const silent: Diagnostics = { warn() {}, info() {} };

  const emit = (obj: unknown): void =>
    void process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

  return {
    begin() {
      setDiagnostics(silent);
    },
    start(p0: TranslationPlan) {
      plan = p0;
    },
    fileStart() {},
    fileDone() {},
    fileError() {},
    notice() {},
    finish({ results, durationMs }: RunSummary) {
      setDiagnostics(null);
      const errors = collectErrors(results);
      emit({
        ok: errors.length === 0,
        durationMs: Math.round(durationMs),
        plan: plan
          ? {
              mode: plan.mode,
              source: plan.sourcePath,
              sourceLocale: plan.sourceLabel,
              locales: plan.locales,
              files: plan.fileCount,
              keys: plan.totalKeys,
              dryRun: plan.dryRun,
            }
          : null,
        results: results.map((r) => ({
          locale: r.locale,
          outputPath: r.outputPath,
          keysTranslated: r.keysTranslated,
          keysCached: r.keysCached,
          filesTranslated: r.filesTranslated,
          placeholderWarnings: r.placeholderWarnings ?? 0,
          prunedKeys: r.prunedKeys ?? 0,
          dryRun: r.dryRun,
        })),
        errors,
      });
    },
    cancel() {
      setDiagnostics(null);
      emit({ ok: false, cancelled: true });
    },
    fatal(message: string) {
      setDiagnostics(null);
      emit({ ok: false, error: message });
    },
  };
}
