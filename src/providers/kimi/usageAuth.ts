/**
 * The Kimi Code login the usage meter borrows: reads the CLI's OAuth token
 * file ($KIMI_CODE_HOME/credentials/<slot>.json) and, when it has expired
 * and the `kimiRefreshLogin` setting allows it, refreshes it exactly the
 * way the CLI does, because refresh tokens rotate and a lost race logs the
 * user out:
 *
 * 1. take the CLI's cross-process lock: the directory
 *    <home>/oauth/<slot>.lock (proper-lockfile: mkdir, stale after 5 s,
 *    mtime kept fresh while held); never refresh without it;
 * 2. re-read the token file and use a token a peer refreshed meanwhile;
 * 3. POST the refresh_token grant to <oauthHost>/api/oauth/token;
 * 4. write the new pair atomically (temp file, fsync, rename, mode 0600),
 *    keeping any other fields of the file.
 *
 * A rejected refresh is remembered in memory (never written as the CLI's
 * "tombstone"), so the dead refresh token is not sent again.
 *
 * Never logs or throws a token: errors carry fixed texts or
 * safeErrorMessage() of transport errors; token files and responses are
 * parsed with a JSON.parse whose error never quotes the input.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';

import { safeErrorMessage } from '../../redact';
import { ProviderError } from '../kit';
import { KeyText, Lang } from '../types';

import { KimiEndpoint, isSafeUrl } from './usageConfig';

/**
 * Kimi Code's public OAuth client id (MoonshotAI/kimi-code,
 * packages/oauth/src/constants.ts): it ships in every Kimi Code install, the
 * client has no secret, and the id alone grants nothing (allowlisted in
 * .privacy-allowlist, like Claude's client id).
 */
export const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

/** Refresh this long before the stored expiry */
const EXPIRY_MARGIN_MS = 60_000;
/** Largest token file read */
const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const REFRESH_TIMEOUT_MS = 15_000;

export type LockTimings = {
  /** Attempts while another process holds the lock */
  retries: number;
  /** Wait between attempts */
  delayMs: number;
  /** A lock untouched this long is abandoned (proper-lockfile `stale`) */
  staleMs: number;
  /** How often a held lock's mtime is refreshed */
  updateMs: number;
};

export const CLI_LOCK: LockTimings = {
  retries: 20,
  delayMs: 500,
  staleMs: 5_000,
  updateMs: 2_500,
};

export type AuthDeps = {
  fetch: typeof fetch;
  /** Wall clock in ms (token expiry) */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  lock: LockTimings;
};

type Texts = Record<Lang, KeyText>;

/** Key-face texts for the login problems (kit defaults name no command). */
export const LOGIN_TEXT = {
  notLoggedIn: {
    en: { title: 'Not logged in', message: 'Run kimi login' },
    zh: { title: '未登录', message: '请运行 kimi login' },
  },
  expired: {
    en: { title: 'Login expired', message: 'Run kimi login' },
    zh: { title: '登录已过期', message: '请运行 kimi login' },
  },
  refreshOff: {
    en: { title: 'Login expired', message: 'Run kimi to refresh' },
    zh: { title: '登录已过期', message: '运行 kimi 以刷新' },
  },
  busy: {
    en: { title: 'Login busy', message: 'Retrying soon' },
    zh: { title: '登录刷新中', message: '稍后自动重试' },
  },
} satisfies Record<string, Texts>;

export type StoredToken = {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds; 0 = unknown (never refreshed proactively, like the CLI) */
  expiresAt: number;
  /** The whole file, so a write-back keeps fields this code does not know */
  raw: Record<string, unknown>;
};

export type LoginState =
  | { kind: 'missing' }
  | { kind: 'revoked' }
  | { kind: 'valid'; token: StoredToken };

