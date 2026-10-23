/**
 * Kimi open-platform (Moonshot) account balance.
 *
 * Official docs: https://platform.kimi.com/docs/api/balance
 * GET https://api.moonshot.cn/v1/users/me/balance
 * Authorization: Bearer $MOONSHOT_API_KEY
 *
 * 200:
 * { code: 0, status: true, data: { available_balance, voucher_balance,
 *   cash_balance } }
 * Amounts are CNY on api.moonshot.cn. available_balance is cash plus
 * vouchers and is what remains for inference; at 0 or below, inference
 * calls are refused. cash_balance is the topped-up cash and may be negative.
 * voucher_balance is the voucher remainder and is not negative.
 *
 * The international host https://api.moonshot.ai/v1/users/me/balance is the
 * same shape in USD (https://platform.kimi.ai/docs/api/balance). A key from
 * one site is rejected by the other.
 *
 * The key is never put in the URL, an error or a log. Redirects are refused.
 * With no key configured, nothing is requested and the other Kimi metrics
 * are unchanged.
 */
import { createHash } from 'node:crypto';

import { parseMoney, resolveSecret } from '../../balance';
import { ProviderError } from '../kit';
import { KeyText, Lang, PluginConfig, UsageMetric } from '../types';

const CN_ORIGIN = 'https://api.moonshot.cn';
const GLOBAL_ORIGIN = 'https://api.moonshot.ai';
const BALANCE_PATH = '/v1/users/me/balance';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 1_000_000;

export const API_BALANCE_IDS = ['api', 'api_cash', 'api_voucher'] as const;

export function isApiBalanceMetric(id: string): boolean {
  return (API_BALANCE_IDS as readonly string[]).includes(id);
}

const TEXT = {
  rejected: {
    en: { title: 'API key needed', message: 'Plugin settings' },
    zh: { title: '需要 API 密钥', message: '请填写插件设置' },
  },
  unauthorized: {
    en: { title: 'API key rejected', message: 'Check key and site' },
    zh: { title: '密钥被拒绝', message: '请检查密钥和站点' },
  },
  'rate-limited': {
    en: { title: 'Rate limited', message: 'Retrying later' },
    zh: { title: '请求受限', message: '稍后自动重试' },
  },
  network: {
    en: { title: 'Network error', message: 'Check your connection' },
    zh: { title: '网络错误', message: '请检查网络连接' },
  },
  http: {
    en: { title: 'Balance error', message: 'Balance request failed' },
    zh: { title: '余额请求失败', message: '余额请求失败' },
  },
  parse: {
    en: { title: 'Unreadable balance', message: 'Try again later' },
    zh: { title: '无法读取余额', message: '请稍后再试' },
  },
  refused: {
    en: { title: 'No API balance', message: 'Balance request refused' },
    zh: { title: '没有 API 余额', message: '余额请求被拒绝' },
  },
} satisfies Record<string, Record<Lang, KeyText>>;

export type MoonshotSite = 'cn' | 'global';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** China (CNY) unless the setting or MOONSHOT_API_BASE names the .ai host. */
export function moonshotSite(
  config: PluginConfig | undefined,
  env: NodeJS.ProcessEnv
): MoonshotSite {
  const raw =
    typeof config?.moonshotSite === 'string'
      ? config.moonshotSite.trim().toLowerCase()
      : '';
  if (raw === 'global' || raw === 'ai' || raw === 'international') {
    return 'global';
  }
  if (raw === 'cn' || raw === 'china') return 'cn';
  const base = env.MOONSHOT_API_BASE?.trim().replace(/\/+$/, '');
  return base === GLOBAL_ORIGIN ? 'global' : 'cn';
}

export function moonshotBalanceUrl(
  config: PluginConfig | undefined,
  env: NodeJS.ProcessEnv
): string {
  const origin =
    moonshotSite(config, env) === 'global' ? GLOBAL_ORIGIN : CN_ORIGIN;
  return `${origin}${BALANCE_PATH}`;
}

export function moonshotCurrency(
  config: PluginConfig | undefined,
  env: NodeJS.ProcessEnv
): 'CNY' | 'USD' {
  return moonshotSite(config, env) === 'global' ? 'USD' : 'CNY';
}

/**
 * A short hash of the key plus the site, for the usage cache. Not the key.
 * Empty when no key is configured.
 */
