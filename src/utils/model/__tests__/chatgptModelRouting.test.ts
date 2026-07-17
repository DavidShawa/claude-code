import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from 'src/utils/settings/settingsCache.js'
import { parseUserSpecifiedModel } from '../model.js'
import { getModelStrings } from '../modelStrings.js'

const envKeys = [
  'OPENAI_AUTH_MODE',
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}

function resetProviderState(): void {
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
  resetModelStringsForTestingOnly()
}

describe('ChatGPT OAuth model routing', () => {
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    resetProviderState()
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    resetProviderState()
  })

  test('routes capability aliases to the matching GPT-5.6 tier', () => {
    expect(parseUserSpecifiedModel('opus')).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('sonnet')).toBe('gpt-5.6-terra')
    expect(parseUserSpecifiedModel('haiku')).toBe('gpt-5.6-luna')
  })

  test('honors OpenAI family overrides before OAuth defaults', () => {
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'custom-opus'
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'custom-sonnet'
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'custom-haiku'

    expect(parseUserSpecifiedModel('opus')).toBe('custom-opus')
    expect(parseUserSpecifiedModel('sonnet')).toBe('custom-sonnet')
    expect(parseUserSpecifiedModel('haiku')).toBe('custom-haiku')
  })

  test('does not apply OAuth defaults to other providers', () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    resetProviderState()

    const models = getModelStrings()
    expect(parseUserSpecifiedModel('opus')).toBe(models.opus47)
    expect(parseUserSpecifiedModel('sonnet')).toBe(models.sonnet46)
    expect(parseUserSpecifiedModel('haiku')).toBe(models.haiku45)
  })
})
