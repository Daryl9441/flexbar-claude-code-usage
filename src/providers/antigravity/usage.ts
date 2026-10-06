/**
 * Antigravity usage meter source: the account's model quota as Antigravity
 * itself reports it.
 *
 * The desktop app and the IDE each run a language server (LS) on
 * 127.0.0.1; one Connect-JSON request to it (`RetrieveUserQuotaSummary`,
 * about 1 KB, answered from the LS's own cache) gives every model group's
 * limits (today: Gemini and Claude/GPT-OSS, each with a 5-hour and a
 * weekly bucket). The LS is found with `ps` (its CSRF token is on its
 * command line) and `lsof` (its ports): ./usageProcess.ts. The app is asked
 * first (on macOS it keeps running in the menu bar), then the IDE; every
 * product shares one Google account, so either gives the same numbers.
 * Buckets become metrics in ./usageMetrics.ts, the dual face is
 * ./usageFace.ts, key texts ./usageText.ts.
 *
 * Cost: at most one round per 30 s (ps ≈ 40 ms, lsof ≈ 20 ms, one small
 * loopback request). The LS is asked to refresh from Google (forceRefresh)
 * on the first fetch, at most every 15 minutes after that, when a limit's
 * reset time has passed, and when a settings page opens (at most once a
 * minute). A forced request waits on Google (seconds), so it gets a longer
 * deadline; one that runs out is asked again unforced on the same port
 * (the LS answers from its cache in about a millisecond) and counts as the
 * refresh, so a slow Google never blanks the key. GetUserStatus (≈ 30 KB:
 * plan name, per-model quota) only feeds the settings page (every 30
 * minutes at most) and the no-groups fallback.
 *
 * The CSRF token stays in memory and only goes to a port lsof attributes
 * to the LS it came from, in a header (./usageRpc.ts). The agy CLI keeps
 * its quota inside its own process: an agy-only install gets a clear
 * "needs the app" text, never a spawned agy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProviderError, markOptions } from '../kit';
import {
  PluginConfig,
  UsageDescription,
  UsageFace,
  UsageFaceRequest,
  UsageMetric,
  UsageSource,
} from '../types';

import { ANTIGRAVITY_BRAND } from './brand';
import { antigravityPathSetting, installedProducts } from './paths';
import { dualEmpty, dualMissingText, renderGroupDualKey } from './usageFace';
import {
  DualView,
  QuotaGroupView,
  anyStale,
  cleanText,
  dualViews,
  groupMetrics,
  localizeLabel,
  modelMetrics,
  parseQuotaSummary,
} from './usageMetrics';
import {
  LanguageServer,
  RunFile,
  ServerProduct,
  currentUid,
  findServers,
  runFile,
  serverPorts,
  toolPaths,
} from './usageProcess';
import {
  RpcPost,
  RpcResult,
  RpcTransportError,
  classifyReply,
  describeTransport,
  httpPost,
} from './usageRpc';
import {
  AntigravityProblem,
  AntigravityUsageError,
  antigravityErrorText,
} from './usageText';

/** Shortest gap between two quota rounds (also for the settings page) */
const MIN_FETCH_GAP_MS = 30_000;
/** How long a process lookup is trusted while requests succeed */
const DISCOVERY_TTL_MS = 30_000;
/** Ask the LS to refresh from Google at least this often */
const FORCE_EVERY_MS = 15 * 60_000;
/** …and never more often than this */
const FORCE_MIN_GAP_MS = 60_000;
/** Plan name (settings page) from GetUserStatus, cached this long */
const STATUS_TTL_MS = 30 * 60_000;
/** GetUserStatus when the summary has no groups (sign-in, models) */
const STATUS_FALLBACK_TTL_MS = 10 * 60_000;
/** Keep showing the last meter through blips for at most this long */
const KEEP_LAST_MS = 30 * 60_000;
/**
 * …but after the app and the IDE quit only this long (a restart): the quota
 * is account-wide and agy keeps using it while nothing can read it
 */
const KEEP_NOT_RUNNING_MS = 2 * 60_000;
const RPC_TIMEOUT_MS = 5_000;
/** A forced refresh waits on Google: a longer deadline */
const FORCED_RPC_TIMEOUT_MS = 20_000;
const QUOTA_MAX_BYTES = 512 * 1024;
const STATUS_MAX_BYTES = 4 * 1024 * 1024;

