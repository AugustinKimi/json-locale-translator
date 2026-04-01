import { readJsonFile, writeJsonFile, flattenJson, unflattenJson, mergeJson } from './json-utils.js'
import { createProvider } from './providers/base.js'
import { chunkObject, runConcurrent } from './batch.js'
import { loadCache, saveCache, getCachedTranslations, updateCache } from './cache.js'
import { join } from 'node:path'
import type { TranslatorConfig, TranslationResult } from './config.js'

export async function translate(config: TranslatorConfig): Promise<TranslationResult[]> {
  const sourceJson = await readJsonFile(config.input.base)
  const flat = flattenJson(sourceJson)
  const provider = await createProvider(config.provider)

  const localeTasks = config.locales.map((locale) => async (): Promise<TranslationResult> => {
    // Resolve system prompt
    let systemPrompt = config.prompt.system.replace('{locale}', locale)
    if (config.prompt.overrides?.[locale]) {
      systemPrompt += '\n' + config.prompt.overrides[locale]
    }

    // Load cache
    let cacheData: Record<string, string> = {}
    if (config.options.cache) {
      cacheData = await loadCache(config.options.cacheDir, locale)
    }

    // Split keys into cached vs uncached
    const { cached, uncached } = getCachedTranslations(flat, locale, config.provider.model, cacheData)

    const cachedCount = Object.keys(cached).length
    const uncachedCount = Object.keys(uncached).length

    process.stderr.write(
      `[info] ${locale}: ${cachedCount} keys cached, ${uncachedCount} keys to translate\n`,
    )

    let freshlyTranslated: Record<string, string> = {}

    if (!config.options.dryRun && uncachedCount > 0) {
      const chunks = chunkObject(uncached, config.options.batchSize)
      const batchTasks = chunks.map((chunk) => async () => {
        return provider.translate(chunk, locale, systemPrompt)
      })
      const batchResults = await runConcurrent(batchTasks, config.options.concurrency)
      for (const batch of batchResults) {
        Object.assign(freshlyTranslated, batch)
      }
    }

    // Merge cached + freshly translated
    const allTranslated: Record<string, string> = { ...cached, ...freshlyTranslated }

    // Update + save cache
    if (config.options.cache && !config.options.dryRun) {
      const updatedCache = updateCache(cacheData, uncached, locale, config.provider.model, freshlyTranslated)
      await saveCache(config.options.cacheDir, locale, updatedCache)
    }

    // Unflatten
    const translatedNested = unflattenJson(allTranslated)

    // Resolve output filename
    const filename = config.output.filename.replace('{locale}', locale)
    const outputPath = join(config.output.dir, filename)

    if (config.options.dryRun) {
      process.stderr.write(
        `[dry-run] Would write ${Object.keys(allTranslated).length} keys to ${outputPath}\n`,
      )
    } else {
      let finalData = translatedNested
      if (config.output.merge) {
        const existing = await readJsonFile(outputPath)
        finalData = mergeJson(existing, translatedNested)
      }
      await writeJsonFile(outputPath, finalData)
    }

    return {
      locale,
      keysTranslated: Object.keys(freshlyTranslated).length,
      keysCached: cachedCount,
      outputPath,
      dryRun: config.options.dryRun,
    }
  })

  return runConcurrent(localeTasks, config.options.concurrency)
}
