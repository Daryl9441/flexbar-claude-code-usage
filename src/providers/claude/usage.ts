/**
 * Claude Code usage: the OAuth usage endpoint (src/api.ts) with the
 * credentials Claude Code stores on this computer (src/credentials.ts).
 */
import { UsageError, fetchUsage } from '../../api';
import { safeErrorMessage } from '../../redact';
import { Metric } from '../../types';
import { getMetricSnapshot } from '../../usage';
import { DEFAULT_LOCKOUT_SECONDS } from '../kit';
import {
  KeyText,
  PluginConfig,
  UsageDescription,
  UsageMetric,
  UsageSource,
} from '../types';

const METRICS: Metric[] = ['session', 'weekly', 'weekly_model'];

/**
 * Short key-face text for a fetch error. Keys can be under 100px wide, so the
 * full error message only goes to the log and the settings UI.
 */
export function claudeErrorText(error: unknown): KeyText {
  if (error instanceof UsageError) {
    switch (error.code) {
      case 'no-credentials':
        return { title: 'Not logged in', message: 'Run claude to log in' };
      case 'unauthorized':
        return { title: 'Login expired', message: 'Run claude to log in' };
      case 'rate-limited':
        return { title: 'Rate limited', message: 'Retrying later' };
      case 'http':
        return {
          title: 'Usage error',
          message: error.message.match(/HTTP \d+/)?.[0] ?? error.message,
        };
      case 'network':
        return { title: 'Network error', message: 'Check your connection' };
    }
  }
  return { title: 'Claude Code', message: safeErrorMessage(error) };
}

async function fetchMetrics(config: PluginConfig): Promise<UsageMetric[]> {
  const usage = await fetchUsage(config?.credentialsPath);
  return METRICS.flatMap(id => {
    const snapshot = getMetricSnapshot(usage, id);
    return snapshot ? [{ id, ...snapshot }] : [];
  });
}

export const claudeUsageSource: UsageSource = {
  defaultMetric: 'session',
  fetch: fetchMetrics,
  // Claude's key texts are English only, like before
  errorText: error => claudeErrorText(error),
  logText: error => safeErrorMessage(error),
  lockoutSeconds: error =>
    error instanceof UsageError && error.code === 'rate-limited'
      ? (error.retryAfterSeconds ?? DEFAULT_LOCKOUT_SECONDS)
      : null,
  /** The global settings page's connection test ('test-connection'). */
  async describe(config): Promise<UsageDescription> {
    try {
      const metrics = await fetchMetrics(config);
      const percent = (id: string) =>
        metrics.find(m => m.id === id)?.percent ?? null;
      return {
        success: true,
        session: percent('session'),
        weekly: percent('weekly'),
        metrics,
      };
    } catch (error) {
      const message =
        error instanceof UsageError ? error.message : safeErrorMessage(error);
      return { success: false, error: message };
    }
  },
};
