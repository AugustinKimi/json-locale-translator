/**
 * Presentation seam between the translation engine and any UI.
 *
 * The translator depends ONLY on this module — pure types, a no-op default, and
 * a swappable diagnostics sink. It never imports `ui.ts`, so clack/picocolors
 * stay out of the library and test paths and the engine stays headless and
 * testable. The CLI installs the real (clack-backed) reporter; library
 * consumers can pass their own or fall back to `noopReporter`.
 */

export type TranslationMode = "single-file" | "folder";

/** Up-front summary of the work the translator is about to do. */
export interface TranslationPlan {
  mode: TranslationMode;
  /** Best-effort source locale/file label, derived from the input path. */
  sourceLabel: string;
  /** The configured source path (input.base or input.baseDir). */
  sourcePath: string;
  /** Target locales. */
  locales: string[];
  /** Number of source files (per locale). */
  fileCount: number;
  /** Total translatable string leaves across all source files (per locale). */
  totalKeys: number;
  /** Total file-units of work: fileCount × locales.length. */
  totalUnits: number;
  dryRun: boolean;
}

export interface FileStartEvent {
  locale: string;
  relFile: string;
  /** Leaves already in cache (no API call needed). */
  cached: number;
  /** Unique strings that will be sent for translation. */
  toTranslate: number;
}

export interface FileDoneEvent {
  locale: string;
  relFile: string;
  outputPath: string;
  translated: number;
  cached: number;
  /** Placeholder mismatches that kept the original value. */
  warnings: number;
  pruned: number;
}

export interface FileErrorEvent {
  locale: string;
  relFile: string;
  message: string;
}

/**
 * Lifecycle hooks the translator calls as it works. A UI implements the ones it
 * wants to render; `noopReporter` no-ops them all for headless/library use.
 */
export interface Reporter {
  /** Fired once, before any file is processed. */
  start(plan: TranslationPlan): void;
  /** A file began processing (counts known, translation not yet done). */
  fileStart(event: FileStartEvent): void;
  /** A file finished successfully. */
  fileDone(event: FileDoneEvent): void;
  /** A file failed; the run continues with the remaining files. */
  fileError(event: FileErrorEvent): void;
  /** Out-of-band operational notice (e.g. cache invalidated). */
  notice(message: string): void;
}

export const noopReporter: Reporter = {
  start() {},
  fileStart() {},
  fileDone() {},
  fileError() {},
  notice() {},
};

/* ── Low-level diagnostics sink ───────────────────────────────────────────────
 * Deep code (retry/backoff, rate limiter, provider parse-retries) emits
 * transient operational messages from far down the call stack, where threading a
 * Reporter through every layer would be noise. They write through this swappable
 * sink instead. The default preserves the original stderr behaviour for library
 * consumers; the UI installs a sink that routes (or suppresses) messages so they
 * never corrupt a live spinner or a `--json` payload.
 */

export interface Diagnostics {
  warn(message: string): void;
  info(message: string): void;
}

const stderrDiagnostics: Diagnostics = {
  warn: (m) => process.stderr.write(`[warn] ${m}\n`),
  info: (m) => process.stderr.write(`[info] ${m}\n`),
};

let activeDiagnostics: Diagnostics = stderrDiagnostics;

/** Swap the diagnostics sink. Pass `null` to restore the stderr default. */
export function setDiagnostics(sink: Diagnostics | null): void {
  activeDiagnostics = sink ?? stderrDiagnostics;
}

/** Emit a low-level diagnostic through the active sink. */
export const diag: Diagnostics = {
  warn: (m) => activeDiagnostics.warn(m),
  info: (m) => activeDiagnostics.info(m),
};
