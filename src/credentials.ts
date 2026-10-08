/**
 * A usable Claude Code access token: the stored one (src/credentialStore.ts),
 * or a refreshed one when it expired. The refresh follows Claude Code's own
 * protocol: under its refresh lock, never with a refresh token the token
 * endpoints rejected, and written back only into the login it came from.
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { LockTimings, acquireCliLock } from './cliLock';
import {
  StoreLogger,
  StoredCredentials,
  TokenUpdate,
  canPersist,
  getCredentials,
  persistRefreshed,
} from './credentialStore';
import { readTextPrefix } from './httpText';
import { RequestSentError, proxiedFetch } from './proxy';
import { safeErrorMessage } from './redact';

export { getCredentials };
export type { StoredCredentials };

export type RefreshLogger = StoreLogger;

export type RefreshOptions = {
  /** Refresh regardless of the stored expiry (e.g. after a 401) */
  force?: boolean;
  /** The access token the usage endpoint just rejected (with `force`) */
  rejectedToken?: string;
  logger?: RefreshLogger;
  /** The claudeProxy setting (src/proxy.ts) for the token request */
  proxy?: string;
  /** Timings for Claude Code's refresh lock (tests use short ones) */
  lock?: LockTimings;
  /** Deadline of one token request (tests use a short one) */
  requestTimeoutMs?: number;
};

/**
 * Claude Code's login can no longer give a token: it signed out (cleared its
 * tokens after the refresh token was rejected), or the token endpoints reject
 * the stored refresh token (invalid_grant). Only a new login helps.
 */
export class ClaudeLoginExpiredError extends Error {}

/**
 * Claude Code's refresh lock (proper-lockfile: stale after 60 s, mtime
 * updated every 5 s). It retries a held lock 5 times, 1-2 s apart. The plugin
 * stops refreshing the mtime after 40 s, so even a stuck refresh frees it.
 */
export const CLAUDE_LOCK: LockTimings = {
  retries: 5,
  delayMs: 1_500,
  staleMs: 60_000,
  updateMs: 5_000,
  maxHoldMs: 40_000,
};

/** Names the Claude requests (usage, token refresh) in proxy route log lines */
export const CLAUDE_REQUESTS = 'Claude requests';

// Claude Code's public OAuth client, used for the refresh_token grant.
// Anthropic is migrating console.anthropic.com to platform.claude.com;
// try the new domain first and fall back to the canonical one.
const OAUTH_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh slightly before actual expiry so in-flight requests don't 401
const EXPIRY_MARGIN_MS = 60_000;
/** One token request's deadline: it runs while Claude Code waits for the lock */
const REFRESH_TIMEOUT_MS = 15_000;
const ERROR_BODY_MAX = 4_096;

/**
 * Refresh tokens the token endpoints rejected (invalid_grant), by hash. Like
 * Claude Code, they are never posted again; a new login brings a new one.
 */
const deadRefreshTokens = new Set<string>();
/**
 * Refreshed pairs that could not be written back, by the hash of the refresh
 * token the store still holds: the next refresh writes them instead of
 * posting the rotated-away token again.
 */
const pendingPairs = new Map<string, TokenUpdate>();
let refreshInFlight: Promise<string | null> | null = null;

const tokenKey = (refreshToken: string): string =>
  createHash('sha256').update(refreshToken).digest('hex');

const loginExpired = (reason: string): ClaudeLoginExpiredError =>
  new ClaudeLoginExpiredError(
    `Claude Code's login has expired (${reason}). Run claude in a terminal and log in again.`
  );

const isFresh = (
  creds: {
    accessToken: string;
    expiresAt?: number;
  } | null
): boolean =>
  !!creds?.accessToken &&
  (creds.expiresAt === undefined ||
    creds.expiresAt - EXPIRY_MARGIN_MS > Date.now());

const signedOut = (creds: StoredCredentials): boolean =>
  !creds.accessToken && !creds.refreshToken;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException)?.code ?? safeErrorMessage(error);

// --- Claude Code's refresh lock ----------------------------------------------------

