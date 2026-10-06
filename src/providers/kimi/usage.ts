/**
 * Kimi usage meter source.
 *
 * Plan limits come from the Kimi Code CLI's official quota endpoint
 * (GET <baseUrl>/usages, ./usageApi.ts) with the CLI's own OAuth login
 * (./usageAuth.ts, endpoint and slot from ./usageConfig.ts): 5-hour, weekly,
 * monthly and the monthly Kimi Code share, plus the extra-usage booster
 * wallet. The Kimi desktop app keeps its plan data behind its own web
 * session, which this plugin never touches; the only desktop number is the
 * context fill of the current Kimi Work task (./usageContext.ts, local and
 * credential-free), added as the `context` metric.
 *
 * | Found on this computer          | Metrics / key face                       |
 * | ------------------------------- | ---------------------------------------- |
 * | Kimi Code logged in             | 5h, weekly, … (+ context with Kimi Work) |
 * | … key set to a limit not on the | the default plan limit (5h when there),  |
 * |   plan (e.g. monthly_code)      |   with its own chip (substituteMetric)   |
 * | only Kimi Work context data     | context                                  |
 * | Kimi Code folder, no login      | "Not logged in · Run kimi login"         |
 * | login rejected / tombstone      | "Login expired · Run kimi login"         |
 * | expired, refreshing turned off  | "Login expired · Run kimi to refresh"    |
 * | desktop app only, no task yet   | "No usage data · Log in with Kimi Code"  |
 * | neither                         | "Kimi not found · Install Kimi Code"     |
 *
 * Never logs, throws or returns credentials: errors are ProviderErrors with
 * fixed texts; transport errors go through safeErrorMessage. Tests stub
 * `fetch` (no real requests).
 */
import { createHash } from 'node:crypto';

import { safeErrorMessage } from '../../redact';
import { ProviderError } from '../kit';
import {
  KeyText,
  Lang,
  PluginConfig,
  UsageDescription,
  UsageMetric,
  UsageSource,
} from '../types';

import { kimiCodeHome, kimiDesktopDir } from './paths';
import { parseUsagePayload, requestUsage } from './usageApi';
import {
  AuthDeps,
  CLI_LOCK,
  getAccessToken,
  loginExpired,
  refreshOff,
} from './usageAuth';
import { loadEndpoint } from './usageConfig';
import { isDirectory, readContextMetric } from './usageContext';

/** Fetches closer together than this reuse the last result in describe() */
const DESCRIBE_CACHE_MS = 30_000;

/** Chinese chip texts of the metrics (English: their label) */
const LABEL_ZH: Record<string, string> = {
  '5h': '5小时',
  weekly: '每周',
  monthly: '每月',
  extra: '加油包',
  context: '上下文',
};

const TEXT = {
  notInstalled: {
    en: { title: 'Kimi not found', message: 'Install Kimi Code' },
    zh: { title: '未找到 Kimi', message: '请安装 Kimi Code' },
  },
  desktopOnly: {
    en: { title: 'No usage data', message: 'Log in with Kimi Code' },
    zh: { title: '暂无用量数据', message: '请登录 Kimi Code' },
  },
  noLimits: {
    en: { title: 'No usage data', message: 'No limits reported' },
    zh: { title: '暂无用量数据', message: '未返回任何限额' },
  },
  noContext: {
    en: { title: 'No context data', message: 'Use Kimi Work first' },
    zh: { title: '暂无上下文数据', message: '请先使用 Kimi Work' },
  },
} satisfies Record<string, Record<Lang, KeyText>>;

export type KimiUsageDeps = AuthDeps;

export function defaultDeps(): KimiUsageDeps {
  return {
    // looked up per call, so a replaced global fetch (tests) is used
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    platform: process.platform,
    env: process.env,
    lock: CLI_LOCK,
  };
}

/** Why the last fetch had no plan limits, for keys that show one. */
let planGap: ProviderError | null = null;
/** The last successful fetch, reused by describe() for a short while. */
let lastResult: { at: number; key: string; metrics: UsageMetric[] } | null =
  null;
/**
 * A short hash of the access token a forced refresh produced and the
 * endpoint still refused (never the token itself). Until another token is
 * stored (`kimi login`, or the CLI refreshing), a 401 for it forces no
 * further refresh: each one would rotate the CLI's refresh token for nothing.
 */
let refusedToken: string | null = null;

