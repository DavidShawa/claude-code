import { describe, expect, test, beforeEach, mock } from 'bun:test'

import { logMock } from '../../../../../tests/mocks/log.js'
mock.module('src/utils/log.ts', logMock)

import { debugMock } from '../../../../../tests/mocks/debug.js'
mock.module('src/utils/debug.ts', debugMock)

import {
  classifyWindowLabel,
  parseCodexUsageResponse,
  providerBucketsToOpenAIUtilization,
  shouldShowOpenAIUsage,
} from '../usage.js'
import {
  resetProviderUsage,
  updateProviderBuckets,
} from '../../../providerUsage/store.js'
import { openaiAdapter } from '../../../providerUsage/adapters/openai.js'

describe('classifyWindowLabel', () => {
  test('maps ~5h to 5-hour', () => {
    expect(classifyWindowLabel(5 * 3600, 'primary')).toBe('5-hour')
  })

  test('maps ~7d to Weekly', () => {
    expect(classifyWindowLabel(7 * 24 * 3600, 'secondary')).toBe('Weekly')
  })

  test('falls back to Primary/Secondary when duration unknown', () => {
    expect(classifyWindowLabel(null, 'primary')).toBe('Primary')
    expect(classifyWindowLabel(undefined, 'secondary')).toBe('Secondary')
  })
})

describe('parseCodexUsageResponse', () => {
  test('parses primary + secondary windows and plan', () => {
    const now = Math.floor(Date.now() / 1000)
    const out = parseCodexUsageResponse({
      plan_type: 'plus',
      rate_limit: {
        primary_window: {
          used_percent: 42.5,
          reset_at: now + 3600,
          limit_window_seconds: 5 * 3600,
        },
        secondary_window: {
          used_percent: 10,
          reset_at: now + 86400,
          limit_window_seconds: 7 * 24 * 3600,
        },
      },
      credits: { has_credits: false },
    })

    expect(out.source).toBe('chatgpt')
    expect(out.plan_type).toBe('plus')
    expect(out.windows).toHaveLength(2)
    expect(out.windows[0]).toMatchObject({
      label: '5-hour',
      utilization: 42.5,
    })
    expect(out.windows[1]).toMatchObject({
      label: 'Weekly',
      utilization: 10,
    })
    expect(out.windows[0]?.resets_at).toBeTruthy()
    expect(out.credits?.has_credits).toBe(false)
  })

  test('accepts camelCase app-server style fields', () => {
    const out = parseCodexUsageResponse({
      planType: 'pro',
      rateLimits: {
        primary: {
          usedPercent: 5,
          resetsAt: 1_800_000_000,
          windowDurationMins: 300,
        },
      },
    })
    expect(out.plan_type).toBe('pro')
    expect(out.windows).toHaveLength(1)
    expect(out.windows[0]?.label).toBe('5-hour')
    expect(out.windows[0]?.utilization).toBe(5)
  })

  test('includes code review window when present', () => {
    const out = parseCodexUsageResponse({
      plan_type: 'plus',
      rate_limit: {},
      code_review_rate_limit: {
        primary_window: {
          used_percent: 3,
          reset_at: 1_800_000_000,
          limit_window_seconds: 7 * 24 * 3600,
        },
      },
    })
    expect(out.windows.some(w => w.label === 'Code review')).toBe(true)
  })

  test('returns empty windows for invalid payload', () => {
    expect(parseCodexUsageResponse(null).windows).toEqual([])
    expect(parseCodexUsageResponse('nope').windows).toEqual([])
  })
})

describe('providerBucketsToOpenAIUtilization', () => {
  test('converts 0–1 store utilization to 0–100', () => {
    const out = providerBucketsToOpenAIUtilization(
      [
        {
          kind: 'requests',
          label: 'RPM',
          utilization: 0.25,
          resetsAt: 1_800_000_000,
        },
      ],
      'openai',
    )
    expect(out.source).toBe('api_headers')
    expect(out.windows[0]?.utilization).toBeCloseTo(25, 5)
    expect(out.windows[0]?.label).toBe('RPM')
    expect(out.windows[0]?.resets_at).toBeTruthy()
  })

  test('empty buckets → source none', () => {
    const out = providerBucketsToOpenAIUtilization([], 'openai')
    expect(out.source).toBe('none')
    expect(out.windows).toEqual([])
  })
})

describe('openaiAdapter codex headers', () => {
  test('parses x-codex primary/secondary plan headers', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '40',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '600',
      'x-codex-secondary-used-percent': '21',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '86400',
    })
    const out = openaiAdapter.parseHeaders(h)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      kind: 'session',
      label: '5-hour',
      utilization: 0.4,
    })
    expect(out[1]).toMatchObject({
      kind: 'weekly',
      label: 'Weekly',
      utilization: 0.21,
    })
    expect(out[0]?.resetsAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('prefers codex headers over x-ratelimit when both present', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '10',
      'x-codex-primary-window-minutes': '300',
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '250',
    })
    const out = openaiAdapter.parseHeaders(h)
    expect(out).toHaveLength(1)
    expect(out[0]?.label).toBe('5-hour')
  })
})

describe('shouldShowOpenAIUsage', () => {
  const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  const originalAuthMode = process.env.OPENAI_AUTH_MODE

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_AUTH_MODE
    resetProviderUsage()
  })

  test('true when OPENAI_AUTH_MODE=chatgpt', () => {
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    expect(shouldShowOpenAIUsage()).toBe(true)
  })

  test('true when CLAUDE_CODE_USE_OPENAI=1', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(shouldShowOpenAIUsage()).toBe(true)
  })

  // Note: when neither env is set, result depends on settings.modelType
  // (true if user configured OpenAI). Only assert the positive env paths above.

  // restore env after suite
  test('cleanup env', () => {
    if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
    if (originalAuthMode === undefined) delete process.env.OPENAI_AUTH_MODE
    else process.env.OPENAI_AUTH_MODE = originalAuthMode
    expect(true).toBe(true)
  })
})

describe('fetchOpenAIUtilization header fallback', () => {
  test('returns stored buckets when not ChatGPT auth', async () => {
    const prev = process.env.OPENAI_AUTH_MODE
    const prevOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_AUTH_MODE
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    resetProviderUsage()
    updateProviderBuckets('openai', [
      { kind: 'tokens', label: 'TPM', utilization: 0.5 },
    ])

    // Re-import path uses live env; call exported fetchOpenAIUtilization
    const { fetchOpenAIUtilization } = await import('../usage.js')
    const out = await fetchOpenAIUtilization()
    expect(out.source).toBe('api_headers')
    expect(out.windows[0]?.label).toBe('TPM')
    expect(out.windows[0]?.utilization).toBeCloseTo(50, 5)

    if (prev === undefined) delete process.env.OPENAI_AUTH_MODE
    else process.env.OPENAI_AUTH_MODE = prev
    if (prevOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = prevOpenAI
  })
})
