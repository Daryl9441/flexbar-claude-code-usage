/**
 * Cursor usage meter: the included-plan percentage the dashboard shows,
 * plus the auto, API and on-demand splits when Cursor reports them.
 *
 * POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 * Connect-RPC, empty JSON body, Authorization: Bearer <Cursor access token>.
 * The token is the same Cursor login Grok Bot's usage key reads
 * (./login.ts). It is not logged and not written. Redirects are refused so
 * the bearer stays on api2.cursor.sh. A plan name, when the period body has
 * none, comes from one follow-up GetPlanInfo call; a failure there leaves
 * the meters in place.
 *
 * This is not GetSandUsageStatus. That call is Grok Bot's weekly allowance
 * and stays on the Grok Bot key.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';

import { safeErrorMessage } from '../../redact';
import { allowCursorKeychainPrompt } from '../grokbot/cursorSeal';
import {
  KeyText,
  Lang,
  PluginConfig,
  UsageDescription,
  UsageMetric,
  UsageSource,
} from '../types';

import { loadCursorAccessToken } from './login';
import { cursorAppCandidates, cursorStateDb, cursorUserDataDir } from './paths';
import {
  decodePeriodUsage,
  periodPlanLabel,
  periodRefusal,
} from './usageDecode';
import { CursorUsageError, cursorErrorText } from './usageText';

export const PERIOD_USAGE_ENDPOINT =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const PLAN_INFO_ENDPOINT =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo';

const MIN_FETCH_GAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 1_000_000;

export type CursorUsageDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** Cursor access token, or null when Cursor is signed out. */
  loadToken?: (databasePath: string) => Promise<string | null>;
};

type FetchResult = { metrics: UsageMetric[]; planLabel: string | null };

function installed(
  config: PluginConfig,
  exists: (file: string) => boolean,
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform
): boolean {
  const places = [
    cursorUserDataDir(config, env, home, platform),
    cursorStateDb(config, env, home, platform),
    ...cursorAppCandidates(home, platform, env),
  ];
  return places.some(place => {
    try {
      return exists(place);
    } catch {
      return false;
    }
  });
}

async function readBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CursorUsageError(
      'parse',
      'Cursor usage response could not be read'
    );
  }
  if (text.length > MAX_BODY_CHARS) {
    throw new CursorUsageError('parse', 'Cursor usage response was too large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CursorUsageError('parse', 'Cursor usage response was not JSON');
  }
}

function retryAfter(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const parsed = Number.isFinite(seconds) ? Math.ceil(seconds) : 300;
  return Math.min(Math.max(parsed, 60), 24 * 60 * 60);
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Connect-Protocol-Version': '1',
  };
}

