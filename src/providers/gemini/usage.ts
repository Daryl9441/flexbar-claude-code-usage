/**
 * Gemini usage meter source: the daily per-model request quota Gemini Code
 * Assist reports for the Gemini CLI's "Login with Google" login.
 *
 * One fetch reads the CLI's login type and token pair from the Gemini CLI
 * home (./paths.ts, read-only), refreshes an expired access token in memory
 * (./usageCreds.ts, with the CLI's own OAuth client, ./usageCli.ts), looks
 * up the tier and Google Cloud project once an hour (loadCodeAssist) and
 * reads the quota (retrieveUserQuota, ./usageApi.ts). Buckets become
 * metrics in ./usageMetrics.ts.
 *
 * Only Code Assist Standard/Enterprise licences report quota: Google
 * answers personal accounts as ineligible (UNSUPPORTED_CLIENT and the like),
 * and API-key or Vertex AI logins have no quota endpoint. Those get a clear short key text
 * (./usageText.ts) without repeated requests.
 */
import os from 'node:os';

import { ProviderError } from '../kit';
import {
  PluginConfig,
  UsageDescription,
  UsageMetric,
  UsageSource,
} from '../types';

import { geminiHome } from './paths';
import {
  GeminiSetup,
  LoadCodeAssistResponse,
  RetrieveUserQuotaResponse,
  describeFailure,
  loadCodeAssistBody,
  postCodeAssist,
  resolveSetup,
} from './usageApi';
import { GeminiCli, findGeminiCli, readOAuthClient } from './usageCli';
import {
  GeminiTokens,
  OAuthCreds,
  homeExists,
  loginFingerprint,
  readAuthType,
  readOAuthCreds,
} from './usageCreds';
import { bucketsToMetrics } from './usageMetrics';
import { GeminiProblem, GeminiUsageError, geminiErrorText } from './usageText';

/** Shortest gap between two quota requests (also for the settings page) */
const MIN_FETCH_GAP_MS = 30_000;
/** How long a found project/tier is trusted (the CLI re-checks hourly) */
const SETUP_TTL_MS = 60 * 60_000;
/** How long an account problem is trusted before asking Google again */
const PROBLEM_TTL_MS: Partial<Record<GeminiProblem, number>> = {
  'personal-unsupported': 6 * 60 * 60_000,
  'not-eligible': 6 * 60 * 60_000,
  region: 6 * 60 * 60_000,
  'needs-project': 60 * 60_000,
  'needs-setup': 10 * 60_000,
  'verify-account': 10 * 60_000,
};
/** Keep showing the last meter through blips for at most this long */
const KEEP_LAST_MS = 30 * 60_000;

/** Login types Gemini CLI writes to settings.json */
const GOOGLE_LOGIN = 'oauth-personal';
const AUTH_PROBLEMS: Record<string, { problem: GeminiProblem; text: string }> =
  {
    'gemini-api-key': {
      problem: 'api-key',
      text: 'Gemini CLI uses a Gemini API key: the Gemini API reports no remaining quota, so there is nothing to show',
    },
    'vertex-ai': {
      problem: 'vertex',
      text: 'Gemini CLI uses Vertex AI: Vertex AI reports no Gemini CLI quota, so there is nothing to show',
    },
  };

export type GeminiUsageOptions = {
  /** fetch to use (default: the global fetch at call time) */
  fetch?: () => typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Home folder for ~ and the default Gemini CLI home */
  home?: () => string;
  /** Finds the Gemini CLI (default: ./usageCli.ts findGeminiCli) */
  findCli?: (config: PluginConfig) => Promise<GeminiCli | null>;
  /** Pause before re-reading a half-written oauth_creds.json */
  credsRetryMs?: number;
};

