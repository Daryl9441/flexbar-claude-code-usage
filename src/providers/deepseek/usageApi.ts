/**
 * DeepSeek GET https://api.deepseek.com/user/balance
 * (https://api-docs.deepseek.com/api/get-user-balance).
 *
 * Authorization: Bearer <API key>. The key is never written into the URL,
 * an error, or a log line. Redirects are refused so the key is not forwarded.
 *
 * 200: { is_available: boolean, balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }. Amounts are decimal strings.
 * currency is CNY or USD. is_available is whether the balance can pay for
 * API calls.
 */
import { parseMoney } from '../../balance';
import { UsageMetric } from '../types';

import { DeepseekUsageError } from './usageText';

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 1_000_000;

const CURRENCY_ORDER = ['CNY', 'USD'];

export type DeepseekBalanceDeps = {
  fetch?: typeof fetch;
};

type FetchLike = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function currencyId(currency: string): string | null {
  if (!/^[A-Za-z]{3}$/.test(currency)) return null;
  return currency.toLowerCase();
}

function retryAfter(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const parsed = Number.isFinite(seconds) ? Math.ceil(seconds) : 300;
  return Math.min(Math.max(parsed, 60), 24 * 60 * 60);
}

/**
 * One currency's total, granted and topped-up balances. `available` is the
 * account flag from is_available, repeated on each row.
 */
export function parseDeepseekBalance(payload: unknown): UsageMetric[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.balance_infos)) return null;
  if (typeof payload.is_available !== 'boolean') return null;
  const available = payload.is_available;
  const rows: UsageMetric[] = [];
  const seen = new Set<string>();
  for (const item of payload.balance_infos) {
    if (!isRecord(item) || typeof item.currency !== 'string') continue;
    const code = item.currency.trim().toUpperCase();
    const id = currencyId(code);
    if (!id || seen.has(id)) continue;
    const total = parseMoney(item.total_balance);
    if (total === null) continue;
    seen.add(id);
    const granted = parseMoney(item.granted_balance);
    const topped = parseMoney(item.topped_up_balance);
    rows.push(metric(id, code, total, code, available));
    if (granted !== null) {
      rows.push(metric(`${id}_granted`, 'Granted', granted, code, available));
    }
    if (topped !== null) {
      rows.push(metric(`${id}_topped_up`, 'Top-up', topped, code, available));
    }
  }
  rows.sort((a, b) => rank(a) - rank(b));
  return rows;
}

function metric(
  id: string,
  label: string,
  amount: number,
  currency: string,
  available: boolean
): UsageMetric {
  return {
    id,
    label,
    percent: 0,
    resetsAt: null,
    amount,
    currency,
    available,
    tag: currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency,
  };
}

function rank(metric: UsageMetric): number {
  const code = (metric.currency ?? '').toUpperCase();
  const currencyRank = CURRENCY_ORDER.indexOf(code);
  const base = currencyRank < 0 ? CURRENCY_ORDER.length : currencyRank;
  const kind = metric.id.endsWith('_granted')
    ? 1
    : metric.id.endsWith('_topped_up')
      ? 2
      : 0;
  return base * 10 + kind;
}

/** GET the official balance URL. The key stays in the Authorization header. */
export async function requestDeepseekBalance(
  key: string,
  fetchImpl: FetchLike
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    });
  } catch {
    throw new DeepseekUsageError(
      'network',
      'The DeepSeek balance request failed before a response arrived'
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new DeepseekUsageError(
      'unauthorized',
      'DeepSeek rejected the API key'
    );
  }
  if (response.status === 429) {
    throw new DeepseekUsageError(
      'rate-limited',
      'DeepSeek rate-limited the balance request',
      { retryAfterSeconds: retryAfter(response.headers.get('retry-after')) }
    );
  }
  if (response.status !== 200) {
    throw new DeepseekUsageError(
      'http',
      `DeepSeek balance request failed: HTTP ${response.status}`
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new DeepseekUsageError(
      'parse',
      'DeepSeek balance response could not be read'
    );
  }
  if (text.length > MAX_BODY_CHARS) {
    throw new DeepseekUsageError(
      'parse',
      'DeepSeek balance response was too large'
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeepseekUsageError(
      'parse',
      'DeepSeek balance response was not JSON'
    );
  }
}