/** A Cursor usage source. Tests pass stubs; the plugin uses `usageSource`. */
export function createCursorUsageSource(
  deps: CursorUsageDeps = {}
): UsageSource & { lastPlanLabel(): string | null } {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const loadToken =
    deps.loadToken ?? ((file: string) => loadCursorAccessToken(file));
  let planLabel: string | null = null;

  async function post(token: string, url: string): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: authHeaders(token),
      });
    } catch {
      throw new CursorUsageError(
        'network',
        'The Cursor usage request failed before a response arrived'
      );
    }
  }

  function rejectStatus(response: Response): void {
    if (response.status === 401 || response.status === 403) {
      throw new CursorUsageError(
        'login-expired',
        `Cursor rejected the usage request (HTTP ${response.status})`
      );
    }
    if (response.status === 429) {
      throw new CursorUsageError(
        'rate-limited',
        'Cursor rate-limited the usage request',
        { retryAfterSeconds: retryAfter(response.headers.get('retry-after')) }
      );
    }
    if (response.status >= 500) {
      throw new CursorUsageError(
        'http',
        `Cursor usage request failed: HTTP ${response.status}`
      );
    }
    if (!response.ok) {
      throw new CursorUsageError(
        'parse',
        `Cursor usage request failed: HTTP ${response.status}`
      );
    }
  }

  async function fetchMetrics(config: PluginConfig): Promise<FetchResult> {
    if (!installed(config, exists, env, home, platform)) {
      throw new CursorUsageError(
        'not-installed',
        'Cursor is not installed: no app, user-data folder or state database was found'
      );
    }
    const databasePath = cursorStateDb(config, env, home, platform);
    let token: string | null;
    try {
      token = (await loadToken(databasePath))?.trim() || null;
    } catch (error) {
      if (error instanceof CursorUsageError) throw error;
      throw new CursorUsageError(
        'state-unreadable',
        'Cursor state database could not be read'
      );
    }
    if (!token) {
      throw new CursorUsageError(
        'not-signed-in',
        'No Cursor login found. Sign in to the Cursor app'
      );
    }

    const response = await post(token, PERIOD_USAGE_ENDPOINT);
    rejectStatus(response);
    const body = await readBody(response);
    if (
      body &&
      typeof body === 'object' &&
      (body as { code?: unknown }).code === 'unauthenticated'
    ) {
      throw new CursorUsageError(
        'login-expired',
        'Cursor rejected the usage request'
      );
    }
    const decoded = decodePeriodUsage(body);
    if (!decoded) {
      throw new CursorUsageError(
        'parse',
        'Cursor returned an unrecognized usage response'
      );
    }
    if (decoded.kind !== 'metrics') throw periodRefusal(decoded.kind);

    let named = decoded.planLabel;
    if (!named) {
      try {
        const planResponse = await post(token, PLAN_INFO_ENDPOINT);
        if (planResponse.ok) {
          named = periodPlanLabel(await readBody(planResponse));
        }
      } catch {
        named = null;
      }
    }
    planLabel = named;
    return { metrics: decoded.metrics, planLabel: named };
  }

  return {
    defaultMetric: 'included',
    minFetchGapMs: MIN_FETCH_GAP_MS,
    lastPlanLabel: () => planLabel,
    errorText(error: unknown, lang: Lang): KeyText {
      return cursorErrorText(error, lang);
    },
    logText(error: unknown): string {
      return safeErrorMessage(error);
    },
    metricLabel(metric: UsageMetric, lang: Lang): string {
      if (metric.id === 'included') return lang === 'zh' ? '套餐' : 'Included';
      if (metric.id === 'auto') return 'Auto';
      if (metric.id === 'api') return 'API';
      if (metric.id === 'ondemand') return lang === 'zh' ? '按量' : 'On-demand';
      return metric.label;
    },
    missingText(metricId: string, lang: Lang): KeyText | null {
      if (
        metricId === 'included' ||
        metricId === 'auto' ||
        metricId === 'api'
      ) {
        return lang === 'zh'
          ? { title: '没有这项', message: '此方案未返回' }
          : { title: 'Not reported', message: 'Plan omitted it' };
      }
      if (metricId === 'ondemand') {
        return lang === 'zh'
          ? { title: '没有按量', message: '未设置按量上限' }
          : { title: 'No on-demand', message: 'No on-demand cap' };
      }
      return null;
    },
    keepLastOnError(error: unknown): boolean {
      return (
        error instanceof CursorUsageError &&
        (error.problem === 'network' || error.problem === 'http')
      );
    },
    async preparePress() {
      // A denial is remembered so the poll does not raise the keychain
      // dialog every minute. A press may ask again, then the refresh runs.
      allowCursorKeychainPrompt();
    },
    async fetch(config: PluginConfig): Promise<UsageMetric[]> {
      return (await fetchMetrics(config)).metrics;
    },
    async describe(config: PluginConfig): Promise<UsageDescription> {
      try {
        const result = await fetchMetrics(config);
        return {
          success: true,
          metrics: result.metrics,
          planLabel: result.planLabel,
        };
      } catch (error) {
        return {
          success: false,
          error: safeErrorMessage(error),
          code: error instanceof CursorUsageError ? error.code : undefined,
          problem:
            error instanceof CursorUsageError ? error.problem : undefined,
        };
      }
    },
  };
}

export const usageSource: UsageSource = createCursorUsageSource();
