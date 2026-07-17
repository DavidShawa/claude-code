/**
 * Resolve plan-usage rate limits for the status line.
 *
 * Sources (priority high → low):
 * 1. Anthropic response headers via getRawUtilization() — freshest for Claude.ai
 * 2. Provider usage store (Codex x-codex-* / Anthropic adapter buckets after a request)
 * 3. Short-TTL cache populated by /usage or background prefetch
 *
 * Never blocks the render path. Prefetch is fire-and-forget; callers may
 * re-render when the promise resolves.
 */

import { getRawUtilization } from './claudeAiLimits.js'
import { fetchUtilization, type Utilization } from './api/usage.js'
import {
  fetchOpenAIUtilization,
  shouldShowOpenAIUsage,
  type OpenAIUtilization,
} from './api/openai/usage.js'
import { getProviderUsage } from './providerUsage/store.js'
import type { ProviderUsageBucket } from './providerUsage/types.js'
import type { StatusLineCommandInput } from '../types/statusLine.js'
import { isClaudeAISubscriber, hasProfileScope } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'

export type StatusLineRateLimits = NonNullable<
  StatusLineCommandInput['rate_limits']
>

export type StatusLineUsageCacheSource = 'claude_api' | 'openai_api' | 'manual'

type CacheEntry = {
  rateLimits: StatusLineRateLimits
  fetchedAt: number
  source: StatusLineUsageCacheSource
}

/** Default TTL for /usage-style API results used by the status line. */
export const STATUS_LINE_USAGE_TTL_MS = 60_000

let cache: CacheEntry | null = null
let inflight: Promise<boolean> | null = null

const FIVE_HOUR_SECONDS = 5 * 3600
const SEVEN_DAY_SECONDS = 7 * 24 * 3600

function isApproxSeconds(
  value: number | null | undefined,
  target: number,
): boolean {
  if (typeof value !== 'number' || value <= 0) return false
  return Math.abs(value - target) / target <= 0.1
}

function hasAny(limits: StatusLineRateLimits): boolean {
  return limits.five_hour != null || limits.seven_day != null
}

