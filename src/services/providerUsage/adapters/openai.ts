import type { ProviderUsageAdapter, ProviderUsageBucket } from '../types.js'

/**
 * Parse a Retry-After-style duration string (e.g. "6m0s", "1h30m", "500ms")
 * into unix epoch seconds *from now*. Returns 0 if unparseable.
 */
function parseResetAt(value: string | null): number {
  if (!value) return 0
  let seconds = 0
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    const n = Number(match[1])
    const unit = match[2]
    switch (unit) {
      case 'ms':
        seconds += n / 1000
        break
      case 's':
        seconds += n
        break
      case 'm':
        seconds += n * 60
        break
      case 'h':
        seconds += n * 3600
        break
      case 'd':
        seconds += n * 86400
        break
    }
  }
  if (seconds === 0) {
    const n = Number(value)
    if (Number.isFinite(n)) seconds = n
  }
  if (seconds <= 0) return 0
  return Math.floor(Date.now() / 1000) + seconds
}

function computeUtilization(
  remaining: string | null,
  limit: string | null,
): number | null {
  if (remaining === null || limit === null) return null
  const r = Number(remaining)
  const l = Number(limit)
  if (!Number.isFinite(r) || !Number.isFinite(l) || l <= 0) return null
  const used = Math.max(0, l - r)
  return Math.min(1, Math.max(0, used / l))
}

/**
 * Classify Codex primary/secondary window duration (minutes) into a label.
 */
function codexWindowLabel(
  kind: 'primary' | 'secondary',
  windowMinutes: string | null,
): string {
  const mins = windowMinutes !== null ? Number(windowMinutes) : NaN
  if (Number.isFinite(mins) && mins > 0) {
    const seconds = mins * 60
    // Match codex-cli-usage tolerance (±10%).
    if (Math.abs(seconds - 5 * 3600) / (5 * 3600) <= 0.1) return '5-hour'
    if (Math.abs(seconds - 7 * 24 * 3600) / (7 * 24 * 3600) <= 0.1) {
      return 'Weekly'
    }
    if (Math.abs(seconds - 24 * 3600) / (24 * 3600) <= 0.1) return 'Daily'
  }
  return kind === 'primary' ? 'Primary' : 'Secondary'
}

/**
 * Parse ChatGPT Codex plan-limit headers returned by
 * chatgpt.com/backend-api/codex/responses.
 *
 *   x-codex-primary-used-percent / window-minutes / reset-after-seconds
 *   x-codex-secondary-used-percent / ...
 *
 * Utilization is 0–100 in headers; we normalize to 0–1 for the store.
 */
function parseCodexPlanHeaders(headers: Headers): ProviderUsageBucket[] {
  const buckets: ProviderUsageBucket[] = []
  for (const kind of ['primary', 'secondary'] as const) {
    const used = headers.get(`x-codex-${kind}-used-percent`)
    if (used === null) continue
    const pct = Number(used)
    if (!Number.isFinite(pct)) continue
    const resetAfter = headers.get(`x-codex-${kind}-reset-after-seconds`)
    const resetSecs = resetAfter !== null ? Number(resetAfter) : NaN
    const windowMinutes = headers.get(`x-codex-${kind}-window-minutes`)
    buckets.push({
      kind: kind === 'primary' ? 'session' : 'weekly',
      label: codexWindowLabel(kind, windowMinutes),
      utilization: Math.min(1, Math.max(0, pct / 100)),
      ...(Number.isFinite(resetSecs) && resetSecs > 0
        ? { resetsAt: Math.floor(Date.now() / 1000) + Math.floor(resetSecs) }
        : {}),
    })
  }
  return buckets
}

/**
 * OpenAI-compatible rate-limit headers + ChatGPT Codex plan headers.
 *
 * Standard OpenAI-compatible:
 *   x-ratelimit-limit-requests     / x-ratelimit-remaining-requests     / x-ratelimit-reset-requests
 *   x-ratelimit-limit-tokens       / x-ratelimit-remaining-tokens       / x-ratelimit-reset-tokens
 *
 * Codex Responses (ChatGPT OAuth):
 *   x-codex-primary-* / x-codex-secondary-*
 *
 * Works for OpenAI, DeepSeek, Moonshot, Grok (xAI) and many self-hosted
 * OpenAI-compatible gateways. Codex plan headers take priority when present.
 */
export const openaiAdapter: ProviderUsageAdapter = {
  providerId: 'openai',
  parseHeaders(headers): ProviderUsageBucket[] {
    // Prefer Codex plan windows when present (ChatGPT subscription traffic).
    const codex = parseCodexPlanHeaders(headers)
    if (codex.length > 0) return codex

    const buckets: ProviderUsageBucket[] = []

    const reqUtil = computeUtilization(
      headers.get('x-ratelimit-remaining-requests'),
      headers.get('x-ratelimit-limit-requests'),
    )
    if (reqUtil !== null) {
      buckets.push({
        kind: 'requests',
        label: 'RPM',
        utilization: reqUtil,
        resetsAt:
          parseResetAt(headers.get('x-ratelimit-reset-requests')) || undefined,
      })
    }

    const tokUtil = computeUtilization(
      headers.get('x-ratelimit-remaining-tokens'),
      headers.get('x-ratelimit-limit-tokens'),
    )
    if (tokUtil !== null) {
      buckets.push({
        kind: 'tokens',
        label: 'TPM',
        utilization: tokUtil,
        resetsAt:
          parseResetAt(headers.get('x-ratelimit-reset-tokens')) || undefined,
      })
    }

    return buckets
  },
}
