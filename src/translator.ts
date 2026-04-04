import {
  readJsonFile,
  writeJsonFile,
  flattenJson,
  unflattenJson,
  mergeJson,
  walkJsonFiles,
} from "./json-utils.js";
import { createProvider } from "./providers/base.js";
import { chunkObject, runConcurrent } from "./batch.js";
import {
  loadCache,
  saveCache,
  getCachedTranslations,
  updateCache,
} from "./cache.js";
import { join } from "node:path";
import type { TranslatorConfig, TranslationResult } from "./config.js";

export async function translate(
  config: TranslatorConfig,
): Promise<TranslationResult[]> {
  const provider = await createProvider(config.provider);

  // ── Folder mode ──────────────────────────────────────────────────────────
  if (config.input.baseDir) {
    const inputBaseDir = config.input.baseDir;
    const outputBaseDir = config.output.baseDir!;

    // Discover all JSON files relative to the input base directory
    const relativeFiles = await walkJsonFiles(inputBaseDir);

    const localeTasks = config.locales.map(
      (locale) => async (): Promise<TranslationResult> => {
        let systemPrompt = config.prompt.system.replace("{locale}", locale);
        if (config.prompt.overrides?.[locale]) {
          systemPrompt += "\n" + config.prompt.overrides[locale];
        }

        let cacheData: Record<string, string> = {};
        if (config.options.cache) {
          cacheData = await loadCache(config.options.cacheDir, locale);
        }

        let totalKeysTranslated = 0;
        let totalKeysCached = 0;

        for (const relFile of relativeFiles) {
          const inputFilePath = join(inputBaseDir, relFile);
          const outputFilePath = join(outputBaseDir, locale, relFile);

          const sourceJson = await readJsonFile(inputFilePath);
          const flat = flattenJson(sourceJson);

          const { cached, uncached } = getCachedTranslations(
            flat,
            locale,
            config.provider.model,
            cacheData,
          );
          const cachedCount = Object.keys(cached).length;
          const uncachedCount = Object.keys(uncached).length;

          process.stderr.write(
            `[info] ${locale} / ${relFile}: ${cachedCount} keys cached, ${uncachedCount} keys to translate\n`,
          );

          let freshlyTranslated: Record<string, string> = {};

          if (!config.options.dryRun && uncachedCount > 0) {
            const chunks = chunkObject(uncached, config.options.batchSize);
            const batchTasks = chunks.map((chunk) => async () => {
              return provider.translate(chunk, locale, systemPrompt);
            });
            const batchResults = await runConcurrent(
              batchTasks,
              config.options.concurrency,
            );
            for (const batch of batchResults) {
              Object.assign(freshlyTranslated, batch);
            }
          }

          const allTranslated: Record<string, string> = {
            ...cached,
            ...freshlyTranslated,
          };

          if (config.options.cache && !config.options.dryRun) {
            cacheData = updateCache(
              cacheData,
              uncached,
              locale,
              config.provider.model,
              freshlyTranslated,
            );
          }

          if (config.options.dryRun) {
            process.stderr.write(
              `[dry-run] Would write ${Object.keys(allTranslated).length} keys to ${outputFilePath}\n`,
            );
          } else {
            const translatedNested = unflattenJson(allTranslated);
            let finalData = translatedNested;
            if (config.output.merge) {
              const existing = await readJsonFile(outputFilePath);
              finalData = mergeJson(existing, translatedNested);
            }
            await writeJsonFile(outputFilePath, finalData);
          }

          totalKeysTranslated += Object.keys(freshlyTranslated).length;
          totalKeysCached += cachedCount;
        }

        // Persist cache once after all files for this locale
        if (config.options.cache && !config.options.dryRun) {
          await saveCache(config.options.cacheDir, locale, cacheData);
        }

        return {
          locale,
          keysTranslated: totalKeysTranslated,
          keysCached: totalKeysCached,
          outputPath: join(outputBaseDir, locale),
          filesTranslated: relativeFiles.length,
          dryRun: config.options.dryRun,
        };
      },
    );

    return runConcurrent(localeTasks, config.options.concurrency);
  }

  // ── Single-file mode (existing behaviour) ────────────────────────────────
  const sourceJson = await readJsonFile(config.input.base!);
  const flat = flattenJson(sourceJson);

  const localeTasks = config.locales.map(
    (locale) => async (): Promise<TranslationResult> => {
      let systemPrompt = config.prompt.system.replace("{locale}", locale);
      if (config.prompt.overrides?.[locale]) {
        systemPrompt += "\n" + config.prompt.overrides[locale];
      }

      let cacheData: Record<string, string> = {};
      if (config.options.cache) {
        cacheData = await loadCache(config.options.cacheDir, locale);
      }

      const { cached, uncached } = getCachedTranslations(
        flat,
        locale,
        config.provider.model,
        cacheData,
      );

      const cachedCount = Object.keys(cached).length;
      const uncachedCount = Object.keys(uncached).length;

      process.stderr.write(
        `[info] ${locale}: ${cachedCount} keys cached, ${uncachedCount} keys to translate\n`,
      );

      let freshlyTranslated: Record<string, string> = {};

      if (!config.options.dryRun && uncachedCount > 0) {
        const chunks = chunkObject(uncached, config.options.batchSize);
        const batchTasks = chunks.map((chunk) => async () => {
          return provider.translate(chunk, locale, systemPrompt);
        });
        const batchResults = await runConcurrent(
          batchTasks,
          config.options.concurrency,
        );
        for (const batch of batchResults) {
          Object.assign(freshlyTranslated, batch);
        }
      }

      const allTranslated: Record<string, string> = {
        ...cached,
        ...freshlyTranslated,
      };

      if (config.options.cache && !config.options.dryRun) {
        const updatedCache = updateCache(
          cacheData,
          uncached,
          locale,
          config.provider.model,
          freshlyTranslated,
        );
        await saveCache(config.options.cacheDir, locale, updatedCache);
      }

      const translatedNested = unflattenJson(allTranslated);

      const filename = config.output.filename.replace("{locale}", locale);
      const outputPath = join(config.output.dir!, filename);

      if (config.options.dryRun) {
        process.stderr.write(
          `[dry-run] Would write ${Object.keys(allTranslated).length} keys to ${outputPath}\n`,
        );
      } else {
        let finalData = translatedNested;
        if (config.output.merge) {
          const existing = await readJsonFile(outputPath);
          finalData = mergeJson(existing, translatedNested);
        }
        await writeJsonFile(outputPath, finalData);
      }

      return {
        locale,
        keysTranslated: Object.keys(freshlyTranslated).length,
        keysCached: cachedCount,
        outputPath,
        dryRun: config.options.dryRun,
      };
    },
  );

  return runConcurrent(localeTasks, config.options.concurrency);
}
