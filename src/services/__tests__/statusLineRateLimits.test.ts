/**
 * Unit tests for status-line rate limit resolution.
 *
 * Pure mappers + cache priority. Prefetch is tested via injected deps
 * (no process-global mock.module of api/usage or openai/usage).
 */

import { describe, test, expect, beforeEach } from 'bun:test'

import { debugMock } from '../../../tests/mocks/debug.js'
import { mock } from 'bun:test'
mock.module('src/utils/debug.ts', debugMock)

import {
  ensureStatusLineUsagePrefetch,
  getStatusLineUsageCacheForTests,
  rateLimitsFromClaudeUtilization,
  rateLimitsFromOpenAIUtilization,
  rateLimitsFromProviderBuckets,
  rateLimitsFromRawUtilization,
  resetStatusLineUsageCache,
  resolveStatusLineRateLimits,
  setStatusLineUsageCache,
  setStatusLineUsageFromClaude,
  setStatusLineUsageFromOpenAI,
  STATUS_LINE_USAGE_TTL_MS,
  toBuiltinRateLimits,
} from '../statusLineRateLimits.js'

describe('rateLimitsFromRawUtilization', () => {
  test('converts 0–1 fraction to used_percentage', () => {
    const out = rateLimitsFromRawUtilization({
      five_hour: { utilization: 0.25, resets_at: 1_800_000_000 },
      seven_day: { utilization: 0.41, resets_at: 1_800_100_000 },
    })
    expect(out.five_hour?.used_percentage).toBeCloseTo(25, 5)
    expect(out.seven_day?.used_percentage).toBeCloseTo(41, 5)
    expect(out.five_hour?.resets_at).toBe(1_800_000_000)
  })
})

describe('rateLimitsFromProviderBuckets', () => {
  test('maps session/weekly kinds to five_hour/seven_day', () => {
    const out = rateLimitsFromProviderBuckets([
      {
        kind: 'session',
        label: '5-hour',
        utilization: 0.3,
        resetsAt: 1_800_000_000,
      },
      {
        kind: 'weekly',
        label: 'Weekly',
        utilization: 0.5,
        resetsAt: 1_800_100_000,
      },
    ])
    expect(out.five_hour?.used_percentage).toBeCloseTo(30, 5)
    expect(out.seven_day?.used_percentage).toBeCloseTo(50, 5)
  })

  test('ignores RPM/TPM request/token buckets', () => {
    const out = rateLimitsFromProviderBuckets([
      { kind: 'requests', label: 'RPM', utilization: 0.9 },
      { kind: 'tokens', label: 'TPM', utilization: 0.8 },
    ])
    expect(out.five_hour).toBeUndefined()
    expect(out.seven_day).toBeUndefined()
  })
})

describe('rateLimitsFromClaudeUtilization', () => {
  test('maps ISO resets_at to unix seconds', () => {
    const out = rateLimitsFromClaudeUtilization({
      five_hour: {
        utilization: 25,
        resets_at: '2027-01-15T12:00:00.000Z',
      },
      seven_day: {
        utilization: 41,
        resets_at: '2027-01-20T12:00:00.000Z',
      },
    })
    expect(out.five_hour?.used_percentage).toBe(25)
    expect(out.seven_day?.used_percentage).toBe(41)
    expect(out.five_hour?.resets_at).toBe(
      Math.floor(Date.parse('2027-01-15T12:00:00.000Z') / 1000),
    )
  })

  test('skips null utilization windows', () => {
    const out = rateLimitsFromClaudeUtilization({
      five_hour: { utilization: null, resets_at: null },
    })
    expect(out.five_hour).toBeUndefined()
  })
})