const QUOTA_METHOD = 'RetrieveUserQuotaSummary';
const QUOTA_BODY = { request: {} };
const QUOTA_FORCED_BODY = { request: {}, forceRefresh: true };
const STATUS_METHOD = 'GetUserStatus';
const STATUS_BODY = {
  metadata: {
    ideName: 'antigravity',
    extensionName: 'antigravity',
    locale: 'en',
  },
};

/** Connect codes that mean "no signed-in account". */
const SIGNED_OUT_CODES = new Set(['unauthenticated', 'permission_denied']);
/** Connect codes of a forced refresh worth retrying from the cache */
const RETRY_UNFORCED = new Set([
  'unavailable',
  'deadline_exceeded',
  'internal',
  'unknown',
  'aborted',
]);

const PRODUCT_NAMES: Record<ServerProduct, string> = {
  app: 'the Antigravity app',
  ide: 'the Antigravity IDE',
};

export type AntigravityUsageOptions = {
  now?: () => number;
  /** Home folder for ~ and the default data folders */
  home?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs ps/lsof (default: execFile, no shell) */
  run?: RunFile;
  /** Where ps and lsof are */
  tools?: () => { ps: string; lsof: string };
  /** The user whose processes count (default: this process's uid) */
  uid?: () => number | null;
  /** The loopback transport (default: node:http to 127.0.0.1) */
  post?: RpcPost;
  /** Whether a file or folder exists (app bundles, agy) */
  exists?: (file: string) => boolean;
  /** Folders holding Antigravity.app / Antigravity IDE.app (macOS) */
  appFolders?: () => string[];
};

/** What GetUserStatus says, reduced to what the key uses. */
type StatusInfo = {
  signedIn: boolean;
  tier: string | null;
  models: UsageMetric[];
};

type Answer = { result: RpcResult; server: LanguageServer };

/**
 * A forced request: its deadline, the unforced body asked on the same port
 * when it runs out, and whether the LS got it (answered or timed out).
 */
type ForcedCall = { timeoutMs: number; fallback: unknown; reached: boolean };

/** True for a request that ran out of time (the LS may still be busy). */
function timedOut(error: unknown): boolean {
  return error instanceof RpcTransportError && error.reason === 'timeout';
}

type Outcome =
  | { at: number; key: string; metrics: UsageMetric[] }
  | { at: number; key: string; error: unknown };

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Plan name and sign-in state from a GetUserStatus answer (no identity). */
export function statusInfo(json: unknown, now: number): StatusInfo {
  const root = (json && typeof json === 'object' ? json : {}) as Record<
    string,
    unknown
  >;
  const status = (
    root.userStatus && typeof root.userStatus === 'object'
      ? root.userStatus
      : {}
  ) as Record<string, unknown>;
  const tier = (
    status.userTier && typeof status.userTier === 'object'
      ? status.userTier
      : {}
  ) as Record<string, unknown>;
  const planInfo = (value: unknown) =>
    value && typeof value === 'object'
      ? ((value as { planInfo?: unknown }).planInfo as
          Record<string, unknown> | undefined)
      : undefined;
  const plan = planInfo(status.planStatus) ?? planInfo(root) ?? {};
  // only the presence of an account is checked, never its name or address
  const signedIn = nonEmpty(status.email) || nonEmpty(tier.id);
  const tierName =
    cleanText(tier.name, 40) || cleanText(plan.planName, 40) || null;
  return {
    signedIn,
    tier: signedIn ? tierName : null,
    models: modelMetrics(json, now),
  };
}

