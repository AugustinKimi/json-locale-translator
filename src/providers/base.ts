export interface TranslationProvider {
  translate(
    keys: Record<string, string>,
    targetLocale: string,
    systemPrompt: string,
  ): Promise<Record<string, string>>
}

export interface ProviderConfig {
  name: 'anthropic' | 'openai'
  model: string
  apiKey?: string
  baseURL?: string
}

export async function createProvider(config: ProviderConfig): Promise<TranslationProvider> {
  if (config.name === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic.js')
    return new AnthropicProvider(config)
  } else if (config.name === 'openai') {
    const { OpenAIProvider } = await import('./openai.js')
    return new OpenAIProvider(config)
  }
  throw new Error(`Unknown provider: ${(config as ProviderConfig).name}`)
}