/** The Google Cloud project setting, else GOOGLE_CLOUD_PROJECT(_ID). */
export function configuredProject(
  config: PluginConfig | null | undefined,
  env: NodeJS.ProcessEnv
): string | null {
  for (const value of [
    config?.geminiCloudProject,
    env.GOOGLE_CLOUD_PROJECT,
    env.GOOGLE_CLOUD_PROJECT_ID,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

type Outcome =
  | { at: number; key: string; metrics: UsageMetric[] }
  | { at: number; key: string; error: unknown };

/** A Gemini usage source; tests pass stubs, the plugin uses `usageSource`. */
export function createGeminiUsageSource(
  options: GeminiUsageOptions = {}
): UsageSource & {
  /** The tier of the last successful fetch (settings page) */
  lastSetup(): GeminiSetup | null;
} {
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  const homeDir = options.home ?? (() => os.homedir());
  const fetchImpl = options.fetch ?? (() => globalThis.fetch);
  const findCli =
    options.findCli ??
    ((config: PluginConfig) => findGeminiCli(config, { env, home: homeDir() }));

  const tokens = new GeminiTokens({ fetch: fetchImpl, now });
  /** project/tier or problem per login + configured project */
  const setups = new Map<
    string,
    { at: number; ttl: number; setup?: GeminiSetup; error?: unknown }
  >();
  /** request limits per model, for the Auto pool of a used-up model */
  const limits = new Map<string, number>();
  let recent: Outcome | null = null;
  let inFlight: { key: string; promise: Promise<UsageMetric[]> } | null = null;
  let lastSuccessAt = 0;
  let lastSetup: GeminiSetup | null = null;

  /** Throws the problem of a login type without quota, if it is one. */
  function checkAuthType(authType: string | null) {
    if (!authType || authType === GOOGLE_LOGIN) return;
    const known = AUTH_PROBLEMS[authType];
    if (known) throw new GeminiUsageError(known.problem, known.text);
    throw new GeminiUsageError(
      'other-auth',
      `Gemini CLI uses the "${authType.replace(/[^\w.-]/g, '').slice(0, 40)}" login, which reports no quota: only "Login with Google" does`
    );
  }

  async function loginOrThrow(
    config: PluginConfig,
    home: string
  ): Promise<OAuthCreds> {
    const creds = await readOAuthCreds(home, options.credsRetryMs);
    if (creds) return creds;
    if (!(await findCli(config)) && !(await homeExists(home))) {
      throw new GeminiUsageError(
        'cli-missing',
        'Gemini CLI not found: install it, or set "Gemini CLI program" and "Gemini CLI folder" in the plugin settings'
      );
    }
    throw new GeminiUsageError(
      'logged-out',
      'No Gemini CLI login found: run gemini and choose "Login with Google"'
    );
  }

  async function fetchMetrics(config: PluginConfig): Promise<UsageMetric[]> {
    const home = geminiHome(config, env, homeDir());
    checkAuthType(await readAuthType(home));
    const creds = await loginOrThrow(config, home);
    const project = configuredProject(config, env);
    const setupKey = `${loginFingerprint(creds)}|${project ?? ''}`;

    // a known account problem is not asked again until it may have changed
    let entry = setups.get(setupKey);
    if (entry && now() - entry.at >= entry.ttl) {
      setups.delete(setupKey);
      entry = undefined;
    }
    if (entry?.error) throw entry.error;

    let cli: GeminiCli | null | undefined;
    const lookup = async () => {
      if (cli === undefined) cli = await findCli(config);
      const client = cli?.root ? await readOAuthClient(cli.root) : null;
      return { client, cliFound: !!cli };
    };
    let token = await tokens.token(creds, lookup);
    let retried = false;

    /** One call, retried once with a freshly refreshed token after a 401. */
    const call = async (
      method: 'loadCodeAssist' | 'retrieveUserQuota',
      body: unknown
    ) => {
      for (;;) {
        const version = cli?.version ?? null;
        const reply = await postCodeAssist(
          fetchImpl(),
          method,
          body,
          token,
          version
        );
        if (reply.status !== 401) return reply;
        if (retried) {
          throw new GeminiUsageError(
            'login-expired',
            `Gemini ${method} rejected the login (HTTP 401): run gemini to log in again`
          );
        }
        retried = true;
        token = await tokens.token(creds, lookup, { force: true });
      }
    };

    let setup = entry?.setup;
    if (!setup) {
      const reply = await call('loadCodeAssist', loadCodeAssistBody(project));
      if (reply.status === 403 && project) {
        throw new GeminiUsageError(
          'project-denied',
          `Gemini Code Assist refused the Google Cloud project (${describeFailure(reply)}): check "Gemini Cloud project" in the plugin settings`
        );
      }
      if (reply.status < 200 || reply.status >= 300) {
        throw new ProviderError(
          'http',
          `Gemini loadCodeAssist failed with ${describeFailure(reply)}`
        );
      }
      try {
        setup = resolveSetup(reply.data as LoadCodeAssistResponse, project);
        setups.set(setupKey, { at: now(), ttl: SETUP_TTL_MS, setup });
      } catch (error) {
        const ttl =
          error instanceof GeminiUsageError
            ? PROBLEM_TTL_MS[error.problem]
            : undefined;
        if (ttl) setups.set(setupKey, { at: now(), ttl, error });
        throw error;
      }
    }

    const reply = await call('retrieveUserQuota', { project: setup.project });
    if (reply.status === 403 || reply.status === 404) {
      // the project may have changed: look it up again next time
      setups.delete(setupKey);
      if (project) {
        throw new GeminiUsageError(
          'project-denied',
          `Gemini retrieveUserQuota refused the Google Cloud project (${describeFailure(reply)}): check "Gemini Cloud project" in the plugin settings`
        );
      }
      throw new ProviderError(
        'http',
        `Gemini retrieveUserQuota failed with ${describeFailure(reply)}`
      );
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new ProviderError(
        'http',
        `Gemini retrieveUserQuota failed with ${describeFailure(reply)}`
      );
    }
    const metrics = bucketsToMetrics(
      (reply.data as RetrieveUserQuotaResponse | null)?.buckets,
      limits
    );
    if (metrics.length === 0) {
      throw new GeminiUsageError(
        'no-quota',
        'Gemini Code Assist reported no model quota for this account'
      );
    }
    lastSetup = setup;
    return metrics;
  }

  /** Where a fetch reads from; a change skips the recent-result cache. */
  function outcomeKey(config: PluginConfig): string {
    return [
      geminiHome(config, env, homeDir()),
      configuredProject(config, env) ?? '',
      typeof config?.geminiPath === 'string' ? config.geminiPath : '',
    ].join('\n');
  }

  async function fetchFresh(
    config: PluginConfig,
    key: string
  ): Promise<UsageMetric[]> {
    try {
      const metrics = await fetchMetrics(config);
      recent = { at: now(), key, metrics };
      lastSuccessAt = now();
      return metrics;
    } catch (error) {
      recent = { at: now(), key, error };
      throw error;
    }
  }

  /**
   * Never more than one round of requests per gap and one at a time,
   * whoever asks (the keys' poll or a settings page).
   */
  async function fetchOnce(config: PluginConfig): Promise<UsageMetric[]> {
    const settings = config ?? {};
    const key = outcomeKey(settings);
    if (recent && recent.key === key && now() - recent.at < MIN_FETCH_GAP_MS) {
      if ('metrics' in recent) return recent.metrics;
      throw recent.error;
    }
    if (inFlight?.key === key) return inFlight.promise;
    const promise = fetchFresh(settings, key).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { key, promise };
    return promise;
  }

  return {
    defaultMetric: 'lowest',
    minFetchGapMs: MIN_FETCH_GAP_MS,
    fetch: fetchOnce,
    logText: error => geminiErrorText(error),
    // model names stay as Google writes them; the pooled limit is "Auto"
    metricLabel: (metric, lang) =>
      lang === 'zh' && metric.id === 'pooled' ? '自动' : metric.label,
    keepLastOnError(error) {
      if (!(error instanceof ProviderError)) return false;
      const transient =
        error.code === 'network' ||
        error.code === 'http' ||
        (error instanceof GeminiUsageError &&
          error.problem === 'creds-unreadable');
      return (
        transient && lastSuccessAt > 0 && now() - lastSuccessAt < KEEP_LAST_MS
      );
    },
    async describe(config: PluginConfig): Promise<UsageDescription> {
      try {
        const metrics = await fetchOnce(config);
        return {
          success: true,
          metrics,
          tier: lastSetup?.tierName ?? lastSetup?.tierId ?? null,
        };
      } catch (error) {
        return {
          success: false,
          error: geminiErrorText(error),
          problem: error instanceof GeminiUsageError ? error.problem : null,
          code: error instanceof ProviderError ? error.code : null,
        };
      }
    },
    lastSetup: () => lastSetup,
  };
}

export const usageSource: UsageSource = createGeminiUsageSource();
