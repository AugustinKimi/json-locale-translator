import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ConfigSchema = z.object({
  provider: z.object({
    name: z.enum(["anthropic", "openai"]),
    model: z.string(),
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
  }),

  prompt: z.object({
    system: z.string(),
    overrides: z.record(z.string()).optional(),
  }),

  input: z
    .object({
      base: z.string().optional(),
      baseDir: z.string().optional(),
      /**
       * Label for the source language, used purely for display
       * (e.g. the "en → fr" progress text). Optional and free-form:
       *   - omit it      → auto-derived from the input path's basename
       *   - set "en"     → shown verbatim
       *   - set ""       → no source label is shown ("→ fr")
       * Overridable per-run with the `--source` CLI flag.
       */
      locale: z.string().optional(),
    })
    .refine((v) => v.base || v.baseDir, {
      message:
        "Either input.base (single file) or input.baseDir (folder) must be set",
    }),

  output: z
    .object({
      dir: z.string().optional(),
      filename: z.string().default("{locale}.json"),
      merge: z.boolean().default(true),
      baseDir: z.string().optional(),
    })
    .refine((v) => v.dir || v.baseDir, {
      message:
        "Either output.dir (single file) or output.baseDir (folder) must be set",
    }),

  locales: z.array(z.string()).min(1),

  options: z
    .object({
      batchSize: z.number().int().min(1).max(100).default(20),
      concurrency: z.number().int().min(1).max(10).default(3),
      cache: z.boolean().default(true),
      cacheDir: z.string().default(".translator-cache"),
      dryRun: z.boolean().default(false),
      /**
       * How cache entries are keyed.
       * - 'source' (default): dedupe identical strings app-wide (cheapest).
       * - 'path': key by `<relFile>#<path>` so the same source string can have
       *   different, context-specific translations in different places.
       */
      cacheKeying: z.enum(["source", "path"]).default("source"),
      /** Remove target keys (and stale cache entries) no longer present in source. */
      prune: z.boolean().default(false),
      /** Indentation width for written JSON files. */
      indent: z.number().int().min(0).max(8).default(2),
      /**
       * Regex strings used to detect interpolation tokens that must round-trip
       * unchanged. Defaults to {{name}}, {name}, %s/%d/%1$s and <tag> markers.
       */
      placeholderPatterns: z.array(z.string()).optional(),
    })
    .default({}),
});

export type TranslatorConfig = z.infer<typeof ConfigSchema>;

/** A single source file that failed during a locale's run. */
export interface TranslationError {
  locale: string;
  relFile: string;
  message: string;
}

export interface TranslationResult {
  locale: string;
  keysTranslated: number;
  keysCached: number;
  outputPath: string;
  filesTranslated?: number;
  dryRun: boolean;
  /** Leaves whose placeholders could not be preserved (original kept). */
  placeholderWarnings?: number;
  /** Keys removed from target files when `options.prune` is enabled. */
  prunedKeys?: number;
  /** Files that failed for this locale; the run continued past them. */
  errors?: TranslationError[];
}

export interface AdoptLocaleResult {
  locale: string;
  /** Cache entries seeded from existing translations. */
  seeded: number;
  /** Source leaves with no existing target translation (will translate next run). */
  missing: number;
  /** Target-only string leaves with no matching source path (orphans). */
  orphans: number;
  filesProcessed: number;
}

export type AdoptResult = AdoptLocaleResult[];

export { ConfigSchema };

export function defineConfig(
  config: z.input<typeof ConfigSchema>,
): z.input<typeof ConfigSchema> {
  return config;
}

export async function loadConfig(
  configPath?: string,
): Promise<TranslatorConfig> {
  if (configPath) {
    return loadFromPath(configPath);
  }

  const cwd = process.cwd();
  const candidates = [
    join(cwd, "translator.config.ts"),
    join(cwd, "translator.config.js"),
    join(cwd, "translator.config.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return loadFromPath(candidate);
    }
  }

  throw new Error(
    "No config file found. Create a translator.config.ts, translator.config.js, or translator.config.json in the current directory.",
  );
}

async function loadFromPath(filePath: string): Promise<TranslatorConfig> {
  if (filePath.endsWith(".json")) {
    const content = await readFile(filePath, "utf-8");
    const raw = JSON.parse(content);
    return ConfigSchema.parse(raw);
  }

  // .ts or .js — use dynamic import
  const mod = await import(filePath);
  const raw = mod.default ?? mod;
  return ConfigSchema.parse(raw);
}