export function moonshotCacheToken(
  config: PluginConfig | undefined,
  env: NodeJS.ProcessEnv
): string {
  const site = moonshotSite(config, env);
  const secret = resolveSecret(config?.moonshotApiKey, env.MOONSHOT_API_KEY);
  if (!secret.key) return site;
  const hash = createHash('sha256')
    .update(secret.key)
    .digest('hex')
    .slice(0, 16);
  return `${site}:${hash}`;
}

function retryAfter(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const parsed = Number.isFinite(seconds) ? Math.ceil(seconds) : 300;
  return Math.min(Math.max(parsed, 60), 24 * 60 * 60);
}

function balanceError(
  code: ProviderError['code'],
  message: string,
  text: Record<Lang, KeyText>,
  extra: { retryAfterSeconds?: number } = {}
): ProviderError {
  return new ProviderError(code, message, { ...extra, keyText: text });
}

/**
 * available_balance, cash_balance and voucher_balance as three metrics.
 * Null when the payload is not a balance reply (including code !== 0).
 */
export function parseMoonshotBalance(
  payload: unknown,
  currency: 'CNY' | 'USD'
): UsageMetric[] | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.code === 'number' && payload.code !== 0) return null;
  if (payload.status === false) return null;
  const data = isRecord(payload.data) ? payload.data : null;
  if (!data) return null;
  const available = parseMoney(data.available_balance);
  const voucher = parseMoney(data.voucher_balance);
  const cash = parseMoney(data.cash_balance);
  if (available === null || voucher === null || cash === null) return null;
  const canCall = available > 0;
  const tag = currency === 'CNY' ? '¥' : '$';
  const row = (id: string, label: string, amount: number): UsageMetric => ({
    id,
    label,
    percent: 0,
    resetsAt: null,
    amount,
    currency,
    available: canCall,
    tag,
  });
  return [
    row('api', 'API', available),
    row('api_cash', 'Cash', cash),
    row('api_voucher', 'Voucher', voucher),
  ];
}

export type MoonshotBalanceResult = {
  metrics: UsageMetric[];
  /** Set when a key was configured and the balance could not be read. */
  gap: ProviderError | null;
  configured: boolean;
};

export type MoonshotBalanceDeps = {
  fetch: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

/**
 * The Moonshot balance, or no metrics when no key is set. Never throws:
 * a failed read is `gap`, so Kimi Code quota can still be shown.
 */
export async function fetchMoonshotMetrics(
  config: PluginConfig | undefined,
  deps: MoonshotBalanceDeps
): Promise<MoonshotBalanceResult> {
  const env = deps.env ?? process.env;
  const secret = resolveSecret(config?.moonshotApiKey, env.MOONSHOT_API_KEY);
  if (!secret.key && !secret.rejected) {
    return { metrics: [], gap: null, configured: false };
  }
  if (secret.rejected || !secret.key) {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'no-credentials',
        'The Moonshot API key setting is not a single token',
        TEXT.rejected
      ),
    };
  }
  const url = moonshotBalanceUrl(config, env);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${secret.key}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'network',
        'The Moonshot balance request failed before a response arrived',
        TEXT.network
      ),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'unauthorized',
        'Moonshot rejected the API key',
        TEXT.unauthorized
      ),
    };
  }
  if (response.status === 429) {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'rate-limited',
        'Moonshot rate-limited the balance request',
        TEXT['rate-limited'],
        { retryAfterSeconds: retryAfter(response.headers.get('retry-after')) }
      ),
    };
  }
  if (response.status !== 200) {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'http',
        `Moonshot balance request failed: HTTP ${response.status}`,
        TEXT.http
      ),
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'parse',
        'Moonshot balance response could not be read',
        TEXT.parse
      ),
    };
  }
  if (text.length > MAX_BODY_CHARS) {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'parse',
        'Moonshot balance response was too large',
        TEXT.parse
      ),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'parse',
        'Moonshot balance response was not JSON',
        TEXT.parse
      ),
    };
  }
  const metrics = parseMoonshotBalance(payload, moonshotCurrency(config, env));
  if (!metrics) {
    return {
      metrics: [],
      configured: true,
      gap: balanceError(
        'unsupported',
        'Moonshot refused the balance request or returned no balances',
        TEXT.refused
      ),
    };
  }
  return { metrics, gap: null, configured: true };
}
