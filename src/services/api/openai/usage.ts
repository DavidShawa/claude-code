/**
 * OpenAI / ChatGPT plan usage.
 *
 * ChatGPT OAuth (Codex Responses path) exposes plan quotas via:
 *   GET https://chatgpt.com/backend-api/codex/usage
 *
 * API-key / OpenAI-compatible path falls back to response headers already
 * stored in providerUsage (RPM/TPM from x-ratelimit-*).
 *
 * Claude.ai subscription usage lives in services/api/usage.ts — keep them
 * separate so this module never touches Anthropic OAuth.
 */

import { getValidChatGPTAuth, isChatGPTAuthEnabled } from './chatgptAuth.js'
import { getProviderUsage } from '../../providerUsage/store.js'
import type { ProviderUsageBucket } from '../../providerUsage/types.js'
import { getAPIProvider } from '../../../utils/model/providers.js'
import { logForDebugging } from '../../../utils/debug.js'

export type OpenAIRateLimit = {
  /** Percentage used, 0–100. */
  utilization: number | null
  /** ISO 8601 timestamp when the window resets. */
  resets_at: string | null
  /** Window length in seconds when known. */
  window_seconds?: number | null
  /** Display label (e.g. "5-hour", "Weekly", "RPM"). */
  label: string
}

export type OpenAICredits = {
  has_credits: boolean
  balance?: number | null
  unlimited?: boolean
}

export type OpenAIUtilization = {
  source: 'chatgpt' | 'api_headers' | 'none'
  plan_type?: string | null
  windows: OpenAIRateLimit[]
  credits?: OpenAICredits | null
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/codex/usage'

type CodexWindowRaw = {
  used_percent?: unknown
  usedPercent?: unknown
  reset_at?: unknown
  resetsAt?: unknown
  limit_window_seconds?: unknown
  limitWindowSeconds?: unknown
  windowDurationMins?: unknown
}

type CodexRateLimitRaw = {
  primary_window?: CodexWindowRaw
  secondary_window?: CodexWindowRaw
  primary?: CodexWindowRaw
  secondary?: CodexWindowRaw
}

type CodexUsageResponse = {
  plan_type?: unknown
  planType?: unknown
  rate_limit?: CodexRateLimitRaw
  rateLimits?: CodexRateLimitRaw
  code_review_rate_limit?: { primary_window?: CodexWindowRaw }
  credits?: {
    has_credits?: unknown
    hasCredits?: unknown
    balance?: unknown
    unlimited?: unknown
  }
}

const WINDOW_LABELS: Array<{
  key: string
  label: string
  seconds: number
}> = [
  { key: '5h', label: '5-hour', seconds: 5 * 3600 },
  { key: 'daily', label: 'Daily', seconds: 24 * 3600 },
  { key: 'weekly', label: 'Weekly', seconds: 7 * 24 * 3600 },
  { key: 'monthly', label: 'Monthly', seconds: 30 * 24 * 3600 },
  { key: 'annual', label: 'Annual', seconds: 365 * 24 * 3600 },
]

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Classify a window duration into a stable display label.
 * Falls back to Primary / Secondary when duration is unknown.
 */
export function classifyWindowLabel(
  seconds: number | null | undefined,
  kind: 'primary' | 'secondary' | string,
): string {
  if (typeof seconds === 'number' && seconds > 0) {
    for (const entry of WINDOW_LABELS) {
      if (Math.abs(seconds - entry.seconds) / entry.seconds <= 0.1) {
        return entry.label
      }
    }
  }
  if (kind === 'primary') return 'Primary'
  if (kind === 'secondary') return 'Secondary'
  return kind
}

function windowSecondsFromRaw(raw: CodexWindowRaw): number | null {
  const direct = asNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds)
  if (direct !== null && direct > 0) return direct
  const mins = asNumber(raw.windowDurationMins)
  if (mins !== null && mins > 0) return mins * 60
  return null
}

function usedPercentFromRaw(raw: CodexWindowRaw): number | null {
  return asNumber(raw.used_percent ?? raw.usedPercent)
}

function resetAtIsoFromRaw(raw: CodexWindowRaw): string | null {
  const reset = asNumber(raw.reset_at ?? raw.resetsAt)
  if (reset === null || reset <= 0) return null
  // API returns unix seconds; guard against ms just in case.
  const seconds = reset > 1e12 ? Math.floor(reset / 1000) : Math.floor(reset)
  return new Date(seconds * 1000).toISOString()
}