/**
 * The Claude Code folder whose lock guards this login: the folder of its
 * `.credentials.json`, else CLAUDE_SECURESTORAGE_CONFIG_DIR / CLAUDE_CONFIG_DIR,
 * else ~/.claude (relative values count from the home folder).
 */
function lockFolder(creds: StoredCredentials): string {
  if (creds.source === 'file' && creds.path) {
    if (basename(creds.path) === '.credentials.json')
      return dirname(creds.path);
  }
  const fromEnv =
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ||
    process.env.CLAUDE_CONFIG_DIR;
  if (!fromEnv) return join(homedir(), '.claude');
  return isAbsolute(fromEnv) ? fromEnv : join(homedir(), fromEnv);
}

/**
 * Takes Claude Code's refresh locks in its own order: `<folder>/.oauth_refresh.lock`,
 * then the legacy `<realpath(folder)>.lock` older versions use. Resolves to a
 * release function, or null while another process holds either one. Without
 * the folder there is no Claude Code to share the login with: nothing to lock.
 */
async function acquireClaudeLock(
  folder: string,
  timings: LockTimings
): Promise<(() => Promise<void>) | null> {
  if (!(await stat(folder).catch(() => null))?.isDirectory()) {
    return async () => undefined;
  }
  const keep = { createParent: false };
  const releaseNew = await acquireCliLock(
    join(folder, '.oauth_refresh'),
    timings,
    sleep,
    keep
  );
  if (!releaseNew) return null;
  try {
    const legacy = await realpath(folder).catch(() => folder);
    const releaseLegacy = await acquireCliLock(legacy, timings, sleep, keep);
    if (!releaseLegacy) {
      await releaseNew();
      return null;
    }
    return async () => {
      await releaseLegacy();
      await releaseNew();
    };
  } catch (error) {
    await releaseNew();
    throw error;
  }
}

// --- the token request ----------------------------------------------------------------

type RefreshResult = {
  response: Response | null;
  /** Every endpoint rejected the refresh token as invalid (invalid_grant) */
  invalidGrant: boolean;
};

/** Whether a rejected token request says invalid_grant (body read bounded). */
async function isInvalidGrant(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401) {
    response.body?.cancel().catch(() => undefined);
    return false;
  }
  try {
    const body = JSON.parse(await readTextPrefix(response, ERROR_BODY_MAX)) as {
      error?: unknown;
    } | null;
    return body?.error === 'invalid_grant';
  } catch {
    // the parse error is dropped: the body may quote the request
    return false;
  }
}

/** A request that may have reached the server: never sent again. */
const maybeSent = (error: unknown): boolean =>
  error instanceof RequestSentError ||
  (error as Error)?.name === 'TimeoutError' ||
  (error as Error)?.name === 'AbortError';

/**
 * POSTs the refresh_token grant to each token endpoint in turn; the first 2xx
 * answer, or null. A non-2xx answer or a failed direct connection moves on to
 * the next endpoint (one domain may not serve this token's account class). A
 * request that may have reached the server (through the proxy's tunnel, or
 * past its deadline) ends the attempt: the server may have rotated the
 * refresh token, so the old one is never sent again.
 */
async function postRefresh(
  body: string,
  { logger, proxy, requestTimeoutMs = REFRESH_TIMEOUT_MS }: RefreshOptions
): Promise<RefreshResult> {
  let invalidGrants = 0;
  for (const url of OAUTH_TOKEN_URLS) {
    try {
      const response = await proxiedFetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
        {
          proxy,
          logger,
          label: CLAUDE_REQUESTS,
          timeoutMs: requestTimeoutMs,
          connectTimeoutMs: Math.min(requestTimeoutMs, 10_000),
        }
      );
      if (response.ok) return { response, invalidGrant: false };
      const invalid = await isInvalidGrant(response);
      if (invalid) invalidGrants++;
      logger?.warn(
        `Token refresh via ${url} rejected with HTTP ${response.status}${invalid ? ' (invalid_grant)' : ''}`
      );
    } catch (error) {
      const sent = maybeSent(error);
      logger?.error(
        `Token refresh request to ${url} failed: ${safeErrorMessage(error)}${sent ? ' (timed out or sent: not sent again, it may have reached the server)' : ''}`
      );
      if (sent) return { response: null, invalidGrant: false };
    }
  }
  return {
    response: null,
    invalidGrant: invalidGrants === OAUTH_TOKEN_URLS.length,
  };
}