/** JSON.parse whose error never quotes the (secret) input. */
export function parseSecretJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('parse', `${what} is not valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function credentialFile(home: string, endpoint: KimiEndpoint): string {
  return path.join(home, 'credentials', `${endpoint.credentialName}.json`);
}

/**
 * The token file's state, like the CLI's classifyToken: no or unreadable
 * file → missing, empty access_token → revoked (a "tombstone").
 */
export async function readLogin(file: string): Promise<LoginState> {
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_TOKEN_FILE_BYTES) {
      return { kind: 'missing' };
    }
    text = await readFile(file, 'utf-8');
  } catch {
    return { kind: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = parseSecretJson(text, 'Kimi Code credentials file');
  } catch {
    return { kind: 'missing' };
  }
  if (!isRecord(parsed)) return { kind: 'missing' };
  const accessToken =
    typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (!accessToken) return { kind: 'revoked' };
  return {
    kind: 'valid',
    token: {
      accessToken,
      refreshToken:
        typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
      expiresAt:
        typeof parsed.expires_at === 'number' &&
        Number.isFinite(parsed.expires_at)
          ? parsed.expires_at
          : 0,
      raw: parsed,
    },
  };
}

function expiresSoon(token: StoredToken, now: number): boolean {
  return token.expiresAt > 0 && token.expiresAt * 1000 - now < EXPIRY_MARGIN_MS;
}

function sameToken(a: StoredToken, b: StoredToken): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt
  );
}

const fingerprint = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');

/** Refresh tokens the server rejected (fingerprints only). */
const deadRefreshTokens = new Set<string>();

/** Forgets rejected refresh tokens (tests). */
export function resetAuthState(): void {
  deadRefreshTokens.clear();
  refreshes.clear();
}

export const notLoggedIn = () =>
  new ProviderError(
    'no-credentials',
    'Kimi Code is not logged in. Run `kimi login` in a terminal.',
    { keyText: LOGIN_TEXT.notLoggedIn }
  );

export const loginExpired = () =>
  new ProviderError(
    'unauthorized',
    'The Kimi Code login was rejected. Run `kimi login` in a terminal.',
    { keyText: LOGIN_TEXT.expired }
  );

export const refreshOff = () =>
  new ProviderError(
    'unauthorized',
    'The Kimi Code login has expired and refreshing it is turned off. Run kimi once to refresh it.',
    { keyText: LOGIN_TEXT.refreshOff }
  );

// --- the CLI's refresh lock ------------------------------------------------------

/**
 * Takes the proper-lockfile lock `<target>.lock` the CLI uses (a directory
 * created with mkdir; abandoned after `staleMs` without an mtime update).
 * Resolves to a release function, or null when another process kept it.
 */
export async function acquireCliLock(
  target: string,
  timings: LockTimings,
  sleep: (ms: number) => Promise<void>
): Promise<(() => Promise<void>) | null> {
  const lockDir = `${target}.lock`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt <= timings.retries; attempt++) {
    try {
      await mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const info = await stat(lockDir);
        stale = info.mtimeMs < Date.now() - timings.staleMs;
      } catch {
        stale = true; // released meanwhile: try again right away
      }
      if (stale) {
        await rmdir(lockDir).catch(() => undefined);
      } else if (attempt < timings.retries) {
        await sleep(timings.delayMs);
      }
      continue;
    }
    const touch = setInterval(() => {
      const time = new Date();
      utimes(lockDir, time, time).catch(() => undefined);
    }, timings.updateMs);
    touch.unref?.();
    return async () => {
      clearInterval(touch);
      await rmdir(lockDir).catch(() => undefined);
    };
  }
  return null;
}

/** Writes the token file the way the CLI's FileTokenStorage does. */
async function writeTokenFile(
  file: string,
  value: Record<string, unknown>
): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// --- refresh -------------------------------------------------------------------

type Grant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope?: string;
  tokenType?: string;
};

/** The refresh_token grant; throws ProviderError, 'unauthorized' when rejected. */
async function requestRefresh(
  endpoint: KimiEndpoint,
  refreshToken: string,
  deps: AuthDeps
): Promise<Grant> {
  const url = `${endpoint.oauthHost}/api/oauth/token`;
  if (!isSafeUrl(url)) {
    throw new ProviderError(
      'not-configured',
      'The Kimi Code OAuth host is not an https URL.'
    );
  }
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: KIMI_CODE_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(
      'network',
      `Kimi Code token refresh failed: ${safeErrorMessage(error)}`
    );
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseSecretJson(await response.text(), 'Token response');
    if (isRecord(parsed)) data = parsed;
  } catch {
    // an unreadable body is judged by the status alone
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    data.error === 'invalid_grant'
  ) {
    throw loginExpired();
  }
  if (response.status === 429) {
    throw new ProviderError(
      'rate-limited',
      'Kimi Code token refresh was rate limited.',
      { retryAfterSeconds: retryAfterSeconds(response, deps.now()) }
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      'http',
      `Kimi Code token refresh failed with HTTP ${response.status}`
    );
  }
  const expiresIn = Number(data.expires_in);
  if (
    typeof data.access_token !== 'string' ||
    !data.access_token ||
    typeof data.refresh_token !== 'string' ||
    !data.refresh_token ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new ProviderError(
      'parse',
      'Kimi Code token refresh returned an incomplete token.'
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    tokenType:
      typeof data.token_type === 'string' ? data.token_type : undefined,
  };
}

/** Seconds from a Retry-After header (seconds or HTTP date), if any. */
export function retryAfterSeconds(
  response: Response,
  now: number
): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isFinite(date) && date > now) {
    return Math.ceil((date - now) / 1000);
  }
  return undefined;
}

/** One refresh per token file at a time inside this process. */
const refreshes = new Map<string, Promise<string>>();

async function refreshLocked(
  file: string,
  lockTarget: string | null,
  endpoint: KimiEndpoint,
  before: StoredToken,
  force: boolean,
  deps: AuthDeps
): Promise<string> {
  let release: (() => Promise<void>) | null = async () => undefined;
  if (lockTarget) {
    try {
      release = await acquireCliLock(lockTarget, deps.lock, deps.sleep);
    } catch (error) {
      // like the CLI: no refresh without the lock
      throw new ProviderError(
        'not-configured',
        `Could not take the Kimi Code login lock: ${safeErrorMessage(error)}`
      );
    }
  }
  if (!release) {
    // another process kept the lock: use its result if it is there yet
    const now = await readLogin(file);
    if (
      now.kind === 'valid' &&
      !expiresSoon(now.token, deps.now()) &&
      (!force || !sameToken(now.token, before))
    ) {
      return now.token.accessToken;
    }
    throw new ProviderError(
      'network',
      'Another Kimi Code process is refreshing the login; retrying later.',
      { keyText: LOGIN_TEXT.busy }
    );
  }
  try {
    // re-read under the lock: a peer may have refreshed meanwhile
    const state = await readLogin(file);
    if (state.kind === 'revoked') throw loginExpired();
    let current = before;
    if (state.kind === 'valid') {
      current = state.token;
      if (
        force ? !sameToken(current, before) : !expiresSoon(current, deps.now())
      ) {
        return current.accessToken;
      }
    }
    if (!current.refreshToken) throw loginExpired();
    if (deadRefreshTokens.has(fingerprint(current.refreshToken))) {
      throw loginExpired();
    }

    let grant: Grant;
    try {
      grant = await requestRefresh(endpoint, current.refreshToken, deps);
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'unauthorized') {
        // the CLI's recovery: a peer may have rotated the pair mid-flight
        await deps.sleep(100);
        const recovery = await readLogin(file);
        if (
          recovery.kind === 'valid' &&
          recovery.token.refreshToken !== current.refreshToken
        ) {
          return recovery.token.accessToken;
        }
        deadRefreshTokens.add(fingerprint(current.refreshToken));
      }
      throw error;
    }

    const updated: Record<string, unknown> = {
      ...current.raw,
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      expires_at: Math.floor(deps.now() / 1000) + grant.expiresIn,
      scope: grant.scope ?? current.raw.scope ?? '',
      token_type: grant.tokenType ?? current.raw.token_type ?? 'Bearer',
      expires_in: grant.expiresIn,
    };
    try {
      await writeTokenFile(file, updated);
    } catch (error) {
      // the old refresh token is spent: the CLI will ask for a new login
      throw new ProviderError(
        'not-configured',
        `Could not save the refreshed Kimi Code login: ${safeErrorMessage(error)}`
      );
    }
    return grant.accessToken;
  } finally {
    await release();
  }
}

export type TokenRequest = {
  home: string;
  endpoint: KimiEndpoint;
  /** The `kimiRefreshLogin` setting (missing = on) */
  allowRefresh: boolean;
  /** Refresh even though the stored token looks valid (after a 401) */
  force?: boolean;
};

/**
 * A usable access token, refreshed through the CLI's protocol when needed
 * and allowed. Throws ProviderError: 'no-credentials' (no login),
 * 'unauthorized' (rejected, expired with refresh off), 'network',
 * 'rate-limited', 'http', 'parse', 'not-configured'.
 */
export async function getAccessToken(
  request: TokenRequest,
  deps: AuthDeps
): Promise<string> {
  const file = credentialFile(request.home, request.endpoint);
  const state = await readLogin(file);
  if (state.kind === 'missing') throw notLoggedIn();
  if (state.kind === 'revoked') throw loginExpired();
  const token = state.token;
  const force = request.force === true;
  if (!force && !expiresSoon(token, deps.now())) return token.accessToken;
  if (!request.allowRefresh) throw refreshOff();
  if (
    !token.refreshToken ||
    deadRefreshTokens.has(fingerprint(token.refreshToken))
  ) {
    throw loginExpired();
  }

  const lockTarget =
    deps.platform === 'win32' || deps.env.KIMI_DISABLE_OAUTH_LOCK === '1'
      ? null
      : path.join(request.home, 'oauth', request.endpoint.credentialName);
  const running = refreshes.get(file);
  if (running) return running;
  const promise = refreshLocked(
    file,
    lockTarget,
    request.endpoint,
    token,
    force,
    deps
  ).finally(() => refreshes.delete(file));
  refreshes.set(file, promise);
  return promise;
}
