/**
 * The Kimi Code quota endpoint, GET <baseUrl>/usages, and its two payload
 * shapes:
 *
 * - current (Kimi Code since 2026-09): { usages: { limit_5h, limit_7d,
 *   limit_month_total, limit_month_code: { used_ratio 0–1, reset_time } },
 *   boosterWallet: { balance: { type: 'BOOSTER', amount, amountLeft } } }
 *   (booster amounts are fixed-point, 1e6 per cent);
 * - legacy (kimi-cli, older Kimi Code): { usage: { used, limit, resetTime },
 *   limits: [{ window: { duration, timeUnit }, detail: { used | remaining,
 *   limit, resetTime | reset_in } }] }.
 *
 * Sends exactly the CLI's two headers (no device headers: they carry the
 * host name). Responses are parsed without quoting them in errors.
 */
import { safeErrorMessage } from '../../redact';
import { ProviderError } from '../kit';
import { UsageMetric } from '../types';

import { parseSecretJson, retryAfterSeconds } from './usageAuth';
import { isSafeUrl } from './usageConfig';

const USAGE_TIMEOUT_MS = 8_000;

/** Metric ids in the order keys fall back through (the default is first). */
export const METRIC_ORDER = [
  '5h',
  'weekly',
  'monthly',
  'monthly_code',
  'extra',
  'context',
] as const;

/** Chip texts on the key face (short; meters stay English like Claude's). */
export const METRIC_LABEL: Record<string, string> = {
  '5h': '5h',
  weekly: 'Weekly',
  monthly: 'Month',
  monthly_code: 'Code',
  extra: 'Extra',
  context: 'Context',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Whole percent of a used ratio, rounded up like the CLI (any use shows at
 * least 1%), without float noise turning 0.3 into 31%.
 */
export function percentFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const exact = Math.round(ratio * 100 * 1e6) / 1e6;
  return Math.min(100, Math.max(0, Math.ceil(exact)));
}

/** An ISO reset time from a timestamp string, or null. */
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function metric(
  id: string,
  percent: number,
  resetsAt: string | null,
  label = METRIC_LABEL[id] ?? id
): UsageMetric {
  return { id, label, percent, resetsAt };
}

// --- current shape ---------------------------------------------------------------

const QUOTA_FIELDS: Array<[string, string]> = [
  ['limit_5h', '5h'],
  ['limit_7d', 'weekly'],
  ['limit_month_total', 'monthly'],
  ['limit_month_code', 'monthly_code'],
];

function quotaMetrics(usages: unknown): UsageMetric[] {
  if (!isRecord(usages)) return [];
  return QUOTA_FIELDS.flatMap(([field, id]) => {
    const entry = usages[field];
    if (!isRecord(entry)) return [];
    const ratio = num(entry.used_ratio);
    if (ratio === null) return [];
    return [metric(id, percentFromRatio(ratio), isoTime(entry.reset_time))];
  });
}

/** Booster wallet: share of the purchased extra usage already spent. */
function boosterMetric(wallet: unknown): UsageMetric | null {
  if (!isRecord(wallet) || !isRecord(wallet.balance)) return null;
  const balance = wallet.balance;
  if (balance.type !== 'BOOSTER') return null;
  const amount = num(balance.amount);
  if (amount === null || amount <= 0) return null;
  const left = Math.min(amount, Math.max(0, num(balance.amountLeft) ?? 0));
  return metric('extra', percentFromRatio(1 - left / amount), null);
}

// --- legacy shape ----------------------------------------------------------------

const UNIT_SECONDS: Array<[string, number]> = [
  ['SECOND', 1],
  ['MINUTE', 60],
  ['HOUR', 3600],
  ['DAY', 86_400],
  ['WEEK', 604_800],
  ['MONTH', 2_592_000],
];

function windowSeconds(...sources: Record<string, unknown>[]): number | null {
  for (const source of sources) {
    const duration = num(source.duration);
    if (duration === null || duration <= 0) continue;
    const unit = `${source.timeUnit ?? source.time_unit ?? ''}`.toUpperCase();
    const factor = UNIT_SECONDS.find(([name]) => unit.includes(name))?.[1];
    return duration * (factor ?? 1);
  }
  return null;
}

function legacyId(seconds: number | null, index: number): string {
  if (seconds === 5 * 3600) return '5h';
  if (seconds === 7 * 86_400) return 'weekly';
  if (seconds !== null && seconds >= 28 * 86_400 && seconds <= 31 * 86_400) {
    return 'monthly';
  }
  return seconds !== null ? `limit_${seconds}s` : `limit_${index + 1}`;
}

