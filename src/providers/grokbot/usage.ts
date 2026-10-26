/**
 * Grok Bot usage meter: the weekly allowance the app's own account menu
 * shows ("Weekly usage NN%").
 *
 * POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus
 * Connect-RPC, empty JSON body, Authorization: Bearer <Cursor access token>.
 * The token is the Cursor app's, read from its state database
 * (./usageAuth.ts). A sealed cell is opened with the login keychain; a
 * value that is not a JWT is not sent. It is Grok Bot's allowance only
 * when that app is installed and Cursor is signed into the same account;
 * with no Grok Bot install the key does not ask, because the same call
 * would still answer for whichever account Cursor is using.
 * install the key does not ask, because the same call would still answer
 * for whichever account Cursor is using.
 *
 * The local transcript mirror has no token counts, so this percentage is
 * the only usage number. It is how much of the week is used.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';

import { safeErrorMessage } from '../../redact';
import {
  KeyText,
  Lang,
  PluginConfig,
  UsageDescription,
  UsageMetric,
  UsageSource,
} from '../types';

import { allowCursorKeychainPrompt } from './cursorSeal';
import {
  cursorStateDb,
  grokbotAppCandidates,
  grokbotDataRoot,
  grokbotUserDataDir,
} from './paths';
import { readCursorAccessToken } from './usageAuth';
import { decodeSandUsage, refusalError } from './usageDecode';
import { GrokbotUsageError, grokbotErrorText } from './usageText';

export const SAND_USAGE_ENDPOINT =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';

const MIN_FETCH_GAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 1_000_000;

export type GrokbotUsageDeps = {
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
    grokbotUserDataDir(config, env, home, platform),
    grokbotDataRoot(config, env, home),
    ...grokbotAppCandidates(home, platform, env),
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
    throw new GrokbotUsageError(
      'parse',
      'Grok Bot usage response could not be read'
    );
  }
  if (text.length > MAX_BODY_CHARS) {
    throw new GrokbotUsageError(
      'parse',
      'Grok Bot usage response was too large'
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GrokbotUsageError(
      'parse',
      'Grok Bot usage response was not JSON'
    );
  }
}

function retryAfter(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const parsed = Number.isFinite(seconds) ? Math.ceil(seconds) : 300;
  return Math.min(Math.max(parsed, 60), 24 * 60 * 60);
}

/** A Grok Bot usage source. Tests pass stubs; the plugin uses `usageSource`. */
export function createGrokbotUsageSource(
  deps: GrokbotUsageDeps = {}
): UsageSource & { lastPlanLabel(): string | null } {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const loadToken =
    deps.loadToken ?? ((file: string) => readCursorAccessToken(file));
  let planLabel: string | null = null;

  async function fetchMetrics(config: PluginConfig): Promise<FetchResult> {
    if (!installed(config, exists, env, home, platform)) {
      throw new GrokbotUsageError(
        'not-installed',
        'Grok Bot is not installed: no app, user-data folder or data root was found'
      );
    }
    const databasePath = cursorStateDb(config, env, home, platform);
    let token: string | null;
    try {
      token = (await loadToken(databasePath))?.trim() || null;
    } catch (error) {
      if (error instanceof GrokbotUsageError) throw error;
      throw new GrokbotUsageError(
        'state-unreadable',
        'Cursor state database could not be read'
      );
    }
    if (!token) {
      throw new GrokbotUsageError(
        'not-signed-in',
        'No Cursor login found. Sign in to the Cursor app with the account Grok Bot uses'
      );
    }

    let response: Response;
    try {
      response = await fetchImpl(SAND_USAGE_ENDPOINT, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Connect-Protocol-Version': '1',
        },
      });
    } catch {
      throw new GrokbotUsageError(
        'network',
        'The Grok Bot usage request failed before a response arrived'
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new GrokbotUsageError(
        'login-expired',
        `Cursor rejected the Grok Bot usage request (HTTP ${response.status})`
      );
    }
    if (response.status === 429) {
      throw new GrokbotUsageError(
        'rate-limited',
        'Cursor rate-limited the Grok Bot usage request',
        { retryAfterSeconds: retryAfter(response.headers.get('retry-after')) }
      );
    }
    if (response.status >= 500) {
      throw new GrokbotUsageError(
        'http',
        `Grok Bot usage request failed: HTTP ${response.status}`
      );
    }
    if (!response.ok) {
      throw new GrokbotUsageError(
        'parse',
        `Grok Bot usage request failed: HTTP ${response.status}`
      );
    }

    const body = await readBody(response);
    if (
      body &&
      typeof body === 'object' &&
      (body as { code?: unknown }).code === 'unauthenticated'
    ) {
      throw new GrokbotUsageError(
        'login-expired',
        'Cursor rejected the Grok Bot usage request'
      );
    }
    const decoded = decodeSandUsage(body);
    if (!decoded) {
      throw new GrokbotUsageError(
        'parse',
        'Cursor returned an unrecognized Grok Bot usage response'
      );
    }
    if (decoded.kind !== 'metric') throw refusalError(decoded.kind);
    planLabel = decoded.planLabel;
    return { metrics: [decoded.metric], planLabel: decoded.planLabel };
  }

  return {
    defaultMetric: 'weekly',
    minFetchGapMs: MIN_FETCH_GAP_MS,
    lastPlanLabel: () => planLabel,
    errorText(error: unknown, lang: Lang): KeyText {
      return grokbotErrorText(error, lang);
    },
    logText(error: unknown): string {
      return safeErrorMessage(error);
    },
    metricLabel(metric: UsageMetric, lang: Lang): string {
      if (metric.id === 'weekly') return lang === 'zh' ? '每周' : 'Weekly';
      return metric.label;
    },
    keepLastOnError(error: unknown): boolean {
      return (
        error instanceof GrokbotUsageError &&
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
          code: error instanceof GrokbotUsageError ? error.code : undefined,
          problem:
            error instanceof GrokbotUsageError ? error.problem : undefined,
        };
      }
    },
  };
}

export const usageSource: UsageSource = createGrokbotUsageSource();
