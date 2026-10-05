/**
 * Gemini usage key: the login Gemini CLI stores on this computer, read-only.
 *
 * - The login type comes from <geminiHome>/settings.json
 *   (security.auth.selectedType, older CLIs: selectedAuthType).
 * - "Login with Google" keeps an OAuth token pair in oauth_creds.json. An
 *   expired access token is refreshed with the CLI's own OAuth client
 *   (./usageCli.ts) and kept in memory only: Google refresh tokens do not
 *   rotate, and the CLI owns (and rewrites) that file.
 *
 * Credential data is never parsed with a bare JSON.parse (its error quotes
 * the input), never logged and never put into an error message.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ProviderError } from '../kit';

import { OAuthClient } from './usageCli';
import { GeminiUsageError } from './usageText';

export const CREDS_FILE = 'oauth_creds.json';
export const SETTINGS_FILE = 'settings.json';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// refresh a little early so a request never starts with a dying token
const EXPIRY_MARGIN_MS = 60_000;
// a refresh or API call that hangs must not block the key forever
export const REQUEST_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The stored token pair (field names as Gemini CLI writes them). */
export type OAuthCreds = {
  accessToken: string | null;
  refreshToken: string | null;
  /** Epoch ms, or null when unknown */
  expiryDate: number | null;
};

/** JSON with // and /* comments removed (settings.json allows them). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

/** JSON.parse without the input in its error; null when not valid JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseQuietly(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The login type the CLI is set to (e.g. "oauth-personal",
 * "gemini-api-key", "vertex-ai"), or null when settings.json is missing,
 * unreadable or does not say.
 */
export async function readAuthType(home: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(home, SETTINGS_FILE), 'utf8');
  } catch {
    return null;
  }
  const settings = parseQuietly(stripJsonComments(text));
  const value =
    settings?.security?.auth?.selectedType ?? settings?.selectedAuthType;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** True when the Gemini CLI home folder exists. */
export async function homeExists(home: string): Promise<boolean> {
  try {
    return (await fs.stat(home)).isDirectory();
  } catch {
    return false;
  }
}

function credsFrom(parsed: unknown): OAuthCreds | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value ? value : null;
  const accessToken = text(record.access_token);
  const refreshToken = text(record.refresh_token);
  if (!accessToken && !refreshToken) return null;
  const expiry = Number(record.expiry_date);
  return {
    accessToken,
    refreshToken,
    expiryDate: Number.isFinite(expiry) && expiry > 0 ? expiry : null,
  };
}

/**
 * The stored login, or null when there is none. The CLI rewrites the file
 * in place, so a half-written file is read once more before giving up.
 */
export async function readOAuthCreds(
  home: string,
  retryDelayMs = 150
): Promise<OAuthCreds | null> {
  const file = path.join(home, CREDS_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw new GeminiUsageError(
        'creds-unreadable',
        `Could not read the Gemini CLI login (${CREDS_FILE}): ${
          (error as NodeJS.ErrnoException)?.code ?? 'read error'
        }`
      );
    }
    if (text.trim()) {
      const parsed = parseQuietly(text);
      if (parsed !== null) return credsFrom(parsed);
    }
    if (attempt === 0) await sleep(retryDelayMs);
  }
  throw new GeminiUsageError(
    'creds-unreadable',
    `The Gemini CLI login (${CREDS_FILE}) is not valid JSON`
  );
}

/** Short one-way id of a login, to key in-memory caches (never logged). */
export function loginFingerprint(creds: OAuthCreds): string {
  return createHash('sha256')
    .update(creds.refreshToken ?? creds.accessToken ?? '')
    .digest('hex')
    .slice(0, 16);
}

/** A Retry-After header in seconds, or undefined. */
export function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const wait = Math.ceil((at - Date.now()) / 1000);
  return wait > 0 ? wait : undefined;
}

/** An AbortSignal that fires after the request timeout, where supported. */
export function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

export type TokenDeps = {
  fetch: () => typeof fetch;
  now: () => number;
};