function isoToUnixSeconds(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 0
  return Math.floor(ms / 1000)
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Convert Anthropic 0–1 raw utilization into status-line shape. */
export function rateLimitsFromRawUtilization(
  raw: ReturnType<typeof getRawUtilization>,
): StatusLineRateLimits {
  const out: StatusLineRateLimits = {}
  if (raw.five_hour) {
    out.five_hour = {
      used_percentage: clampPct(raw.five_hour.utilization * 100),
      resets_at: raw.five_hour.resets_at,
    }
  }
  if (raw.seven_day) {
    out.seven_day = {
      used_percentage: clampPct(raw.seven_day.utilization * 100),
      resets_at: raw.seven_day.resets_at,
    }
  }
  return out
}

/**
 * Map providerUsage plan windows (session / weekly) to status-line keys.
 * Intentionally ignores RPM/TPM (kind requests/tokens) — those are not
 * account 5h/7d quotas.
 */
export function rateLimitsFromProviderBuckets(
  buckets: ProviderUsageBucket[],
): StatusLineRateLimits {
  const out: StatusLineRateLimits = {}
  for (const b of buckets) {
    const label = b.label.toLowerCase()
    const isFiveHour =
      b.kind === 'session' ||
      label === '5-hour' ||
      label === '5h' ||
      /^5[\s-]?h/.test(label)
    const isSevenDay =
      b.kind === 'weekly' ||
      label === 'weekly' ||
      label === '7d' ||
      /^7[\s-]?d/.test(label)

    if (isFiveHour && !out.five_hour) {
      out.five_hour = {
        used_percentage: clampPct(b.utilization * 100),
        resets_at: b.resetsAt ?? 0,
      }
    } else if (isSevenDay && !out.seven_day) {
      out.seven_day = {
        used_percentage: clampPct(b.utilization * 100),
        resets_at: b.resetsAt ?? 0,
      }
    }
  }
  return out
}

/** Claude.ai /oauth/usage → status-line rate_limits. */
export function rateLimitsFromClaudeUtilization(
  util: Utilization,
): StatusLineRateLimits {
  const out: StatusLineRateLimits = {}
  if (util.five_hour && util.five_hour.utilization != null) {
    out.five_hour = {
      used_percentage: clampPct(util.five_hour.utilization),
      resets_at: isoToUnixSeconds(util.five_hour.resets_at),
    }
  }
  if (util.seven_day && util.seven_day.utilization != null) {
    out.seven_day = {
      used_percentage: clampPct(util.seven_day.utilization),
      resets_at: isoToUnixSeconds(util.seven_day.resets_at),
    }
  }
  return out
}

/**
 * ChatGPT / OpenAI utilization windows → status-line rate_limits.
 * Uses window duration and known labels; skips Code review / RPM / TPM.
 */
export function rateLimitsFromOpenAIUtilization(
  util: OpenAIUtilization,
): StatusLineRateLimits {
  const out: StatusLineRateLimits = {}
  for (const w of util.windows) {
    if (w.utilization == null) continue
    const label = w.label.toLowerCase()
    if (label.includes('code review') || label === 'rpm' || label === 'tpm') {
      continue
    }

    let key: 'five_hour' | 'seven_day' | null = null
    if (
      label === '5-hour' ||
      label === '5h' ||
      isApproxSeconds(w.window_seconds, FIVE_HOUR_SECONDS)
    ) {
      key = 'five_hour'
    } else if (
      label === 'weekly' ||
      label === '7d' ||
      isApproxSeconds(w.window_seconds, SEVEN_DAY_SECONDS)
    ) {
      key = 'seven_day'
    } else if (label === 'primary' && !out.five_hour) {
      // Codex primary without duration is almost always the 5h window.
      key = 'five_hour'
    } else if (label === 'secondary' && !out.seven_day) {
      key = 'seven_day'
    }

    if (key && !out[key]) {
      out[key] = {
        used_percentage: clampPct(w.utilization),
        resets_at: isoToUnixSeconds(w.resets_at),
      }
    }
  }
  return out
}

function isCacheFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.fetchedAt < STATUS_LINE_USAGE_TTL_MS
}

/**
 * Pure priority merge for status-line rate limits (testable without module mocks).
 */
export function resolveStatusLineRateLimits(input: {
  raw: ReturnType<typeof getRawUtilization>
  buckets: ProviderUsageBucket[]
  cache: CacheEntry | null
  now: number
}): StatusLineRateLimits | undefined {
  const fromAnthropic = rateLimitsFromRawUtilization(input.raw)
  if (hasAny(fromAnthropic)) return fromAnthropic

  const fromProvider = rateLimitsFromProviderBuckets(input.buckets)
  if (hasAny(fromProvider)) return fromProvider

  if (
    input.cache &&
    hasAny(input.cache.rateLimits) &&
    isCacheFresh(input.cache, input.now)
  ) {
    return input.cache.rateLimits
  }

  // Stale cache is better than empty (usage still useful until next refresh).
  if (input.cache && hasAny(input.cache.rateLimits)) {
    return input.cache.rateLimits
  }

  return undefined
}

/**
 * Synchronous snapshot for status-line stdin / BuiltinStatusLine.
 * Does not perform network I/O.
 */
export function getStatusLineRateLimits(
  now: number = Date.now(),
): StatusLineRateLimits | undefined {
  return resolveStatusLineRateLimits({
    raw: getRawUtilization(),
    buckets: getProviderUsage().buckets,
    cache,
    now,
  })
}

/**
 * Convert status-line shape (0–100) to BuiltinStatusLine shape (0–1).
 */
export function toBuiltinRateLimits(limits: StatusLineRateLimits | undefined): {
  five_hour?: { utilization: number; resets_at: number }
  seven_day?: { utilization: number; resets_at: number }
} {
  if (!limits) return {}
  return {
    ...(limits.five_hour && {
      five_hour: {
        utilization: limits.five_hour.used_percentage / 100,
        resets_at: limits.five_hour.resets_at,
      },
    }),
    ...(limits.seven_day && {
      seven_day: {
        utilization: limits.seven_day.used_percentage / 100,
        resets_at: limits.seven_day.resets_at,
      },
    }),
  }
}

