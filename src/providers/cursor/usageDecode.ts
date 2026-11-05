/**
 * The body of Cursor's GetCurrentPeriodUsage call, turned into usage meters.
 * Pure: no network and no disk.
 *
 * Grok Bot's meter is one weekly `usagePercent` from GetSandUsageStatus.
 * Cursor's included meter is `includedSpend / limit` when both are present:
 * that ratio is the billing-cycle "included usage" percentage. Auto and API
 * stay on their own percent fields. `totalPercentUsed` is a separate blend
 * of those pools, so it fills the included meter only when the spend ratio
 * is absent. Amounts elsewhere in the body share one unit; this decoder
 * keeps percentages and the cycle end. A pooled team allowance with no
 * per-account percentage is a refusal, not a zero.
 */
import { planLabelOf, resetInstant } from '../grokbot/usageDecode';
import { UsageMetric } from '../types';

import { CursorUsageError } from './usageText';

export const INCLUDED_METRIC_ID = 'included';
export const AUTO_METRIC_ID = 'auto';
export const API_METRIC_ID = 'api';
export const ONDEMAND_METRIC_ID = 'ondemand';

export type PeriodUsage =
  | { kind: 'metrics'; metrics: UsageMetric[]; planLabel: string | null }
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

function pick(
  record: Record<string, unknown> | null,
  ...keys: string[]
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** 0–100, or null when the field is missing or not a usable percentage. */
export function usedPercent(value: unknown): number | null {
  const raw = finiteNumber(value);
  if (raw === null || raw < 0) return null;
  return Math.round(Math.min(100, raw));
}

function planRecord(
  body: Record<string, unknown>
): Record<string, unknown> | null {
  return (
    (isRecord(body.planUsage) ? body.planUsage : null) ??
    (isRecord(body.plan_usage) ? body.plan_usage : null)
  );
}

function spendRecord(
  body: Record<string, unknown>
): Record<string, unknown> | null {
  return (
    (isRecord(body.spendLimitUsage) ? body.spendLimitUsage : null) ??
    (isRecord(body.spend_limit_usage) ? body.spend_limit_usage : null)
  );
}

/** A plan name from a period or GetPlanInfo body, or null. */
export function periodPlanLabel(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const nested = isRecord(body.planInfo)
    ? body.planInfo
    : isRecord(body.plan_info)
      ? body.plan_info
      : null;
  return (
    planLabelOf(pick(body, 'planName', 'plan_name')) ??
    planLabelOf(pick(nested, 'planName', 'plan_name'))
  );
}

/**
 * Included-plan percent. The spend ratio wins when Cursor sent both
 * numbers; a reported `totalPercentUsed` is the fallback, then total
 * spend over the same limit.
 */
function includedPercent(plan: Record<string, unknown>): number | null {
  const limit = finiteNumber(pick(plan, 'limit'));
  const includedSpend = finiteNumber(
    pick(plan, 'includedSpend', 'included_spend')
  );
  if (
    limit !== null &&
    limit > 0 &&
    includedSpend !== null &&
    includedSpend >= 0
  ) {
    return usedPercent((includedSpend / limit) * 100);
  }
  const reported = usedPercent(
    pick(plan, 'totalPercentUsed', 'total_percent_used')
  );
  if (reported !== null) return reported;
  const spent = finiteNumber(pick(plan, 'totalSpend', 'total_spend'));
  if (limit !== null && limit > 0 && spent !== null && spent >= 0) {
    return usedPercent((spent / limit) * 100);
  }
  return null;
}

function pushPercent(
  metrics: UsageMetric[],
  id: string,
  label: string,
  tag: string,
  percent: number | null,
  resetsAt: string | null
): void {
  if (percent === null) return;
  metrics.push({ id, label, tag, percent, resetsAt });
}

/**
 * Null when the body has no plan object to interpret (the caller reports an
 * unreadable response). A pooled or empty allowance is a result.
 */
export function decodePeriodUsage(body: unknown): PeriodUsage | null {
  if (!isRecord(body)) return null;
  const plan = planRecord(body);
  if (!plan) return null;
  const resetsAt = resetInstant(
    pick(body, 'billingCycleEnd', 'billing_cycle_end')
  );
  const planLabel = periodPlanLabel(body);
  const metrics: UsageMetric[] = [];

  const included = includedPercent(plan);
  pushPercent(
    metrics,
    INCLUDED_METRIC_ID,
    'Included',
    'plan',
    included,
    resetsAt
  );
  pushPercent(
    metrics,
    AUTO_METRIC_ID,
    'Auto',
    'auto',
    usedPercent(pick(plan, 'autoPercentUsed', 'auto_percent_used')),
    resetsAt
  );
  pushPercent(
    metrics,
    API_METRIC_ID,
    'API',
    'api',
    usedPercent(pick(plan, 'apiPercentUsed', 'api_percent_used')),
    resetsAt
  );

  const spend = spendRecord(body);
  const ondemandLimit = finiteNumber(
    pick(spend, 'individualLimit', 'individual_limit')
  );
  const ondemandUsed = finiteNumber(
    pick(spend, 'individualUsed', 'individual_used')
  );
  if (
    ondemandLimit !== null &&
    ondemandLimit > 0 &&
    ondemandUsed !== null &&
    ondemandUsed >= 0
  ) {
    pushPercent(
      metrics,
      ONDEMAND_METRIC_ID,
      'On-demand',
      'extra',
      usedPercent((ondemandUsed / ondemandLimit) * 100),
      resetsAt
    );
  }

  if (metrics.length > 0) return { kind: 'metrics', metrics, planLabel };

  const pooledLimit = finiteNumber(pick(spend, 'pooledLimit', 'pooled_limit'));
  const limitType = pick(spend, 'limitType', 'limit_type');
  if ((pooledLimit !== null && pooledLimit > 0) || limitType === 'team') {
    return { kind: 'pooled' };
  }
  return { kind: 'no-allowance' };
}

export function periodRefusal(
  kind: 'pooled' | 'no-allowance'
): CursorUsageError {
  return kind === 'pooled'
    ? new CursorUsageError(
        'pooled',
        'Cursor usage is drawn from a pooled team allowance, which has no per-account percentage'
      )
    : new CursorUsageError(
        'no-allowance',
        'This account has no included Cursor usage percentage'
      );
}
