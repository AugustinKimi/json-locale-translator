import { defineConfig, ConfigSchema } from '../src/config'

describe('defineConfig', () => {
  test('returns config as-is', () => {
    const config = {
      provider: { name: 'openai' as const, model: 'gpt-4o' },
      prompt: { system: 'Translate to {locale}' },
      input: { base: './locales/en.json' },
      output: { dir: './locales' },
      locales: ['fr', 'de'],
    }
    expect(defineConfig(config)).toBe(config)
  })
})

describe('ConfigSchema', () => {
  const validConfig = {
    provider: { name: 'anthropic' as const, model: 'claude-3-5-sonnet-20241022' },
    prompt: { system: 'Translate to {locale}' },
    input: { base: './locales/en.json' },
    output: { dir: './locales' },
    locales: ['fr'],
  }

  test('validates a correct config', () => {
    const result = ConfigSchema.parse(validConfig)
    expect(result.provider.name).toBe('anthropic')
    expect(result.locales).toEqual(['fr'])
  })

  test('applies default values for optional fields', () => {
    const result = ConfigSchema.parse(validConfig)
    expect(result.output.filename).toBe('{locale}.json')
    expect(result.output.merge).toBe(true)
    expect(result.options.batchSize).toBe(20)
    expect(result.options.concurrency).toBe(3)
    expect(result.options.cache).toBe(true)
    expect(result.options.cacheDir).toBe('.translator-cache')
    expect(result.options.dryRun).toBe(false)
  })

  test('throws on missing required fields', () => {
    expect(() => ConfigSchema.parse({})).toThrow()
  })

  test('throws if locales is empty array', () => {
    expect(() => ConfigSchema.parse({ ...validConfig, locales: [] })).toThrow()
  })

  test('throws on invalid provider name', () => {
    expect(() =>
      ConfigSchema.parse({ ...validConfig, provider: { name: 'unknown', model: 'x' } }),
    ).toThrow()
  })

  test('accepts optional apiKey and baseURL', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      provider: { name: 'openai' as const, model: 'gpt-4o', apiKey: 'sk-test', baseURL: 'https://proxy' },
    })
    expect(result.provider.apiKey).toBe('sk-test')
    expect(result.provider.baseURL).toBe('https://proxy')
  })

  test('accepts prompt overrides', () => {
    const result = ConfigSchema.parse({
      ...validConfig,
      prompt: { system: 'Translate to {locale}', overrides: { fr: 'Use formal tone.' } },
    })
    expect(result.prompt.overrides?.fr).toBe('Use formal tone.')
  })
})