/** Forgets the remembered results (tests). */
export function resetUsageState(): void {
  planGap = null;
  lastResult = null;
  refusedToken = null;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function cacheKey(config: PluginConfig, deps: KimiUsageDeps): string {
  return JSON.stringify([
    kimiCodeHome(config, deps.env),
    kimiDesktopDir(config, deps.platform, deps.env),
    config?.kimiRefreshLogin !== false,
  ]);
}

/**
 * Every Kimi limit available on this computer, plan limits first (5h is
 * the default), the Kimi Work context last.
 */
export async function fetchKimiUsage(
  config: PluginConfig,
  deps: KimiUsageDeps = defaultDeps()
): Promise<UsageMetric[]> {
  const home = kimiCodeHome(config, deps.env);
  const desktop = kimiDesktopDir(config, deps.platform, deps.env);
  const allowRefresh = config?.kimiRefreshLogin !== false;
  const endpoint = await loadEndpoint(home, deps.env);
  // read alongside the request; a failed local read only drops the metric
  const context = readContextMetric(desktop).catch(() => null);

  let token: string;
  try {
    token = await getAccessToken({ home, endpoint, allowRefresh }, deps);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== 'no-credentials') {
      throw error;
    }
    // no Kimi Code login at all: the desktop context is all there is
    let reason: ProviderError = error;
    if (!(await isDirectory(home))) {
      reason = (await isDirectory(desktop))
        ? new ProviderError(
            'not-configured',
            'The Kimi desktop app keeps its plan usage to itself. Log in with Kimi Code (`kimi login`) for plan limits.',
            { keyText: TEXT.desktopOnly }
          )
        : new ProviderError(
            'not-installed',
            'Neither Kimi Code nor the Kimi desktop app was found on this computer.',
            { keyText: TEXT.notInstalled }
          );
    }
    const only = await context;
    if (!only) throw reason;
    planGap = reason;
    return [only];
  }

  let response = await requestUsage(
    endpoint.baseUrl,
    token,
    deps.fetch,
    deps.now()
  );
  if (response.kind === 'unauthorized') {
    if (!allowRefresh) throw refreshOff();
    // a token a forced refresh already gave and the server refused
    if (refusedToken === fingerprint(token)) throw loginExpired();
    // rejected despite a plausible expiry: one forced refresh, one retry
    const fresh = await getAccessToken(
      { home, endpoint, allowRefresh, force: true },
      deps
    );
    if (fresh === token) throw loginExpired();
    response = await requestUsage(
      endpoint.baseUrl,
      fresh,
      deps.fetch,
      deps.now()
    );
    if (response.kind === 'unauthorized') {
      refusedToken = fingerprint(fresh);
      throw loginExpired();
    }
  }
  refusedToken = null;

  const metrics = parseUsagePayload(response.payload, deps.now());
  planGap =
    metrics.length > 0
      ? null
      : new ProviderError(
          'unsupported',
          'The Kimi Code usage endpoint reported no limits.',
          { keyText: TEXT.noLimits }
        );
  const local = await context;
  if (local) metrics.push(local);
  if (metrics.length === 0 && planGap) throw planGap;
  return metrics;
}

function logText(error: unknown): string {
  // ProviderError messages are fixed texts; keep "ProviderError:" out
  return error instanceof ProviderError
    ? safeErrorMessage(new Error(error.message))
    : safeErrorMessage(error);
}

/**
 * The limit a key draws when its own is not on the user's plan (a plan
 * without the monthly limits, a turned-off booster wallet): the default plan
 * limit, i.e. the first one returned (5h when the plan has it), drawn with
 * its own chip. Never for the Kimi Work context, and never without plan
 * limits (not logged in, …): missingText words those.
 */
function substituteMetric(
  metricId: string,
  metrics: UsageMetric[]
): string | null {
  if (metricId === 'context') return null;
  return metrics.find(m => m.id !== 'context')?.id ?? null;
}

/**
 * Key face for a key whose metric the last fetch did not return and that
 * substituteMetric did not replace, or null for the generic "No data for
 * this limit".
 */
function missingText(metricId: string, lang: Lang): KeyText | null {
  if (metricId === 'context') return TEXT.noContext[lang];
  const extra = planGap?.extra.keyText;
  if (!extra) return null;
  return 'title' in extra ? extra : extra[lang];
}

async function fetchAndRemember(
  config: PluginConfig,
  deps: KimiUsageDeps = defaultDeps()
): Promise<UsageMetric[]> {
  const metrics = await fetchKimiUsage(config, deps);
  lastResult = { at: deps.now(), key: cacheKey(config, deps), metrics };
  return metrics;
}

export type KimiUsageSource = UsageSource & {
  substituteMetric(metricId: string, metrics: UsageMetric[]): string | null;
  missingText(metricId: string, lang: Lang): KeyText | null;
};

export const usageSource: KimiUsageSource = {
  // '' = the first metric returned: 5h when the plan has it
  defaultMetric: '',

  fetch: config => fetchAndRemember(config ?? {}),

  logText,

  metricLabel: (metric, lang) =>
    (lang === 'zh' && LABEL_ZH[metric.id]) || metric.label,

  substituteMetric,

  missingText,

  /**
   * The key's settings page ('usage-status'): the available metrics, or a
   * log-safe error with its code so the page can word it in its language.
   * Reuses a result younger than 30 s instead of asking the server again.
   */
  async describe(config: PluginConfig) {
    const deps = defaultDeps();
    const safeConfig = config ?? {};
    try {
      const fresh =
        lastResult &&
        lastResult.key === cacheKey(safeConfig, deps) &&
        deps.now() - lastResult.at < DESCRIBE_CACHE_MS
          ? lastResult.metrics
          : await fetchAndRemember(safeConfig, deps);
      const contextOnly = fresh.every(m => m.id === 'context');
      return {
        success: true,
        metrics: fresh,
        contextOnly,
        ...(contextOnly && planGap ? { planCode: planGap.code } : {}),
      } satisfies UsageDescription;
    } catch (error) {
      return {
        success: false,
        error: logText(error),
        code: error instanceof ProviderError ? error.code : undefined,
      } satisfies UsageDescription;
    }
  },
};