function legacyLabel(
  seconds: number | null,
  index: number,
  ...named: Record<string, unknown>[]
): string {
  if (seconds === null) {
    for (const source of named) {
      for (const key of ['name', 'title']) {
        const text = source[key];
        if (typeof text === 'string' && text.trim()) {
          return Array.from(text.trim()).slice(0, 16).join('');
        }
      }
    }
    return `Limit ${index + 1}`;
  }
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function legacyReset(detail: Record<string, unknown>, now: number) {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const iso = isoTime(detail[key]);
    if (iso) return iso;
  }
  for (const key of ['reset_in', 'resetIn', 'ttl']) {
    const seconds = num(detail[key]);
    if (seconds !== null && seconds > 0) {
      return new Date(now + seconds * 1000).toISOString();
    }
  }
  return null;
}

function legacyPercent(detail: Record<string, unknown>): number | null {
  const limit = num(detail.limit);
  if (limit === null || limit <= 0) return null;
  let used = num(detail.used);
  if (used === null) {
    const remaining = num(detail.remaining);
    if (remaining === null) return null;
    used = limit - remaining;
  }
  return percentFromRatio(used / limit);
}

function legacyMetrics(
  payload: Record<string, unknown>,
  now: number
): UsageMetric[] {
  const out: UsageMetric[] = [];
  if (isRecord(payload.usage)) {
    const percent = legacyPercent(payload.usage);
    if (percent !== null) {
      out.push(metric('weekly', percent, legacyReset(payload.usage, now)));
    }
  }
  if (Array.isArray(payload.limits)) {
    payload.limits.forEach((item, index) => {
      if (!isRecord(item)) return;
      const detail = isRecord(item.detail) ? item.detail : item;
      const window = isRecord(item.window) ? item.window : {};
      const percent = legacyPercent(detail);
      if (percent === null) return;
      const seconds = windowSeconds(window, item, detail);
      const id = legacyId(seconds, index);
      if (out.some(m => m.id === id)) return;
      const label =
        METRIC_LABEL[id] ?? legacyLabel(seconds, index, item, detail);
      out.push(metric(id, percent, legacyReset(detail, now), label));
    });
  }
  return out;
}

/** Orders metrics: known ids in METRIC_ORDER, others after them. */
export function orderMetrics(metrics: UsageMetric[]): UsageMetric[] {
  const rank = (id: string) => {
    const at = (METRIC_ORDER as readonly string[]).indexOf(id);
    return at < 0 ? METRIC_ORDER.length : at;
  };
  return metrics
    .map((m, index) => ({ m, index }))
    .sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.index - b.index)
    .map(({ m }) => m);
}

/**
 * Every limit in a /usages payload (either shape), ordered with 5h first.
 * `now` turns legacy relative reset times into absolute ones.
 */
export function parseUsagePayload(
  payload: unknown,
  now: number = Date.now()
): UsageMetric[] {
  if (!isRecord(payload)) return [];
  const current = quotaMetrics(payload.usages);
  const booster = boosterMetric(payload.boosterWallet);
  if (booster) current.push(booster);
  for (const legacy of legacyMetrics(payload, now)) {
    if (!current.some(m => m.id === legacy.id)) current.push(legacy);
  }
  return orderMetrics(current);
}

// --- request ---------------------------------------------------------------------

export type UsageResponse =
  { kind: 'ok'; payload: unknown } | { kind: 'unauthorized' };

/**
 * GET <baseUrl>/usages with a bearer token. 401 is returned (the caller may
 * refresh and retry); every other failure throws a ProviderError.
 */
export async function requestUsage(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  now: number = Date.now()
): Promise<UsageResponse> {
  const url = `${baseUrl}/usages`;
  if (!isSafeUrl(url)) {
    throw new ProviderError(
      'not-configured',
      'The Kimi Code base URL is not an https URL.'
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error | null)?.name;
    throw new ProviderError(
      'network',
      name === 'TimeoutError' || name === 'AbortError'
        ? 'Kimi Code usage request timed out.'
        : `Network error: ${safeErrorMessage(error)}`
    );
  }
  if (response.status === 401) return { kind: 'unauthorized' };
  if (response.status === 404) {
    throw new ProviderError(
      'unsupported',
      'This login has no Kimi Code plan usage (HTTP 404).',
      {
        keyText: {
          en: { title: 'No plan usage', message: 'Needs a Kimi Code plan' },
          zh: { title: '无套餐用量', message: '需要 Kimi Code 套餐' },
        },
      }
    );
  }
  if (response.status === 429) {
    throw new ProviderError(
      'rate-limited',
      'Rate limited by the Kimi Code usage endpoint.',
      { retryAfterSeconds: retryAfterSeconds(response, now) }
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      'http',
      `Kimi Code usage request failed with HTTP ${response.status}`
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new ProviderError(
      'network',
      `Network error: ${safeErrorMessage(error)}`
    );
  }
  const payload = parseSecretJson(text, 'Kimi Code usage response');
  if (!isRecord(payload)) {
    throw new ProviderError(
      'parse',
      'Kimi Code usage response is not a JSON object'
    );
  }
  return { kind: 'ok', payload };
}
