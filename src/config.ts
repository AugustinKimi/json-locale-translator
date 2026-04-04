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
    })
    .default({}),
});

export type TranslatorConfig = z.infer<typeof ConfigSchema>;

export interface TranslationResult {
  locale: string;
  keysTranslated: number;
  keysCached: number;
  outputPath: string;
  filesTranslated?: number;
  dryRun: boolean;
}

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
