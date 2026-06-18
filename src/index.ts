export { translate } from './translator.js'
export { adopt } from './adopt.js'
export { loadConfig, defineConfig } from './config.js'
export type {
  TranslatorConfig,
  TranslationResult,
  AdoptResult,
  AdoptLocaleResult,
} from './config.js'
export type { TranslationProvider } from './providers/base.js'
export {
  DEFAULT_PLACEHOLDER_PATTERNS,
  extractPlaceholders,
  placeholdersMatch,
} from './placeholders.js'