/** What a token is for when the CLI's client is needed to refresh it. */
export type ClientLookup = () => Promise<{
  client: OAuthClient | null;
  /** False when no Gemini CLI was found at all */
  cliFound: boolean;
}>;

/**
 * Access tokens for the stored login: the file's own token while it is
 * valid, else one refreshed in memory (one refresh at a time, reused until
 * it expires or the stored login changes).
 */
export class GeminiTokens {
  private cached: { login: string; token: string; expiresAt: number } | null =
    null;
  private inFlight: { login: string; promise: Promise<string> } | null = null;

  constructor(private readonly deps: TokenDeps) {}

  /** Forgets the refreshed token (tests, or after a 401). */
  reset() {
    this.cached = null;
  }

  /**
   * A token to call Google with. `force` refreshes even when the stored
   * expiry looks fine (after a 401 with that token).
   */
  async token(
    creds: OAuthCreds,
    lookup: ClientLookup,
    options: { force?: boolean } = {}
  ): Promise<string> {
    const now = this.deps.now();
    const login = loginFingerprint(creds);
    const fileValid =
      !!creds.accessToken &&
      (creds.expiryDate === null || creds.expiryDate - EXPIRY_MARGIN_MS > now);

    if (!options.force) {
      if (fileValid && creds.accessToken) return creds.accessToken;
      const cached = this.cached;
      if (
        cached &&
        cached.login === login &&
        cached.expiresAt - EXPIRY_MARGIN_MS > now
      ) {
        return cached.token;
      }
    }
    if (!creds.refreshToken) {
      throw new GeminiUsageError(
        'login-expired',
        'The Gemini CLI login has no refresh token: run gemini to log in again'
      );
    }
    if (this.inFlight?.login !== login) {
      const promise = this.refresh(creds.refreshToken, login, lookup).finally(
        () => {
          if (this.inFlight?.promise === promise) this.inFlight = null;
        }
      );
      this.inFlight = { login, promise };
    }
    return this.inFlight.promise;
  }

  private async refresh(
    refreshToken: string,
    login: string,
    lookup: ClientLookup
  ): Promise<string> {
    const { client, cliFound } = await lookup();
    if (!client) {
      throw cliFound
        ? new GeminiUsageError(
            'login-expired',
            "The Gemini CLI login expired and the CLI's OAuth client could not be read to refresh it: run gemini to refresh the login"
          )
        : new GeminiUsageError(
            'cli-missing',
            'The Gemini CLI login expired and no Gemini CLI was found to refresh it: install it or set "Gemini CLI program" in the plugin settings'
          );
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.id,
      client_secret: client.secret,
    });
    let response: Response;
    try {
      response = await this.deps.fetch()(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: timeoutSignal(),
      });
    } catch (error) {
      throw new ProviderError(
        'network',
        `Gemini login refresh failed: network error (${
          (error as Error)?.name ?? 'Error'
        })`
      );
    }

    // only the OAuth error code is read from a failed answer (never the body)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const code =
        typeof data?.error === 'string'
          ? data.error.replace(/[^a-z_]/gi, '').slice(0, 40)
          : '';
      if (response.status === 429) {
        throw new ProviderError(
          'rate-limited',
          'Gemini login refresh was rate limited',
          { retryAfterSeconds: retryAfterSeconds(response) }
        );
      }
      if (response.status === 400 || response.status === 401) {
        throw new GeminiUsageError(
          'login-expired',
          `Gemini login refresh was refused (HTTP ${response.status}${
            code ? ` ${code}` : ''
          }): run gemini to log in again`
        );
      }
      throw new ProviderError(
        'http',
        `Gemini login refresh failed with HTTP ${response.status}`
      );
    }
    const token =
      typeof data?.access_token === 'string' ? data.access_token : '';
    if (!token) {
      throw new ProviderError(
        'parse',
        'Gemini login refresh answer had no access token'
      );
    }
    const expiresIn = Number(data.expires_in);
    // an unknown lifetime counts as expired, so the next poll refreshes again
    const expiresAt =
      this.deps.now() +
      (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 0);
    this.cached = { login, token, expiresAt };
    return token;
  }
}