function parseWindow(
  raw: CodexWindowRaw | undefined,
  kind: 'primary' | 'secondary' | string,
  fallbackLabel?: string,
): OpenAIRateLimit | null {
  if (!raw || typeof raw !== 'object') return null
  const utilization = usedPercentFromRaw(raw)
  if (utilization === null) return null
  const windowSeconds = windowSecondsFromRaw(raw)
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    resets_at: resetAtIsoFromRaw(raw),
    window_seconds: windowSeconds,
    label: fallbackLabel ?? classifyWindowLabel(windowSeconds, kind),
  }
}

/**
 * Transform a raw Codex usage API response into UI-friendly windows.
 * Exported for unit tests.
 */
export function parseCodexUsageResponse(data: unknown): OpenAIUtilization {
  if (!data || typeof data !== 'object') {
    return { source: 'chatgpt', windows: [] }
  }
  const body = data as CodexUsageResponse
  const plan =
    typeof body.plan_type === 'string'
      ? body.plan_type
      : typeof body.planType === 'string'
        ? body.planType
        : null

  const rl = body.rate_limit ?? body.rateLimits ?? {}
  const windows: OpenAIRateLimit[] = []

  const primary = parseWindow(rl.primary_window ?? rl.primary, 'primary')
  if (primary) windows.push(primary)

  const secondary = parseWindow(
    rl.secondary_window ?? rl.secondary,
    'secondary',
  )
  if (secondary) windows.push(secondary)

  const codeReview = parseWindow(
    body.code_review_rate_limit?.primary_window,
    'primary',
    'Code review',
  )
  if (codeReview) windows.push(codeReview)

  let credits: OpenAICredits | null = null
  if (body.credits && typeof body.credits === 'object') {
    const has =
      asBool(body.credits.has_credits) ??
      asBool(body.credits.hasCredits) ??
      false
    credits = {
      has_credits: has,
      balance: asNumber(body.credits.balance),
      unlimited: asBool(body.credits.unlimited),
    }
  }

  return {
    source: 'chatgpt',
    plan_type: plan,
    windows,
    credits,
  }
}

/**
 * Map providerUsage buckets (RPM/TPM / codex headers) into the same UI shape.
 */
export function providerBucketsToOpenAIUtilization(
  buckets: ProviderUsageBucket[],
  providerId: string,
): OpenAIUtilization {
  const windows: OpenAIRateLimit[] = buckets.map(b => ({
    // Store keeps 0–1; UI bars expect 0–100.
    utilization: Number.isFinite(b.utilization)
      ? Math.min(100, Math.max(0, b.utilization * 100))
      : null,
    resets_at:
      typeof b.resetsAt === 'number' && b.resetsAt > 0
        ? new Date(b.resetsAt * 1000).toISOString()
        : null,
    label: b.label,
  }))
  return {
    source: windows.length > 0 ? 'api_headers' : 'none',
    plan_type: providerId === 'unknown' ? null : providerId,
    windows,
  }
}

/**
 * Fetch ChatGPT/Codex plan usage for the logged-in account.
 */
export async function fetchChatGPTUtilization(): Promise<OpenAIUtilization> {
  const auth = await getValidChatGPTAuth()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (compatible; claude-code-best; +https://github.com)',
  }
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId
    headers['chatgpt-account-id'] = auth.accountId
  }

  const response = await fetch(CODEX_USAGE_URL, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `ChatGPT usage request failed (${response.status})${
        text ? `: ${text.slice(0, 300)}` : ''
      }`,
    )
  }

  const data: unknown = await response.json()
  return parseCodexUsageResponse(data)
}

/**
 * Resolve OpenAI-side utilization for the /usage panel.
 *
 * Priority:
 *   1. ChatGPT OAuth → Codex usage API (plan 5h / 7d windows)
 *   2. API key / compatible → last response rate-limit headers
 *   3. Empty (caller may still show session cost)
 */
export async function fetchOpenAIUtilization(): Promise<OpenAIUtilization> {
  if (isChatGPTAuthEnabled()) {
    try {
      return await fetchChatGPTUtilization()
    } catch (err) {
      logForDebugging(
        `[OpenAI usage] ChatGPT usage fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      // Fall through to header-based snapshot if a recent request filled the store.
      const snapshot = getProviderUsage()
      if (snapshot.buckets.length > 0) {
        return providerBucketsToOpenAIUtilization(
          snapshot.buckets,
          snapshot.providerId,
        )
      }
      throw err
    }
  }

  const snapshot = getProviderUsage()
  if (snapshot.buckets.length > 0) {
    return providerBucketsToOpenAIUtilization(
      snapshot.buckets,
      snapshot.providerId,
    )
  }

  return { source: 'none', windows: [], plan_type: null }
}

/** True when the active provider should use the OpenAI usage panel. */
export function shouldShowOpenAIUsage(): boolean {
  if (isChatGPTAuthEnabled()) return true
  return getAPIProvider() === 'openai'
}
