import {
  readJsonFile,
  writeJsonFile,
  mergeJson,
  walkJsonFiles,
} from "./json-utils.js";
import {
  collectStringLeaves,
  deepClone,
  setAtPath,
  pruneToSource,
  type StringLeaf,
} from "./tree.js";
import { createProvider, type TranslationProvider } from "./providers/base.js";
import { chunkObject, runConcurrent } from "./batch.js";
import { loadCache, saveCache, cacheKeyFor } from "./cache.js";
import {
  DEFAULT_PLACEHOLDER_PATTERNS,
  placeholdersMatch,
} from "./placeholders.js";
import { basename, join } from "node:path";
import type { TranslatorConfig, TranslationResult } from "./config.js";

interface PlaceholderWarning {
  relFile: string;
  pathKey: string;
  source: string;
}

interface FileResult {
  translated: number;
  cached: number;
  pruned: number;
  warnings: PlaceholderWarning[];
}

interface LocaleResult {
  translated: number;
  cached: number;
  pruned: number;
  warnings: PlaceholderWarning[];
}

/** A unique translation request, deduped by cache key within a single file. */
interface TranslationRequest {
  id: string;
  source: string;
  /** Representative path key for warning reporting. */
  pathKey: string;
  /** Cache key all leaves sharing this request map to. */
  ck: string;
}

/**
 * Translate a deduped set of requests with batching, then verify placeholder
 * integrity per request. Any request whose placeholders are mangled is retried
 * once; if it still fails the original source value is kept and a warning is
 * recorded. This is the provider-agnostic correctness layer.
 */
async function translateRequests(
  provider: TranslationProvider,
  requests: TranslationRequest[],
  locale: string,
  systemPrompt: string,
  relFile: string,
  config: TranslatorConfig,
): Promise<{ byCacheKey: Map<string, string>; warnings: PlaceholderWarning[] }> {
  const byCacheKey = new Map<string, string>();
  const warnings: PlaceholderWarning[] = [];
  if (requests.length === 0) return { byCacheKey, warnings };

  const patterns =
    config.options.placeholderPatterns ?? DEFAULT_PLACEHOLDER_PATTERNS;

  const callBatches = async (
    items: TranslationRequest[],
  ): Promise<Record<string, string>> => {
    const batch: Record<string, string> = {};
    for (const item of items) batch[item.id] = item.source;
    const chunks = chunkObject(batch, config.options.batchSize);
    const tasks = chunks.map(
      (chunk) => () => provider.translate(chunk, locale, systemPrompt),
    );
    const results = await runConcurrent(tasks, config.options.concurrency);
    const merged: Record<string, string> = {};
    for (const part of results) Object.assign(merged, part);
    return merged;
  };

  const first = await callBatches(requests);
  const failed: TranslationRequest[] = [];
  for (const req of requests) {
    const translation = first[req.id] ?? req.source;
    if (placeholdersMatch(req.source, translation, patterns)) {
      byCacheKey.set(req.ck, translation);
    } else {
      failed.push(req);
    }
  }

  if (failed.length > 0) {
    const second = await callBatches(failed);
    for (const req of failed) {
      const translation = second[req.id] ?? req.source;
      if (placeholdersMatch(req.source, translation, patterns)) {
        byCacheKey.set(req.ck, translation);
      } else {
        // Keep the original source value rather than ship mangled placeholders.
        byCacheKey.set(req.ck, req.source);
        warnings.push({ relFile, pathKey: req.pathKey, source: req.source });
        process.stderr.write(
          `[warn] ${locale} / ${relFile} :: ${req.pathKey}: placeholder mismatch after retry — keeping original value\n`,
        );
      }
    }
  }

  return { byCacheKey, warnings };
}

/**
 * Process a single source file for a single locale: translate string leaves,
 * preserve structure, write the result, and update the (shared) cache entries.
 */
async function processFile(
  provider: TranslationProvider,
  config: TranslatorConfig,
  locale: string,
  systemPrompt: string,
  inputFilePath: string,
  outputFilePath: string,
  relFile: string,
  cacheEntries: Record<string, string>,
  seenCacheKeys: Set<string>,
): Promise<FileResult> {
  const { cache: useCache, cacheKeying, dryRun } = config.options;

  const source = await readJsonFile(inputFilePath);
  const leaves = collectStringLeaves(source);
  const clone = deepClone(source);

  const ckOf = (leaf: StringLeaf): string =>
    cacheKeyFor(cacheKeying, leaf.value, relFile, leaf.pathKey);

  const cachedLeaves: StringLeaf[] = [];
  const uncachedLeaves: StringLeaf[] = [];
  const uniqueRequests = new Map<string, TranslationRequest>();

  for (const leaf of leaves) {
    const ck = ckOf(leaf);
    if (useCache) seenCacheKeys.add(ck);
    if (useCache && ck in cacheEntries) {
      cachedLeaves.push(leaf);
    } else {
      uncachedLeaves.push(leaf);
      if (!uniqueRequests.has(ck)) {
        uniqueRequests.set(ck, {
          id: `t${uniqueRequests.size}`,
          source: leaf.value,
          pathKey: leaf.pathKey,
          ck,
        });
      }
    }
  }

  // Write cached translations into the clone.
  for (const leaf of cachedLeaves) {
    setAtPath(clone, leaf.path, cacheEntries[ckOf(leaf)]);
  }

  process.stderr.write(
    `[info] ${locale} / ${relFile}: ${cachedLeaves.length} cached, ${uniqueRequests.size} to translate\n`,
  );

  const warnings: PlaceholderWarning[] = [];

  if (!dryRun && uniqueRequests.size > 0) {
    const requests = [...uniqueRequests.values()];
    const { byCacheKey, warnings: w } = await translateRequests(
      provider,
      requests,
      locale,
      systemPrompt,
      relFile,
      config,
    );
    warnings.push(...w);

    for (const leaf of uncachedLeaves) {
      const translation = byCacheKey.get(ckOf(leaf));
      if (translation !== undefined) setAtPath(clone, leaf.path, translation);
    }
    if (useCache) {
      for (const [ck, translation] of byCacheKey) cacheEntries[ck] = translation;
    }
  }

  if (dryRun) {
    process.stderr.write(
      `[dry-run] Would write ${leaves.length} string leaves to ${outputFilePath}\n`,
    );
    return { translated: 0, cached: cachedLeaves.length, pruned: 0, warnings };
  }

  let finalData: unknown = clone;
  if (config.output.merge) {
    const existing = await readJsonFile(outputFilePath);
    finalData = mergeJson(
      existing,
      clone as Record<string, unknown>,
    );
  }

  let pruned = 0;
  if (config.options.prune) {
    pruned = pruneToSource(finalData, source);
  }

  await writeJsonFile(outputFilePath, finalData, config.options.indent);

  return {
    translated: uncachedLeaves.length,
    cached: cachedLeaves.length,
    pruned,
    warnings,
  };
}