export function setStatusLineUsageCache(
  rateLimits: StatusLineRateLimits,
  source: StatusLineUsageCacheSource,
  now: number = Date.now(),
): void {
  if (!hasAny(rateLimits)) return
  cache = { rateLimits, fetchedAt: now, source }
}

export function setStatusLineUsageFromClaude(
  util: Utilization,
  now: number = Date.now(),
): void {
  setStatusLineUsageCache(
    rateLimitsFromClaudeUtilization(util),
    'claude_api',
    now,
  )
}

export function setStatusLineUsageFromOpenAI(
  util: OpenAIUtilization,
  now: number = Date.now(),
): void {
  setStatusLineUsageCache(
    rateLimitsFromOpenAIUtilization(util),
    'openai_api',
    now,
  )
}

export function getStatusLineUsageCacheForTests(): CacheEntry | null {
  return cache
}

export function resetStatusLineUsageCache(): void {
  cache = null
  inflight = null
}

function shouldPrefetchClaude(): boolean {
  return isClaudeAISubscriber() && hasProfileScope()
}

/** Optional overrides for unit tests — avoids process-global mock.module. */
export type StatusLineUsagePrefetchDeps = {
  getRaw?: typeof getRawUtilization
  getBuckets?: () => ProviderUsageBucket[]
  shouldShowOpenAI?: () => boolean
  shouldPrefetchClaude?: () => boolean
  fetchOpenAI?: () => Promise<OpenAIUtilization>
  fetchClaude?: () => Promise<Utilization | null>
}

/**
 * Background-fetch plan usage when no live header/provider data is available.
 * Returns true if the cache was updated with usable rate limits.
 * Dedupes concurrent callers via a single inflight promise.
 */
export function ensureStatusLineUsagePrefetch(
  now: number = Date.now(),
  deps: StatusLineUsagePrefetchDeps = {},
): Promise<boolean> {
  const getRaw = deps.getRaw ?? getRawUtilization
  const getBuckets = deps.getBuckets ?? (() => getProviderUsage().buckets)
  const showOpenAI = deps.shouldShowOpenAI ?? shouldShowOpenAIUsage
  const prefetchClaude = deps.shouldPrefetchClaude ?? shouldPrefetchClaude
  const fetchOpenAI = deps.fetchOpenAI ?? fetchOpenAIUtilization
  const fetchClaude = deps.fetchClaude ?? fetchUtilization

  // Live data already present — no network needed.
  if (hasAny(rateLimitsFromRawUtilization(getRaw()))) {
    return Promise.resolve(false)
  }
  if (hasAny(rateLimitsFromProviderBuckets(getBuckets()))) {
    return Promise.resolve(false)
  }
  if (cache && hasAny(cache.rateLimits) && isCacheFresh(cache, now)) {
    return Promise.resolve(false)
  }

  const wantOpenAI = showOpenAI()
  const wantClaude = prefetchClaude()
  if (!wantOpenAI && !wantClaude) {
    return Promise.resolve(false)
  }

  if (inflight) return inflight

  inflight = (async (): Promise<boolean> => {
    try {
      if (wantOpenAI) {
        const util = await fetchOpenAI()
        const limits = rateLimitsFromOpenAIUtilization(util)
        if (hasAny(limits)) {
          setStatusLineUsageCache(limits, 'openai_api')
          return true
        }
        return false
      }

      const util = await fetchClaude()
      if (!util) return false
      const limits = rateLimitsFromClaudeUtilization(util)
      if (hasAny(limits)) {
        setStatusLineUsageCache(limits, 'claude_api')
        return true
      }
      return false
    } catch (err) {
      logForDebugging(
        `[statusLineRateLimits] prefetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return false
    } finally {
      inflight = null
    }
  })()

  return inflight
}
