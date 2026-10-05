import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { safeErrorMessage } from './redact';

const execFileAsync = promisify(execFile);

type RefreshLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

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

export type StoredCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Where the credentials came from; file credentials can be written back */
  source: 'env' | 'file' | 'keychain';
  path?: string;
};

/**
 * JSON.parse for credential data. A bare JSON.parse error quotes the input it
 * failed on, which here would put token material into logs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCredentialJson(text: string, source: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
}

function candidatePaths(customPath?: string): string[] {
  const paths: string[] = [];
  if (customPath) paths.push(customPath);
  if (process.env.CLAUDE_CREDENTIALS_PATH) {
    paths.push(process.env.CLAUDE_CREDENTIALS_PATH);
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    paths.push(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
  }
  paths.push(join(homedir(), '.claude', '.credentials.json'));
  return paths;
}

function extractOauthSection(parsed: Record<string, unknown>): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
} | null {
  if (typeof parsed.accessToken === 'string') {
    return parsed as { accessToken: string };
  }
  for (const value of Object.values(parsed)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).accessToken === 'string'
    ) {
      return value as {
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
      };
    }
  }
  return null;
}

async function readFromKeychain(): Promise<StoredCredentials | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    const raw = stdout.trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const section = extractOauthSection(
        parseCredentialJson(raw, 'Keychain item')
      );
      if (section) return { ...section, source: 'keychain' };
      return null;
    }
    return { accessToken: raw, source: 'keychain' };
  } catch {
    return null;
  }
}

/**
 * Reads the stored Claude Code credentials. Called on every poll — Claude
 * Code (or this plugin's own refresh) may rewrite the store at any time.
 */
export async function getCredentials(
  customPath?: string
): Promise<StoredCredentials | null> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  }

  for (const path of candidatePaths(customPath)) {
    try {
      const section = extractOauthSection(
        parseCredentialJson(await readFile(path, 'utf-8'), 'Credentials file')
      );
      if (section) return { ...section, source: 'file', path };
    } catch {
      // file missing or unreadable, try next candidate
    }
  }

  if (process.platform === 'darwin') {
    return readFromKeychain();
  }

  return null;
}

/**
 * Persists a refreshed token pair back into the credential store, updating
 * only the OAuth section and preserving everything else (e.g. mcpOAuth).
 * The write is atomic (temp file + rename) so a concurrently reading Claude
 * Code never sees a partial file.
 */
async function persistRefreshed(
  creds: StoredCredentials,
  update: { accessToken: string; refreshToken: string; expiresAt: number }
): Promise<void> {
  if (creds.source === 'file' && creds.path) {
    const parsed = parseCredentialJson(
      await readFile(creds.path, 'utf-8'),
      'Credentials file'
    );
    const sectionKey = Object.keys(parsed).find(
      key =>
        parsed[key] &&
        typeof parsed[key] === 'object' &&
        typeof parsed[key].accessToken === 'string'
    );
    if (sectionKey) {
      parsed[sectionKey] = { ...parsed[sectionKey], ...update };
    } else if (typeof parsed.accessToken === 'string') {
      Object.assign(parsed, update);
    } else {
      throw new Error('Could not locate OAuth section in credentials file');
    }
    const tmpPath = `${creds.path}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(parsed), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await rename(tmpPath, creds.path);
    return;
  }

  if (creds.source === 'keychain') {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    const parsed = parseCredentialJson(stdout.trim(), 'Keychain item');
    const sectionKey = Object.keys(parsed).find(
      key =>
        parsed[key] &&
        typeof parsed[key] === 'object' &&
        typeof parsed[key].accessToken === 'string'
    );
    if (!sectionKey)
      throw new Error('Could not locate OAuth section in Keychain item');
    parsed[sectionKey] = { ...parsed[sectionKey], ...update };
    await execFileAsync('security', [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      process.env.USER ?? '',
      '-w',
      JSON.stringify(parsed),
    ]);
  }
}

let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(
  customPath: string | undefined,
  force: boolean,
  logger?: RefreshLogger
): Promise<string | null> {
  // Re-read first: Claude Code may have refreshed concurrently, in which
  // case its token is fresh and our (rotated-away) refresh attempt would fail
  const latest = await getCredentials(customPath);
  if (!latest?.refreshToken) return latest?.accessToken ?? null;
  if (
    !force &&
    latest.expiresAt &&
    latest.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  ) {
    return latest.accessToken;
  }

  let response: Response | null = null;
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: latest.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  for (const url of OAUTH_TOKEN_URLS) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (response.ok) break;
      // A rejection may be endpoint-specific (e.g. one domain not serving
      // this token's account class) — try the next endpoint. If the token
      // was truly consumed/revoked (invalid_grant), the retry fails the
      // same way, which is harmless.
      logger?.warn(
        `Token refresh via ${url} rejected with HTTP ${response.status}`
      );
    } catch (error) {
      logger?.error(
        `Token refresh request to ${url} failed: ${safeErrorMessage(error)}`
      );
    }
  }
  if (!response?.ok) return null;

  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null;
  try {
    data = (await response.json()) as typeof data;
  } catch {
    // the parse error would quote the response body, i.e. the new tokens
    logger?.error('Token refresh response was not valid JSON');
    return null;
  }
  // never write an incomplete pair back into Claude Code's credential store
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    logger?.error('Token refresh response did not include an access token');
    return null;
  }
  const expiresIn = Number(data.expires_in);
  const update = {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : latest.refreshToken,
    // an unknown lifetime counts as expired, so the next poll refreshes again
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 0),
  };

  try {
    await persistRefreshed(latest, update);
    logger?.info('Refreshed Claude Code OAuth token');
  } catch (error) {
    // The new pair is still good for this session even if persisting failed.
    // A failed Keychain write's error repeats its command line, which carries
    // the token pair, so only a sanitized description is logged.
    logger?.error(
      `Could not persist refreshed token: ${safeErrorMessage(error)}`
    );
  }
  return update.accessToken;
}

/**
 * Returns a usable access token, transparently refreshing an expired one
 * via the stored refresh token (and persisting the new pair, as Claude Code
 * itself would). Set `force` to refresh regardless of the stored expiry,
 * e.g. after a 401. Returns null when no credentials exist at all.
 */
export async function getAccessToken(
  customPath?: string,
  options?: { force?: boolean; logger?: RefreshLogger }
): Promise<string | null> {
  const creds = await getCredentials(customPath);
  if (!creds) return null;

  const expired =
    creds.expiresAt !== undefined &&
    creds.expiresAt - EXPIRY_MARGIN_MS <= Date.now();
  if ((!expired && !options?.force) || !creds.refreshToken) {
    return creds.accessToken;
  }

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(
      customPath,
      options?.force ?? false,
      options?.logger
    ).finally(() => {
      refreshInFlight = null;
    });
  }
  const refreshed = await refreshInFlight;
  return refreshed ?? creds.accessToken;
}
