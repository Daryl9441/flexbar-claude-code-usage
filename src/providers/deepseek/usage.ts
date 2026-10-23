/**
 * DeepSeek usage source: the account balance from
 * GET https://api.deepseek.com/user/balance.
 *
 * The API key comes from the plugin setting `deepseekApiKey`, else
 * DEEPSEEK_API_KEY. It is sent only as a Bearer token to that URL, and it
 * is never logged, drawn or put in an error. Tests stub `fetch`.
 */
import { resolveSecret } from '../../balance';
import { safeErrorMessage } from '../../redact';
import {
  KeyText,
  Lang,
  PluginConfig,
  UsageDescription,
  UsageMetric,
  UsageSource,
} from '../types';

import { parseDeepseekBalance, requestDeepseekBalance } from './usageApi';
import { deepseekUsageFace } from './usageFace';
import { DeepseekUsageError, deepseekErrorText } from './usageText';

export type DeepseekUsageDeps = {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

const MIN_FETCH_GAP_MS = 30_000;

function keepLast(error: unknown): boolean {
  return (
    error instanceof DeepseekUsageError &&
    (error.problem === 'network' || error.problem === 'http')
  );
}

/** A DeepSeek balance source. Tests pass stubs; the plugin uses `usageSource`. */
export function createDeepseekUsageSource(
  deps: DeepseekUsageDeps = {}
): UsageSource {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;

  async function fetchMetrics(config: PluginConfig): Promise<UsageMetric[]> {
    const secret = resolveSecret(config?.deepseekApiKey, env.DEEPSEEK_API_KEY);
    if (secret.rejected || !secret.key) {
      throw new DeepseekUsageError(
        'no-key',
        secret.rejected
          ? 'The DeepSeek API key setting is not a single token'
          : 'No DeepSeek API key is set'
      );
    }
    const payload = await requestDeepseekBalance(secret.key, fetchImpl);
    const metrics = parseDeepseekBalance(payload);
    if (!metrics) {
      throw new DeepseekUsageError(
        'parse',
        'DeepSeek returned an unrecognized balance response'
      );
    }
    if (metrics.length === 0) {
      throw new DeepseekUsageError(
        'empty',
        'DeepSeek reported no currency balance'
      );
    }
    return metrics;
  }

  return {
    defaultMetric: '',
    minFetchGapMs: MIN_FETCH_GAP_MS,
    fetch: config => fetchMetrics(config ?? {}),
    errorText(error: unknown, lang: Lang): KeyText {
      return deepseekErrorText(error, lang);
    },
    logText(error: unknown): string {
      return error instanceof DeepseekUsageError
        ? safeErrorMessage(new Error(error.message))
        : safeErrorMessage(error);
    },
    metricLabel(metric: UsageMetric, lang: Lang): string {
      if (lang !== 'zh') return metric.label;
      if (metric.id.endsWith('_granted')) return '赠金';
      if (metric.id.endsWith('_topped_up')) return '充值';
      return metric.currency || metric.label;
    },
    face: deepseekUsageFace,
    keepLastOnError: keepLast,
    async describe(config: PluginConfig): Promise<UsageDescription> {
      try {
        const metrics = await fetchMetrics(config ?? {});
        return { success: true, metrics };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof DeepseekUsageError
              ? safeErrorMessage(new Error(error.message))
              : safeErrorMessage(error),
          code: error instanceof DeepseekUsageError ? error.code : undefined,
          problem:
            error instanceof DeepseekUsageError ? error.problem : undefined,
        };
      }
    },
  };
}

export const usageSource: UsageSource = createDeepseekUsageSource();