describe('rateLimitsFromOpenAIUtilization', () => {
  test('maps 5-hour and Weekly windows', () => {
    const out = rateLimitsFromOpenAIUtilization({
      source: 'chatgpt',
      windows: [
        {
          label: '5-hour',
          utilization: 42.5,
          resets_at: '2027-01-15T12:00:00.000Z',
          window_seconds: 5 * 3600,
        },
        {
          label: 'Weekly',
          utilization: 10,
          resets_at: '2027-01-20T12:00:00.000Z',
          window_seconds: 7 * 24 * 3600,
        },
      ],
    })
    expect(out.five_hour?.used_percentage).toBeCloseTo(42.5, 5)
    expect(out.seven_day?.used_percentage).toBeCloseTo(10, 5)
  })

  test('skips Code review and RPM windows', () => {
    const out = rateLimitsFromOpenAIUtilization({
      source: 'api_headers',
      windows: [
        { label: 'Code review', utilization: 3, resets_at: null },
        { label: 'RPM', utilization: 50, resets_at: null },
      ],
    })
    expect(out.five_hour).toBeUndefined()
    expect(out.seven_day).toBeUndefined()
  })

  test('classifies by window_seconds when label is Primary/Secondary', () => {
    const out = rateLimitsFromOpenAIUtilization({
      source: 'chatgpt',
      windows: [
        {
          label: 'Primary',
          utilization: 1,
          resets_at: null,
          window_seconds: 5 * 3600,
        },
        {
          label: 'Secondary',
          utilization: 2,
          resets_at: null,
          window_seconds: 7 * 24 * 3600,
        },
      ],
    })
    expect(out.five_hour?.used_percentage).toBe(1)
    expect(out.seven_day?.used_percentage).toBe(2)
  })
})

describe('resolveStatusLineRateLimits priority', () => {
  test('prefers Anthropic raw headers over provider and cache', () => {
    const out = resolveStatusLineRateLimits({
      raw: { five_hour: { utilization: 0.11, resets_at: 100 } },
      buckets: [
        {
          kind: 'session',
          label: '5-hour',
          utilization: 0.99,
          resetsAt: 200,
        },
      ],
      cache: {
        rateLimits: {
          five_hour: { used_percentage: 88, resets_at: 300 },
        },
        fetchedAt: Date.now(),
        source: 'openai_api',
      },
      now: Date.now(),
    })
    expect(out?.five_hour?.used_percentage).toBeCloseTo(11, 5)
    expect(out?.five_hour?.resets_at).toBe(100)
  })

  test('uses provider Codex plan buckets when Anthropic empty', () => {
    const out = resolveStatusLineRateLimits({
      raw: {},
      buckets: [
        {
          kind: 'session',
          label: '5-hour',
          utilization: 0.25,
          resetsAt: 1_800_000_000,
        },
        {
          kind: 'weekly',
          label: 'Weekly',
          utilization: 0.41,
          resetsAt: 1_800_100_000,
        },
      ],
      cache: null,
      now: Date.now(),
    })
    expect(out?.five_hour?.used_percentage).toBeCloseTo(25, 5)
    expect(out?.seven_day?.used_percentage).toBeCloseTo(41, 5)
  })

  test('falls back to /usage cache when no live headers', () => {
    const now = Date.now()
    const out = resolveStatusLineRateLimits({
      raw: {},
      buckets: [],
      cache: {
        rateLimits: {
          five_hour: { used_percentage: 33, resets_at: 1 },
          seven_day: { used_percentage: 44, resets_at: 2 },
        },
        fetchedAt: now,
        source: 'claude_api',
      },
      now,
    })
    expect(out?.five_hour?.used_percentage).toBe(33)
    expect(out?.seven_day?.used_percentage).toBe(44)
  })

  test('returns undefined when nothing available', () => {
    expect(
      resolveStatusLineRateLimits({
        raw: {},
        buckets: [],
        cache: null,
        now: Date.now(),
      }),
    ).toBeUndefined()
  })

  test('stale cache still returned', () => {
    const now = Date.now()
    const out = resolveStatusLineRateLimits({
      raw: {},
      buckets: [],
      cache: {
        rateLimits: {
          five_hour: { used_percentage: 9, resets_at: 1 },
        },
        fetchedAt: now - STATUS_LINE_USAGE_TTL_MS - 1000,
        source: 'claude_api',
      },
      now,
    })
    expect(out?.five_hour?.used_percentage).toBe(9)
  })
})

describe('toBuiltinRateLimits', () => {
  test('converts 0–100 to 0–1', () => {
    const out = toBuiltinRateLimits({
      five_hour: { used_percentage: 25, resets_at: 99 },
    })
    expect(out.five_hour?.utilization).toBeCloseTo(0.25, 5)
    expect(out.five_hour?.resets_at).toBe(99)
  })

  test('empty for undefined', () => {
    expect(toBuiltinRateLimits(undefined)).toEqual({})
  })
})