/** Run all files for one locale, loading/saving the shared per-locale cache. */
async function runLocale(
  provider: TranslationProvider,
  config: TranslatorConfig,
  locale: string,
  files: Array<{ input: string; output: string; relFile: string }>,
): Promise<LocaleResult> {
  let systemPrompt = config.prompt.system.replace("{locale}", locale);
  if (config.prompt.overrides?.[locale]) {
    systemPrompt += "\n" + config.prompt.overrides[locale];
  }

  let cacheEntries: Record<string, string> = {};
  if (config.options.cache) {
    const loaded = await loadCache(
      config.options.cacheDir,
      locale,
      config.provider.model,
    );
    cacheEntries = loaded.entries;
    if (loaded.legacy) {
      process.stderr.write(
        `[notice] ${locale}: legacy cache format detected and ignored. Run \`json-translate adopt\` to rebuild from existing translations.\n`,
      );
    }
    if (loaded.modelChanged) {
      process.stderr.write(
        `[notice] ${locale}: cache was built with a different model — invalidated.\n`,
      );
    }
  }

  const seenCacheKeys = new Set<string>();
  let translated = 0;
  let cached = 0;
  let pruned = 0;
  const warnings: PlaceholderWarning[] = [];

  for (const file of files) {
    const res = await processFile(
      provider,
      config,
      locale,
      systemPrompt,
      file.input,
      file.output,
      file.relFile,
      cacheEntries,
      seenCacheKeys,
    );
    translated += res.translated;
    cached += res.cached;
    pruned += res.pruned;
    warnings.push(...res.warnings);
  }

  if (config.options.cache && !config.options.dryRun) {
    if (config.options.prune) {
      for (const key of Object.keys(cacheEntries)) {
        if (!seenCacheKeys.has(key)) delete cacheEntries[key];
      }
    }
    await saveCache(
      config.options.cacheDir,
      locale,
      config.provider.model,
      cacheEntries,
      config.options.indent,
    );
  }

  return { translated, cached, pruned, warnings };
}

export async function translate(
  config: TranslatorConfig,
): Promise<TranslationResult[]> {
  const provider = await createProvider(config.provider);

  // ── Folder mode ──────────────────────────────────────────────────────────
  if (config.input.baseDir) {
    const inputBaseDir = config.input.baseDir;
    const outputBaseDir = config.output.baseDir!;
    const relativeFiles = await walkJsonFiles(inputBaseDir);

    const tasks = config.locales.map(
      (locale) => async (): Promise<TranslationResult> => {
        const files = relativeFiles.map((rel) => ({
          input: join(inputBaseDir, rel),
          output: join(outputBaseDir, locale, rel),
          relFile: rel,
        }));
        const res = await runLocale(provider, config, locale, files);
        return {
          locale,
          keysTranslated: res.translated,
          keysCached: res.cached,
          outputPath: join(outputBaseDir, locale),
          filesTranslated: relativeFiles.length,
          dryRun: config.options.dryRun,
          placeholderWarnings: res.warnings.length,
          prunedKeys: res.pruned,
        };
      },
    );

    return runConcurrent(tasks, config.options.concurrency);
  }

  // ── Single-file mode ───────────────────────────────────────────────────────
  const base = config.input.base!;
  const relFile = basename(base);

  const tasks = config.locales.map(
    (locale) => async (): Promise<TranslationResult> => {
      const filename = config.output.filename.replace("{locale}", locale);
      const outputPath = join(config.output.dir!, filename);
      const res = await runLocale(provider, config, locale, [
        { input: base, output: outputPath, relFile },
      ]);
      return {
        locale,
        keysTranslated: res.translated,
        keysCached: res.cached,
        outputPath,
        dryRun: config.options.dryRun,
        placeholderWarnings: res.warnings.length,
        prunedKeys: res.pruned,
      };
    },
  );

  return runConcurrent(tasks, config.options.concurrency);
}
