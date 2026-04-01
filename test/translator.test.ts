import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as jsonUtils from '../src/json-utils'
import type { TranslatorConfig } from '../src/config'

// Mock provider that returns predictable translations
const mockTranslate = jest.fn(
  async (keys: Record<string, string>, locale: string): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(keys)) {
      result[key] = `[${locale}] ${value}`
    }
    return result
  },
)

const mockProvider = { translate: mockTranslate }

jest.unstable_mockModule('../src/providers/base', () => ({
  createProvider: () => Promise.resolve(mockProvider),
}))

// Import translate AFTER setting up mocks
const { translate } = await import('../src/translator')


function makeConfig(overrides: Partial<TranslatorConfig> = {}): TranslatorConfig {
  const tmpDir = join(tmpdir(), `translator-test-${Date.now()}`)
  return {
    provider: { name: 'openai', model: 'gpt-4o' },
    prompt: { system: 'Translate to {locale}' },
    input: { base: join(tmpDir, 'en.json') },
    output: { dir: join(tmpDir, 'out'), filename: '{locale}.json', merge: false },
    locales: ['fr', 'de'],
    options: {
      batchSize: 20,
      concurrency: 2,
      cache: false,
      cacheDir: join(tmpDir, '.cache'),
      dryRun: false,
    },
    ...overrides,
  } as TranslatorConfig
}

describe('translate', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `translator-test-${Date.now()}`)
    mockTranslate.mockClear()
  })

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('writes locale files for each locale', async () => {
    const config = makeConfig({ input: { base: join(tmpDir, 'en.json') }, output: { dir: join(tmpDir, 'out'), filename: '{locale}.json', merge: false } })
    tmpDir = join(tmpdir(), `translator-test-${Date.now()}`)
    // Write the source file
    await jsonUtils.writeJsonFile(config.input.base, { greeting: 'Hello', farewell: 'Goodbye' })

    const results = await translate(config)

    expect(results).toHaveLength(2)
    const locales = results.map((r) => r.locale).sort()
    expect(locales).toEqual(['de', 'fr'])

    for (const result of results) {
      expect(existsSync(result.outputPath)).toBe(true)
      const written = await jsonUtils.readJsonFile(result.outputPath)
      // All values should be translated
      expect((written as Record<string, string>).greeting).toContain(result.locale)
    }
  })

  test('dry-run does not write files', async () => {
    const config = makeConfig({
      input: { base: join(tmpDir, 'en.json') },
      output: { dir: join(tmpDir, 'out'), filename: '{locale}.json', merge: false },
      options: {
        batchSize: 20,
        concurrency: 2,
        cache: false,
        cacheDir: join(tmpDir, '.cache'),
        dryRun: true,
      },
    })
    await jsonUtils.writeJsonFile(config.input.base, { hello: 'Hello' })

    const results = await translate(config)

    expect(results.every((r) => r.dryRun)).toBe(true)
    for (const result of results) {
      expect(existsSync(result.outputPath)).toBe(false)
    }
  })

  test('merge mode preserves existing keys not in source', async () => {
    const outDir = join(tmpDir, 'out')
    const config = makeConfig({
      input: { base: join(tmpDir, 'en.json') },
      output: { dir: outDir, filename: '{locale}.json', merge: true },
      locales: ['fr'],
    })
    await jsonUtils.writeJsonFile(config.input.base, { greeting: 'Hello' })
    // Write an existing translated file with extra key
    await jsonUtils.writeJsonFile(join(outDir, 'fr.json'), { extra_key: 'Existing value' })

    const results = await translate(config)
    expect(results).toHaveLength(1)

    const written = await jsonUtils.readJsonFile(results[0].outputPath) as Record<string, string>
    // Both the newly translated key and the existing extra key should be present
    expect(written.greeting).toContain('fr')
    expect(written.extra_key).toBe('Existing value')
  })

  test('returns correct keysTranslated and keysCached counts', async () => {
    const config = makeConfig({
      input: { base: join(tmpDir, 'en.json') },
      output: { dir: join(tmpDir, 'out'), filename: '{locale}.json', merge: false },
      locales: ['fr'],
    })
    await jsonUtils.writeJsonFile(config.input.base, { a: 'A', b: 'B', c: 'C' })

    const results = await translate(config)

    expect(results[0].keysTranslated).toBe(3)
    expect(results[0].keysCached).toBe(0)
  })
})
