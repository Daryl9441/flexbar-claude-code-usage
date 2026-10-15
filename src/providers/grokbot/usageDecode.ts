/**
 * The body of Cursor's GetSandUsageStatus call, turned into the one weekly
 * meter Grok Bot's account menu shows. Pure: no network and no disk.
 *
 * usagePercent is how much of the weekly allowance is used (0–100). A pooled
 * enterprise allowance and an account with no included allowance have no
 * per-account meter; those are refusals, not zeros.
 */
import { UsageMetric } from '../types';

import { GrokbotUsageError } from './usageText';

export const WEEKLY_METRIC_ID = 'weekly';

const MIN_RESET_MS = Date.UTC(2020, 0, 1);
const MAX_RESET_MS = Date.UTC(2100, 0, 1);

export type SandUsage =
  | { kind: 'metric'; metric: UsageMetric; planLabel: string | null }
  | { kind: 'pooled' }
  | { kind: 'no-allowance' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** ISO time, or null when the field is missing or not a plausible instant. */
export function resetInstant(value: unknown): string | null {
  if (typeof value === 'string' && /[tT\-:Z]/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < MIN_RESET_MS || parsed >= MAX_RESET_MS) return null;
    return new Date(parsed).toISOString();
  }
  const n = finiteNumber(value);
  if (n === null || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  if (ms < MIN_RESET_MS || ms >= MAX_RESET_MS) return null;
  return new Date(ms).toISOString();
}

/** A short plan name safe to show on the settings page, or null. */
export function planLabelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[^\p{L}\p{N} .+-]/gu, '')
    .trim()
    .slice(0, 40);
  return cleaned || null;
}

/**
 * Null when the body has no usage object to interpret (the caller reports
 * an unreadable response). A pooled or zero allowance is a result.
 */
export function decodeSandUsage(body: unknown): SandUsage | null {
  if (!isRecord(body)) return null;
  if (body.usesPooledEnterpriseAllowance === true) return { kind: 'pooled' };
  if (body.hasNonZeroIncludedLimit === false) return { kind: 'no-allowance' };
  const raw = finiteNumber(body.usagePercent);
  if (raw === null || raw < 0) return null;
  return {
    kind: 'metric',
    planLabel: planLabelOf(body.grokPlanLabel),
    metric: {
      id: WEEKLY_METRIC_ID,
      label: 'Weekly',
      tag: '7d',
      percent: Math.round(Math.min(100, raw)),
      resetsAt: resetInstant(body.nextResetTimestampUtc),
    },
  };
}

export function refusalError(
  kind: 'pooled' | 'no-allowance'
): GrokbotUsageError {
  return kind === 'pooled'
    ? new GrokbotUsageError(
        'pooled',
        'Grok Bot usage is drawn from a pooled enterprise allowance, which has no per-account reading'
      )
    : new GrokbotUsageError(
        'no-allowance',
        'This account has no included Grok Bot allowance'
      );
}
