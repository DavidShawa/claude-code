import * as React from 'react';
import { useEffect, useState } from 'react';
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js';
import {
  formatCost,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
} from 'src/cost-tracker.js';
import { getSubscriptionType } from 'src/utils/auth.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { type ExtraUsage, fetchUtilization, type RateLimit, type Utilization } from '../../services/api/usage.js';
import {
  type OpenAIUtilization,
  fetchOpenAIUtilization,
  shouldShowOpenAIUsage,
} from '../../services/api/openai/usage.js';
import { isChatGPTAuthEnabled } from '../../services/api/openai/chatgptAuth.js';
import { setStatusLineUsageFromClaude, setStatusLineUsageFromOpenAI } from '../../services/statusLineRateLimits.js';
import { formatNumber, formatResetText } from '../../utils/format.js';
import { logError } from '../../utils/log.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline, ProgressBar } from '@anthropic/ink';
import { isEligibleForOverageCreditGrant, OverageCreditUpsell } from '../LogoV2/OverageCreditUpsell.js';

type LimitBarProps = {
  title: string;
  limit: RateLimit;
  maxWidth: number;
  showTimeInReset?: boolean;
  extraSubtext?: string;
};

function LimitBar({ title, limit, maxWidth, showTimeInReset = true, extraSubtext }: LimitBarProps): React.ReactNode {
  const { utilization, resets_at } = limit;
  if (utilization === null) {
    return null;
  }

  // Calculate usage percentage
  const usedText = `${Math.floor(utilization)}% used`;

  let subtext: string | undefined;
  if (resets_at) {
    subtext = `Resets ${formatResetText(resets_at, true, showTimeInReset)}`;
  }

  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`;
    } else {
      subtext = extraSubtext;
    }
  }

  const maxBarWidth = 50;
  const usedLabelSpace = 12;
  if (maxWidth >= maxBarWidth + usedLabelSpace) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={utilization / 100}
            width={maxBarWidth}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text>{usedText}</Text>
        </Box>
        {subtext && <Text dimColor>{subtext}</Text>}
      </Box>
    );
  } else {
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{title}</Text>
          {subtext && (
            <>
              <Text> </Text>
              <Text dimColor>· {subtext}</Text>
            </>
          )}
        </Text>
        <ProgressBar
          ratio={utilization / 100}
          width={maxWidth}
          fillColor="rate_limit_fill"
          emptyColor="rate_limit_empty"
        />
        <Text>{usedText}</Text>
      </Box>
    );
  }
}

function SessionCostSummary(): React.ReactNode {
  const cost = getTotalCost();
  const input = getTotalInputTokens();
  const output = getTotalOutputTokens();
  const cacheRead = getTotalCacheReadInputTokens();
  const cacheWrite = getTotalCacheCreationInputTokens();
  return (
    <Box flexDirection="column">
      <Text bold>This session</Text>
      <Text dimColor>
        {formatCost(cost)} · {formatNumber(input)} in / {formatNumber(output)} out · {formatNumber(cacheRead)} cache
        read / {formatNumber(cacheWrite)} cache write
      </Text>
    </Box>
  );
}

function UsageFooter({ showRetry }: { showRetry?: boolean }): React.ReactNode {
  return (
    <Text dimColor>
      <Byline>
        {showRetry ? (
          <ConfigurableShortcutHint action="settings:retry" context="Settings" fallback="r" description="retry" />
        ) : null}
        <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
      </Byline>
    </Text>
  );
}

/**
 * OpenAI / ChatGPT plan usage panel.
 * Completely separate from Claude.ai subscription fetchUtilization().
 */
function OpenAIUsagePanel({ maxWidth }: { maxWidth: number }): React.ReactNode {
  const [utilization, setUtilization] = useState<OpenAIUtilization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isChatGPT = isChatGPTAuthEnabled();

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchOpenAIUtilization();
      setUtilization(data);
      // Keep status line in sync with the same /usage data the user just loaded.
      setStatusLineUsageFromOpenAI(data);
    } catch (err) {
      logError(err as Error);
      setError(err instanceof Error ? err.message : 'Failed to load OpenAI usage data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUtilization();
  }, [loadUtilization]);

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization();
    },
    { context: 'Settings', isActive: !!error && !isLoading },
  );

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <SessionCostSummary />
        <UsageFooter showRetry />
      </Box>
    );
  }

  if (!utilization || isLoading) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Loading OpenAI usage data…</Text>
        <UsageFooter />
      </Box>
    );
  }

  const hasWindows = utilization.windows.some(w => w.utilization !== null);
  const planLabel = utilization.plan_type ? `Plan: ${utilization.plan_type}` : null;

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {planLabel && <Text bold>{planLabel}</Text>}

      {hasWindows ? (
        utilization.windows.map(
          (window, index) =>
            window.utilization !== null && (
              <LimitBar
                key={`${window.label}-${index}`}
                title={window.label}
                limit={{
                  utilization: window.utilization,
                  resets_at: window.resets_at,
                }}
                maxWidth={maxWidth}
              />
            ),
        )
      ) : (
        <Text dimColor>
          {isChatGPT
            ? 'No ChatGPT plan quota data available yet. Make a request or open chatgpt.com/codex/settings/usage.'
            : 'No rate-limit headers yet. Send a request first to capture RPM/TPM from the API response.'}
        </Text>
      )}

      {utilization.credits?.has_credits && (
        <Box flexDirection="column">
          <Text bold>Credits</Text>
          <Text dimColor>
            {utilization.credits.unlimited
              ? 'Unlimited'
              : typeof utilization.credits.balance === 'number'
                ? `Balance: ${utilization.credits.balance}`
                : 'Available'}
          </Text>
        </Box>
      )}

      <SessionCostSummary />

      {utilization.source === 'api_headers' && (
        <Text dimColor>Source: last API response headers (RPM/TPM or Codex plan headers)</Text>
      )}
      {utilization.source === 'chatgpt' && <Text dimColor>Source: ChatGPT Codex usage API</Text>}

      <UsageFooter />
    </Box>
  );
}

/**
 * Claude.ai subscription usage — original /usage panel behavior.
 * Do not merge OpenAI logic into this path.
 */
function ClaudeUsagePanel({ maxWidth }: { maxWidth: number }): React.ReactNode {
  const [utilization, setUtilization] = useState<Utilization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchUtilization();
      setUtilization(data);
      if (data) {
        setStatusLineUsageFromClaude(data);
      }
    } catch (err) {
      logError(err as Error);
      const axiosError = err as { response?: { data?: unknown } };
      const responseBody = axiosError.response?.data ? jsonStringify(axiosError.response.data) : undefined;
      setError(responseBody ? `Failed to load usage data: ${responseBody}` : 'Failed to load usage data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUtilization();
  }, [loadUtilization]);

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization();
    },
    { context: 'Settings', isActive: !!error && !isLoading },
  );

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint action="settings:retry" context="Settings" fallback="r" description="retry" />
            <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    );
  }

  if (!utilization) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Loading usage data…</Text>
        <Text dimColor>
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
        </Text>
      </Box>
    );
  }

  // Only Max and Team plans have a Sonnet limit that differs from the weekly
  // limit (see rateLimitMessages.ts). For other plans the bar is redundant.
  // Show for null (unknown plan) to stay consistent with rateLimitMessages.ts,
  // which labels it "Sonnet limit" in that case.
  const subscriptionType = getSubscriptionType();
  const showSonnetBar = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType === null;

  const limits = [
    {
      title: 'Current session',
      limit: utilization.five_hour,
    },
    {
      title: 'Current week (all models)',
      limit: utilization.seven_day,
    },
    ...(showSonnetBar
      ? [
          {
            title: 'Current week (Sonnet only)',
            limit: utilization.seven_day_sonnet,
          },
        ]
      : []),
  ];

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {limits.some(({ limit }) => limit) || <Text dimColor>/usage is only available for subscription plans.</Text>}

      {limits.map(
        ({ title, limit }) => limit && <LimitBar key={title} title={title} limit={limit} maxWidth={maxWidth} />,
      )}

      {utilization.extra_usage && <ExtraUsageSection extraUsage={utilization.extra_usage} maxWidth={maxWidth} />}

      {isEligibleForOverageCreditGrant() && <OverageCreditUpsell maxWidth={maxWidth} />}

      <Text dimColor>
        <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
      </Text>
    </Box>
  );
}

export function Usage(): React.ReactNode {
  const { columns } = useTerminalSize();
  const availableWidth = columns - 2; // 2 for screen padding
  const maxWidth = Math.min(availableWidth, 80);

  // OpenAI / ChatGPT path is fully separate so Claude.ai subscription
  // behavior stays identical when firstParty provider is active.
  if (shouldShowOpenAIUsage()) {
    return <OpenAIUsagePanel maxWidth={maxWidth} />;
  }

  return <ClaudeUsagePanel maxWidth={maxWidth} />;
}

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage;
  maxWidth: number;
};

const EXTRA_USAGE_SECTION_TITLE = 'Extra usage';

function ExtraUsageSection({ extraUsage, maxWidth }: ExtraUsageSectionProps): React.ReactNode {
  const subscriptionType = getSubscriptionType();
  const isProOrMax = subscriptionType === 'pro' || subscriptionType === 'max';
  if (!isProOrMax) {
    // Only show to Pro and Max, consistent with claude.ai non-admin usage settings
    return false;
  }

  if (!extraUsage.is_enabled) {
    if (extraUsageCommand.isEnabled()) {
      return (
        <Box flexDirection="column">
          <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
          <Text dimColor>Extra usage not enabled · /extra-usage to enable</Text>
        </Box>
      );
    }

    return null;
  }

  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>Unlimited</Text>
      </Box>
    );
  }

  if (typeof extraUsage.used_credits !== 'number' || typeof extraUsage.utilization !== 'number') {
    return null;
  }

  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2);
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2);
  const now = new Date();
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return (
    <LimitBar
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        // Not applicable for enterprises, but for now we don't render this for them
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={`${formattedUsedCredits} / ${formattedMonthlyLimit} spent`}
      maxWidth={maxWidth}
    />
  );
}
