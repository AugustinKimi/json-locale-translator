import { createHash } from 'node:crypto'
import { readJsonFile, writeJsonFile } from './json-utils.js'
import { join } from 'node:path'

function cacheKey(sourceValue: string, targetLocale: string, modelName: string): string {
  return createHash('sha256')
    .update(`${sourceValue}|${targetLocale}|${modelName}`)
    .digest('hex')
}

export async function loadCache(
  cacheDir: string,
  locale: string,
): Promise<Record<string, string>> {
  const filePath = join(cacheDir, `${locale}.json`)
  const data = await readJsonFile(filePath)
  return data as Record<string, string>
}

export async function saveCache(
  cacheDir: string,
  locale: string,
  cacheData: Record<string, string>,
): Promise<void> {
  const filePath = join(cacheDir, `${locale}.json`)
  await writeJsonFile(filePath, cacheData)
}

export function getCachedTranslations(
  flat: Record<string, string>,
  locale: string,
  model: string,
  cacheData: Record<string, string>,
): { cached: Record<string, string>; uncached: Record<string, string> } {
  const cached: Record<string, string> = {}
  const uncached: Record<string, string> = {}

  for (const [key, sourceValue] of Object.entries(flat)) {
    const hash = cacheKey(sourceValue, locale, model)
    if (hash in cacheData) {
      cached[key] = cacheData[hash]
    } else {
      uncached[key] = sourceValue
    }
  }

  return { cached, uncached }
}

export function updateCache(
  cacheData: Record<string, string>,
  flat: Record<string, string>,
  locale: string,
  model: string,
  translated: Record<string, string>,
): Record<string, string> {
  const updated = { ...cacheData }
  for (const [key, sourceValue] of Object.entries(flat)) {
    if (key in translated) {
      const hash = cacheKey(sourceValue, locale, model)
      updated[hash] = translated[key]
    }
  }
  return updated
}