/** An Antigravity usage source; tests pass stubs, the plugin uses `usageSource`. */
export function createAntigravityUsageSource(
  options: AntigravityUsageOptions = {}
): UsageSource & {
  /** Which language server answered last (settings page) */
  lastServer(): ServerProduct | null;
} {
  const now = options.now ?? (() => Date.now());
  const homeDir = options.home ?? (() => os.homedir());
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runFile;
  const tools = options.tools ?? toolPaths;
  const uid = options.uid ?? currentUid;
  const post = options.post ?? httpPost;
  const exists =
    options.exists ??
    ((file: string) => {
      try {
        fs.statSync(file);
        return true;
      } catch {
        return false;
      }
    });
  const appFolders =
    options.appFolders ??
    (() => ['/Applications', path.join(homeDir(), 'Applications')]);

  let servers: LanguageServer[] | null = null;
  let discoveredAt = 0;
  /** pid → the port that answered */
  const working = new Map<number, number>();
  let lastForceAt = 0;
  let staleSeen = false;
  let status: { at: number; info: StatusInfo } | null = null;
  let groups: QuotaGroupView[] = [];
  let duals: DualView[] = [];
  let server: ServerProduct | null = null;
  let modelMode = false;
  let recent: Outcome | null = null;
  let inFlight: { key: string; promise: Promise<UsageMetric[]> } | null = null;
  let lastSuccessAt = 0;
  /** When the app and the IDE were first seen not running (0: they run) */
  let notRunningSince = 0;

  // --- installation ----------------------------------------------------------

  function agyFound(config: PluginConfig, home: string): boolean {
    const setting = antigravityPathSetting(config, home);
    if (setting) return exists(setting);
    const dirs = (env.PATH ?? '')
      .split(path.delimiter)
      .map(d => d.trim())
      .filter(d => path.isAbsolute(d));
    dirs.push(
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin'
    );
    return dirs.some(dir => exists(path.join(dir, 'agy')));
  }

  /** What is on this computer: the app or IDE, and/or agy. */
  function installation(config: PluginConfig): {
    desktop: boolean;
    cli: boolean;
  } {
    const home = homeDir();
    const products = installedProducts(config, home);
    let desktop = products.includes('app') || products.includes('ide');
    if (!desktop && platform === 'darwin') {
      desktop = appFolders().some(dir =>
        ['Antigravity.app', 'Antigravity IDE.app'].some(name =>
          exists(path.join(dir, name))
        )
      );
    }
    const cli = products.includes('cli') || agyFound(config, home);
    return { desktop, cli };
  }

  function notRunning(config: PluginConfig): AntigravityUsageError {
    const found = installation(config);
    if (found.desktop) {
      return new AntigravityUsageError(
        'not-running',
        'Neither the Antigravity app nor the Antigravity IDE is running: open one of them to read the quota'
      );
    }
    if (found.cli) {
      return new AntigravityUsageError(
        'cli-only',
        'Only the agy CLI was found: the quota is read from the Antigravity app or IDE while one of them runs'
      );
    }
    return new AntigravityUsageError(
      'not-installed',
      'Antigravity was not found on this computer'
    );
  }

  // --- language servers ------------------------------------------------------

  async function discover(
    force: boolean
  ): Promise<{ list: LanguageServer[]; fresh: boolean }> {
    if (!force && servers && now() - discoveredAt < DISCOVERY_TTL_MS) {
      return { list: servers, fresh: false };
    }
    let found: LanguageServer[];
    try {
      found = await findServers(run, uid(), tools().ps);
    } catch (error) {
      servers = null;
      throw new AntigravityUsageError(
        'unreachable',
        `Could not list the running programs (ps: ${describeTransport(error)})`
      );
    }
    servers = found;
    discoveredAt = now();
    for (const pid of [...working.keys()]) {
      if (!found.some(s => s.pid === pid)) working.delete(pid);
    }
    return { list: found, fresh: true };
  }

  /**
   * One request to the first language server that answers it: the app's,
   * then the IDE's. A server that refuses (signed out there, an error) is
   * passed over while another may do better. Ports that fail at transport
   * level are skipped; when nothing answers and the process lookup was
   * older, it is redone once. Null when no server runs.
   *
   * `forced`: a forced refresh. It gets its own deadline; when it runs out,
   * the same port is asked once more with the unforced body, and every
   * later request of this call is unforced too (the refresh was sent).
   */
  async function call(
    method: string,
    body: unknown,
    maxBytes: number,
    forced?: ForcedCall
  ): Promise<Answer | null> {
    let { list, fresh } = await discover(false);
    let transport = 'no open port';
    let current = body;
    let timeoutMs = forced?.timeoutMs ?? RPC_TIMEOUT_MS;
    const send = async (server: LanguageServer, port: number) =>
      classifyReply(
        await post({
          port,
          method,
          body: current,
          token: server.token,
          timeoutMs,
          maxBytes,
        })
      );
    for (let round = 0; round < 2; round++) {
      if (round === 1) {
        if (fresh) break;
        ({ list, fresh } = await discover(true));
      }
      if (list.length === 0) return null;
      let refused: Answer | null = null;
      for (const candidate of list) {
        const ports = await serverPorts(run, candidate, tools().lsof);
        const known = working.get(candidate.pid);
        const order =
          known !== undefined && ports.includes(known)
            ? [known, ...ports.filter(p => p !== known)]
            : ports;
        let other: Answer | null = null;
        for (const port of order) {
          let result: RpcResult;
          try {
            result = await send(candidate, port);
          } catch (error) {
            transport = describeTransport(error);
            if (!forced || current === forced.fallback || !timedOut(error)) {
              continue;
            }
            // the refresh waits on Google: the LS's cached numbers, here
            forced.reached = true;
            current = forced.fallback;
            timeoutMs = RPC_TIMEOUT_MS;
            try {
              result = await send(candidate, port);
            } catch (retryError) {
              transport = describeTransport(retryError);
              continue;
            }
          }
          if (result.kind === 'wrong-port') continue;
          if (result.kind === 'connect' && result.csrf) {
            transport = 'CSRF token refused';
            break;
          }
          if (forced && current !== forced.fallback) forced.reached = true;
          if (result.kind === 'http') {
            // not the Connect port after all, maybe: try the others first
            other ??= { result, server: candidate };
            continue;
          }
          working.set(candidate.pid, port);
          if (result.kind === 'ok') return { result, server: candidate };
          refused ??= { result, server: candidate };
          other = null;
          break;
        }
        if (other) refused ??= other;
      }
      if (refused) return refused;
    }
    // what was found did not answer: look again next time
    servers = null;
    throw new AntigravityUsageError(
      'unreachable',
      `The Antigravity language server did not answer (${transport})`
    );
  }

  /** The error for an answer that is not a quota summary. */
  function answerError(answer: Answer, method: string): ProviderError {
    const { result } = answer;
    const from = PRODUCT_NAMES[answer.server.product];
    if (result.kind === 'connect') {
      const { code, status: httpStatus } = result;
      if (SIGNED_OUT_CODES.has(code)) {
        return new AntigravityUsageError(
          'signed-out',
          `${from} reports no signed-in account (${code})`
        );
      }
      if (code === 'resource_exhausted') {
        return new ProviderError(
          'rate-limited',
          `${from} reports the quota request as rate limited (${code})`,
          { retryAfterSeconds: 300 }
        );
      }
      if (code === 'unimplemented') {
        return new AntigravityUsageError(
          'old-version',
          `${from} has no ${method} (${code}): update Antigravity`
        );
      }
      if (code === 'unavailable' || code === 'deadline_exceeded') {
        return new ProviderError(
          'network',
          `${from} could not reach Google (${code})`
        );
      }
      return new ProviderError(
        'http',
        `${from} answered ${method} with HTTP ${httpStatus} (${code})`
      );
    }
    if (result.kind === 'http') {
      return result.status === 404
        ? new AntigravityUsageError(
            'old-version',
            `${from} has no ${method} (HTTP 404): update Antigravity`
          )
        : new ProviderError(
            'http',
            `${from} answered ${method} with HTTP ${result.status}`
          );
    }
    return new ProviderError(
      'parse',
      `${from} sent a ${method} answer that is not JSON`
    );
  }

  /** GetUserStatus, cached for `ttl`; null when it cannot be read. */
  async function userStatus(ttl: number): Promise<StatusInfo | null> {
    if (status && now() - status.at < ttl) return status.info;
    const answer = await call(STATUS_METHOD, STATUS_BODY, STATUS_MAX_BYTES);
    if (!answer) return null;
    const { result } = answer;
    let info: StatusInfo;
    if (result.kind === 'ok') info = statusInfo(result.json, now());
    else if (result.kind === 'connect' && SIGNED_OUT_CODES.has(result.code)) {
      info = { signedIn: false, tier: null, models: [] };
    } else return null;
    status = { at: now(), info };
    return info;
  }

  // --- quota -------------------------------------------------------------------

  function forceDue(): boolean {
    const since = now() - lastForceAt;
    return (
      lastForceAt === 0 ||
      since >= FORCE_EVERY_MS ||
      (staleSeen && since >= FORCE_MIN_GAP_MS)
    );
  }

  async function quota(force: boolean): Promise<Answer | null> {
    if (!force) return call(QUOTA_METHOD, QUOTA_BODY, QUOTA_MAX_BYTES);
    const forced: ForcedCall = {
      timeoutMs: FORCED_RPC_TIMEOUT_MS,
      fallback: QUOTA_BODY,
      reached: false,
    };
    let answer: Answer | null;
    try {
      answer = await call(
        QUOTA_METHOD,
        QUOTA_FORCED_BODY,
        QUOTA_MAX_BYTES,
        forced
      );
    } finally {
      // a refresh the LS got counts, answered or not: no retry every round
      if (forced.reached) lastForceAt = now();
    }
    // a refresh Google did not answer: the LS's cached numbers will do
    if (
      answer?.result.kind === 'connect' &&
      RETRY_UNFORCED.has(answer.result.code)
    ) {
      return call(QUOTA_METHOD, QUOTA_BODY, QUOTA_MAX_BYTES);
    }
    return answer;
  }

  /** The quota without groups: per-model quota, or why there is none. */
  async function withoutGroups(
    answer: Answer | null,
    config: PluginConfig
  ): Promise<UsageMetric[]> {
    let info: StatusInfo | null = null;
    try {
      info = await userStatus(STATUS_FALLBACK_TTL_MS);
    } catch {
      info = null;
    }
    if (info && !info.signedIn) {
      throw new AntigravityUsageError(
        'signed-out',
        'Antigravity reports no signed-in account'
      );
    }
    if (info && info.models.length > 0) return info.models;
    if (answer && answer.result.kind !== 'ok') {
      throw answerError(answer, QUOTA_METHOD);
    }
    if (!answer) throw notRunning(config);
    throw new AntigravityUsageError(
      'no-quota',
      'Antigravity reported no model quota for this account'
    );
  }

  async function fetchMetrics(
    config: PluginConfig,
    wantForce: boolean
  ): Promise<UsageMetric[]> {
    if (platform === 'win32') {
      throw new AntigravityUsageError(
        'unsupported-os',
        'The Antigravity usage key finds Antigravity with ps and lsof (macOS and Linux only)'
      );
    }
    const force =
      (wantForce && now() - lastForceAt >= FORCE_MIN_GAP_MS) || forceDue();
    const answer = await quota(force);
    if (!answer) throw notRunning(config);
    const { result } = answer;
    if (result.kind !== 'ok') {
      const unimplemented =
        (result.kind === 'connect' && result.code === 'unimplemented') ||
        (result.kind === 'http' && result.status === 404);
      if (!unimplemented) throw answerError(answer, QUOTA_METHOD);
    }

    const parsed =
      result.kind === 'ok' ? parseQuotaSummary(result.json, now()) : [];
    let metrics = groupMetrics(parsed);
    modelMode = false;
    if (metrics.length === 0) {
      metrics = await withoutGroups(answer, config);
      modelMode = true;
    }
    // a passed reset asks for a refresh, unless this was one already
    staleSeen = anyStale(parsed) && !force;
    if (!modelMode && status && !status.info.signedIn) status = null;
    groups = parsed;
    duals = dualViews(parsed);
    server = answer.server.product;
    return metrics;
  }

  /** Where a fetch looks; a change skips the recent-result cache. */
  function outcomeKey(config: PluginConfig): string {
    return [
      typeof config?.antigravityDir === 'string' ? config.antigravityDir : '',
      typeof config?.antigravityPath === 'string' ? config.antigravityPath : '',
    ].join('\n');
  }

  async function fetchFresh(
    config: PluginConfig,
    key: string,
    force: boolean
  ): Promise<UsageMetric[]> {
    try {
      const metrics = await fetchMetrics(config, force);
      recent = { at: now(), key, metrics };
      lastSuccessAt = now();
      notRunningSince = 0;
      return metrics;
    } catch (error) {
      recent = { at: now(), key, error };
      if (problemOf(error) !== 'not-running') notRunningSince = 0;
      else if (notRunningSince === 0) notRunningSince = now();
      throw error;
    }
  }

  /**
   * Never more than one round per gap and one at a time, whoever asks (the
   * keys' poll or a settings page).
   */
  async function fetchOnce(
    config: PluginConfig,
    force = false
  ): Promise<UsageMetric[]> {
    const settings = config ?? {};
    const key = outcomeKey(settings);
    if (recent && recent.key === key && now() - recent.at < MIN_FETCH_GAP_MS) {
      if ('metrics' in recent) return recent.metrics;
      throw recent.error;
    }
    if (inFlight?.key === key) return inFlight.promise;
    const promise = fetchFresh(settings, key, force).finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
    inFlight = { key, promise };
    return promise;
  }

  // --- faces and the settings page ---------------------------------------------

  /** The view for a `<key>-dual` setting, also when the last fetch lacks it. */
  function dualFor(metric: string): DualView | null {
    const known = duals.find(view => view.id === metric);
    if (known) return known;
    const m = /^(.+)-dual$/.exec(metric);
    if (!m) return null;
    const key = m[1];
    const short = key === '3p' ? 'Claude' : key === 'gemini' ? 'Gemini' : key;
    const id = (window: string) =>
      ['gemini', '3p'].includes(key)
        ? `${key}-${window}`
        : `bucket:${key}-${window}`;
    return {
      id: metric,
      short,
      group: short,
      fiveHour: id('5h'),
      weekly: id('weekly'),
    };
  }

  async function face(request: UsageFaceRequest): Promise<UsageFace | null> {
    const view = dualFor(request.metric);
    if (!view) return null;
    const find = (id: string) =>
      request.metrics.find(metric => metric.id === id) ?? null;
    const fiveHour = find(view.fiveHour);
    const weekly = find(view.weekly);
    if (dualEmpty(fiveHour, weekly)) {
      return { text: dualMissingText(request.lang) };
    }
    const marks = markOptions(ANTIGRAVITY_BRAND, request.data);
    return {
      image: await renderGroupDualKey(
        request.width,
        view.short,
        fiveHour,
        weekly,
        {
          showResetTime: request.showResetTime,
          bgColor: request.bgColor,
          mark: marks.mark,
          markColor: marks.markColor,
        }
      ),
    };
  }

  function problemOf(error: unknown): AntigravityProblem | null {
    return error instanceof AntigravityUsageError ? error.problem : null;
  }

  async function describe(config: PluginConfig): Promise<UsageDescription> {
    try {
      const metrics = await fetchOnce(config, true);
      let tier: string | null = null;
      try {
        tier = (await userStatus(STATUS_TTL_MS))?.tier ?? null;
      } catch {
        tier = null;
      }
      return {
        success: true,
        metrics,
        tier,
        server,
        models: modelMode,
        groups: groups.map(group => ({
          key: group.key,
          name: group.name,
          short: group.short,
          description: group.description,
          buckets: group.buckets.map(bucket => ({
            id: bucket.metricId,
            name: bucket.name,
            window: bucket.window,
            left: bucket.left,
            amount: bucket.amount,
            resetsAt: bucket.resetsAt,
            disabled: bucket.disabled,
          })),
        })),
        views: duals.map(view => ({
          id: view.id,
          group: view.group,
          short: view.short,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: antigravityErrorText(error),
        problem: problemOf(error),
        code: error instanceof ProviderError ? error.code : null,
      };
    }
  }

  return {
    defaultMetric: 'lowest',
    minFetchGapMs: MIN_FETCH_GAP_MS,
    fetch: config => fetchOnce(config),
    logText: error => antigravityErrorText(error),
    metricLabel: (metric, lang) => localizeLabel(metric.label, lang),
    face,
    keepLastOnError(error) {
      if (!(error instanceof ProviderError)) return false;
      if (lastSuccessAt === 0 || now() - lastSuccessAt >= KEEP_LAST_MS) {
        return false;
      }
      if (error.code === 'network' || error.code === 'http') return true;
      // the app or the IDE restarting, not quitting: a short while only
      return (
        problemOf(error) === 'not-running' &&
        notRunningSince > 0 &&
        now() - notRunningSince < KEEP_NOT_RUNNING_MS
      );
    },
    describe,
    lastServer: () => server,
  };
}

export const usageSource: UsageSource = createAntigravityUsageSource();