/** The token pair (and Claude Code's extra fields) from a token answer. */
function tokenUpdate(
  data: Record<string, unknown>,
  previousRefreshToken: string
): TokenUpdate {
  const expiresIn = Number(data.expires_in);
  const refreshExpiresIn = data.refresh_token_expires_in;
  const scope = typeof data.scope === 'string' ? data.scope.trim() : '';
  return {
    accessToken: data.access_token as string,
    refreshToken:
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : previousRefreshToken,
    // an unknown lifetime counts as expired, so the next poll refreshes again
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 0),
    // like Claude Code: set only what the answer states, keep the rest
    ...(typeof refreshExpiresIn === 'number' &&
    Number.isFinite(refreshExpiresIn)
      ? { refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000 }
      : {}),
    ...(scope ? { scopes: scope.split(/\s+/) } : {}),
  };
}

/** The answer's token pair, or null when it is unusable (never half a pair). */
async function readTokenAnswer(
  response: Response,
  previousRefreshToken: string,
  logger?: RefreshLogger
): Promise<TokenUpdate | null> {
  let data: Record<string, unknown> | null;
  try {
    data = (await response.json()) as Record<string, unknown> | null;
  } catch {
    // the parse error would quote the response body, i.e. the new tokens
    logger?.error('Token refresh response was not valid JSON');
    return null;
  }
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    logger?.error('Token refresh response did not include an access token');
    return null;
  }
  return tokenUpdate(data, previousRefreshToken);
}

// --- writing the new pair back --------------------------------------------------------

/**
 * Writes the pair into the login read as `latest`. When that fails, the pair
 * is kept for the next refresh, which writes it instead of posting again.
 */
async function storePair(
  latest: StoredCredentials,
  update: TokenUpdate,
  logger?: RefreshLogger
): Promise<void> {
  const key = tokenKey(latest.refreshToken ?? '');
  try {
    const result = await persistRefreshed(
      latest,
      update,
      latest.refreshToken ?? '',
      logger
    );
    pendingPairs.delete(key);
    logger?.info(
      result === 'written'
        ? 'Refreshed Claude Code OAuth token'
        : "Claude Code's login changed while refreshing; the new token is used once and not written back"
    );
  } catch (error) {
    // A failed Keychain write's error repeats its command line, which carries
    // the token pair, so only a sanitized description is logged.
    pendingPairs.set(key, update);
    logger?.error(
      `Could not persist refreshed token: ${safeErrorMessage(error)}`
    );
  }
}

// --- the refresh ----------------------------------------------------------------------

/**
 * What the stored login already gives, re-read under the lock: a token (Claude
 * Code may have refreshed meanwhile), null, or undefined when a refresh is due.
 */
function settledToken(
  latest: StoredCredentials | null,
  staleToken: string,
  force: boolean
): string | null | undefined {
  if (!latest) return null;
  if (signedOut(latest)) throw loginExpired('Claude Code signed out');
  if (!latest.refreshToken) return latest.accessToken || null;
  if (latest.accessToken !== staleToken && isFresh(latest))
    return latest.accessToken;
  if (!force && isFresh(latest)) return latest.accessToken;
  if (deadRefreshTokens.has(tokenKey(latest.refreshToken))) {
    throw loginExpired('its refresh token was rejected');
  }
  return undefined;
}

/** After invalid_grant: a pair someone stored meanwhile, else a dead login. */
async function afterRejection(
  customPath: string | undefined,
  postedRefreshToken: string,
  logger?: RefreshLogger
): Promise<string> {
  const now = await getCredentials(customPath);
  if (
    now?.refreshToken &&
    now.refreshToken !== postedRefreshToken &&
    isFresh(now)
  ) {
    return now.accessToken;
  }
  deadRefreshTokens.add(tokenKey(postedRefreshToken));
  logger?.error(
    'Claude Code refresh token rejected (invalid_grant): its login has expired. Run claude in a terminal and log in again.'
  );
  throw loginExpired('its refresh token was rejected');
}