describe('setStatusLineUsageFromOpenAI cache', () => {
  beforeEach(() => {
    resetStatusLineUsageCache()
  })

  test('stores mapped windows', () => {
    setStatusLineUsageFromOpenAI({
      source: 'chatgpt',
      plan_type: 'plus',
      windows: [
        {
          label: '5-hour',
          utilization: 12,
          resets_at: '2027-01-01T00:00:00.000Z',
          window_seconds: 5 * 3600,
        },
      ],
    })
    const cached = getStatusLineUsageCacheForTests()
    expect(cached?.source).toBe('openai_api')
    expect(cached?.rateLimits.five_hour?.used_percentage).toBe(12)
  })

  test('setStatusLineUsageCache ignores empty', () => {
    setStatusLineUsageCache({}, 'manual')
    expect(getStatusLineUsageCacheForTests()).toBeNull()
  })
})

describe('ensureStatusLineUsagePrefetch (injected deps)', () => {
  beforeEach(() => {
    resetStatusLineUsageCache()
  })

  test('skips network when provider buckets already present', async () => {
    let fetchCalls = 0
    const updated = await ensureStatusLineUsagePrefetch(Date.now(), {
      getRaw: () => ({}),
      getBuckets: () => [
        { kind: 'session', label: '5-hour', utilization: 0.1 },
      ],
      shouldShowOpenAI: () => true,
      fetchOpenAI: async () => {
        fetchCalls++
        return { source: 'chatgpt', windows: [] }
      },
    })
    expect(updated).toBe(false)
    expect(fetchCalls).toBe(0)
  })

  test('fetches OpenAI usage and caches when ChatGPT path active', async () => {
    const updated = await ensureStatusLineUsagePrefetch(Date.now(), {
      getRaw: () => ({}),
      getBuckets: () => [],
      shouldShowOpenAI: () => true,
      shouldPrefetchClaude: () => false,
      fetchOpenAI: async () => ({
        source: 'chatgpt',
        windows: [
          {
            label: '5-hour',
            utilization: 25,
            resets_at: '2027-01-15T12:00:00.000Z',
            window_seconds: 5 * 3600,
          },
          {
            label: 'Weekly',
            utilization: 41,
            resets_at: '2027-01-20T12:00:00.000Z',
            window_seconds: 7 * 24 * 3600,
          },
        ],
      }),
    })
    expect(updated).toBe(true)

    // Live getStatusLineRateLimits may still be empty if process has no
    // provider data — read cache directly.
    const cached = getStatusLineUsageCacheForTests()
    expect(cached?.rateLimits.five_hour?.used_percentage).toBe(25)
    expect(cached?.rateLimits.seven_day?.used_percentage).toBe(41)
  })

  test('fetches Claude usage when subscriber path active', async () => {
    const updated = await ensureStatusLineUsagePrefetch(Date.now(), {
      getRaw: () => ({}),
      getBuckets: () => [],
      shouldShowOpenAI: () => false,
      shouldPrefetchClaude: () => true,
      fetchClaude: async () => ({
        five_hour: {
          utilization: 15,
          resets_at: '2027-02-01T00:00:00.000Z',
        },
        seven_day: {
          utilization: 20,
          resets_at: '2027-02-07T00:00:00.000Z',
        },
      }),
    })
    expect(updated).toBe(true)
    expect(
      getStatusLineUsageCacheForTests()?.rateLimits.five_hour?.used_percentage,
    ).toBe(15)
  })

  test('does not refetch within TTL', async () => {
    let fetchCalls = 0
    const deps = {
      getRaw: () => ({}),
      getBuckets: () =>
        [] as Array<{
          kind:
            | 'session'
            | 'weekly'
            | 'requests'
            | 'tokens'
            | 'throttle'
            | 'custom'
          label: string
          utilization: number
          resetsAt?: number
        }>,
      shouldShowOpenAI: () => true,
      shouldPrefetchClaude: () => false,
      fetchOpenAI: async () => {
        fetchCalls++
        return {
          source: 'chatgpt' as const,
          windows: [
            {
              label: '5-hour',
              utilization: 1,
              resets_at: null,
              window_seconds: 5 * 3600,
            },
          ],
        }
      },
    }
    expect(await ensureStatusLineUsagePrefetch(Date.now(), deps)).toBe(true)
    expect(await ensureStatusLineUsagePrefetch(Date.now(), deps)).toBe(false)
    expect(fetchCalls).toBe(1)
  })

  test('returns false when neither provider is eligible', async () => {
    const updated = await ensureStatusLineUsagePrefetch(Date.now(), {
      getRaw: () => ({}),
      getBuckets: () => [],
      shouldShowOpenAI: () => false,
      shouldPrefetchClaude: () => false,
    })
    expect(updated).toBe(false)
  })
})