/** The refresh proper; runs while holding Claude Code's refresh lock. */
async function refreshLocked(
  customPath: string | undefined,
  options: RefreshOptions,
  staleToken: string
): Promise<string | null> {
  const { force = false, logger } = options;
  const latest = await getCredentials(customPath);
  const settled = settledToken(latest, staleToken, force);
  if (settled !== undefined || !latest?.refreshToken) return settled ?? null;

  const pending = pendingPairs.get(tokenKey(latest.refreshToken));
  if (pending) {
    await storePair(latest, pending, logger);
    if (isFresh(pending) && !force) return pending.accessToken;
  }
  if (!(await canPersist(latest))) {
    logger?.warn(
      'Claude Code credentials are not writable: not refreshing (the new pair could not be stored)'
    );
    return null;
  }

  const posted = pending?.refreshToken ?? latest.refreshToken;
  const { response, invalidGrant } = await postRefresh(
    JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: posted,
      client_id: OAUTH_CLIENT_ID,
    }),
    options
  );
  if (invalidGrant) return afterRejection(customPath, posted, logger);
  if (!response) return null;
  const update = await readTokenAnswer(response, posted, logger);
  if (!update) return null;
  await storePair(latest, update, logger);
  return update.accessToken;
}

/**
 * Refreshes under Claude Code's own refresh lock, so the two never rotate the
 * refresh token at the same time (the loser's token would be dead, and Claude
 * Code signs out on a dead one). While Claude Code holds the lock, its new
 * token is used once it lands; without the lock nothing is refreshed.
 */
async function doRefresh(
  customPath: string | undefined,
  options: RefreshOptions,
  creds: StoredCredentials,
  staleToken: string
): Promise<string | null> {
  const { logger } = options;
  let release: (() => Promise<void>) | null;
  try {
    release = await acquireClaudeLock(
      lockFolder(creds),
      options.lock ?? CLAUDE_LOCK
    );
  } catch (error) {
    // the error code only: a message would name local paths
    logger?.warn(
      `Could not take Claude Code's refresh lock (${errorCode(error)}): not refreshing`
    );
    return null;
  }
  if (!release) {
    logger?.info(
      'Claude Code is refreshing its login; its new token is used once stored'
    );
    const now = await getCredentials(customPath);
    if (now && signedOut(now)) throw loginExpired('Claude Code signed out');
    return now && now.accessToken !== staleToken && isFresh(now)
      ? now.accessToken
      : null;
  }
  try {
    return await refreshLocked(customPath, options, staleToken);
  } finally {
    await release();
  }
}

/**
 * Returns a usable access token, transparently refreshing an expired one
 * via the stored refresh token (and persisting the new pair, as Claude Code
 * itself would). Set `force` (with `rejectedToken`) to refresh regardless of
 * the stored expiry after a 401, and `proxy` for the claudeProxy setting.
 * Returns null when no credentials exist at all; throws
 * ClaudeLoginExpiredError when Claude Code signed out or its refresh token
 * was rejected.
 */
export async function getAccessToken(
  customPath?: string,
  options: RefreshOptions = {}
): Promise<string | null> {
  const creds = await getCredentials(customPath);
  if (!creds) return null;
  if (signedOut(creds)) throw loginExpired('Claude Code signed out');

  const staleToken = options.rejectedToken ?? creds.accessToken;
  // after a 401: a token stored since the rejected one is used as it is
  if (options.force && creds.accessToken !== staleToken && isFresh(creds)) {
    return creds.accessToken;
  }
  const expired = !isFresh(creds);
  if ((!expired && !options.force) || !creds.refreshToken) {
    return creds.accessToken;
  }
  if (deadRefreshTokens.has(tokenKey(creds.refreshToken))) {
    throw loginExpired('its refresh token was rejected');
  }

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(customPath, options, creds, staleToken).finally(
      () => {
        refreshInFlight = null;
      }
    );
  }
  const refreshed = await refreshInFlight;
  return refreshed ?? creds.accessToken;
}
