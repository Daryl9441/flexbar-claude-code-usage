/**
 * Claude Code's credential store: reading the stored OAuth login (env,
 * credentials file, macOS Keychain) and writing a refreshed token pair back
 * into the login it came from. The refresh itself is src/credentials.ts.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { SECURITY_PATH, writeGenericPassword } from './keychain';

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** `security` reads give up after this long (e.g. a Keychain prompt nobody answers) */
const SECURITY_TIMEOUT_MS = 10_000;

export type StoreLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type StoredCredentials = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** When the refresh token itself lapses (Claude Code's own record) */
  refreshTokenExpiresAt?: number;
  /** Where the credentials came from; file credentials can be written back */
  source: 'env' | 'file' | 'keychain';
  path?: string;
};

export type TokenUpdate = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Only when the answer had refresh_token_expires_in; else the stored one stays */
  refreshTokenExpiresAt?: number;
  /** Only when the answer had a scope; else the stored scopes stay */
  scopes?: string[];
};

/** How a write-back ended: stored, or skipped because the login changed. */
export type PersistResult = 'written' | 'changed';

type OauthSection = Omit<StoredCredentials, 'source' | 'path'>;

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

function isOauthSection(value: unknown): value is OauthSection {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).accessToken === 'string'
  );
}

/** The OAuth section's key, '' for top-level token fields, or null. */
function sectionKeyOf(parsed: Record<string, unknown>): string | null {
  if (isOauthSection(parsed)) return '';
  return Object.keys(parsed).find(key => isOauthSection(parsed[key])) ?? null;
}

function extractOauthSection(
  parsed: Record<string, unknown>
): OauthSection | null {
  const key = sectionKeyOf(parsed);
  if (key === null) return null;
  return (key === '' ? parsed : parsed[key]) as OauthSection;
}

/** `security find-generic-password` for Claude Code's item. */
function findKeychainItem(args: string[]) {
  return execFileAsync(
    SECURITY_PATH,
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, ...args],
    { timeout: SECURITY_TIMEOUT_MS }
  );
}

async function readFromKeychain(): Promise<StoredCredentials | null> {
  try {
    const { stdout } = await findKeychainItem(['-w']);
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
 * The credential JSON with its OAuth section (or top-level token fields)
 * updated, everything else (e.g. mcpOAuth) kept. 'changed' when the stored
 * refresh token is no longer `expected`: Claude Code signed out or logged in
 * again meanwhile, and that state must not be overwritten.
 */
function withRefreshedTokens(
  parsed: Record<string, unknown>,
  update: TokenUpdate,
  expected: string
): Record<string, unknown> | 'changed' {
  const key = sectionKeyOf(parsed);
  if (key === null) throw new Error('Could not locate the OAuth section');
  const section = (key === '' ? parsed : parsed[key]) as OauthSection;
  if (section.refreshToken !== expected) return 'changed';
  return key === ''
    ? { ...parsed, ...update }
    : { ...parsed, [key]: { ...section, ...update } };
}

/**
 * Whether a refreshed pair could be stored. A rotated refresh token that
 * cannot be written back leaves Claude Code with a used-up one, so a store the
 * plugin cannot write is not refreshed at all.
 */
export async function canPersist(creds: StoredCredentials): Promise<boolean> {
  if (creds.source !== 'file' || !creds.path)
    return creds.source === 'keychain';
  try {
    await access(creds.path, constants.R_OK | constants.W_OK);
    await access(dirname(creds.path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Atomic, private replace: a fresh temp file (never a followed link), then rename. */
async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf-8');
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * The Keychain item's own account: `-U` only updates an item with the same
 * service and account (another account adds a second item, and reads by
 * service return the first). Falls back to the login name.
 */
async function keychainAccount(): Promise<string> {
  try {
    const { stdout, stderr } = await findKeychainItem([]);
    const match = `${stdout}\n${stderr}`.match(
      /"acct"<blob>="((?:[^"\\]|\\.)*)"/
    );
    if (match) return match[1];
  } catch {
    // fall back below
  }
  if (process.env.USER) return process.env.USER;
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/**
 * Writes a refreshed pair back into the login it came from (`expected` is the
 * refresh token that login held when it was read), keeping everything else
 * (e.g. mcpOAuth). The file write is atomic so a reading Claude Code never
 * sees a partial file; the Keychain item goes through `security -i`
 * (src/keychain.ts), so the tokens never appear in `ps`.
 */
export async function persistRefreshed(
  creds: StoredCredentials,
  update: TokenUpdate,
  expected: string,
  logger?: StoreLogger
): Promise<PersistResult> {
  if (creds.source === 'file' && creds.path) {
    const current = parseCredentialJson(
      await readFile(creds.path, 'utf-8'),
      'Credentials file'
    );
    const updated = withRefreshedTokens(current, update, expected);
    if (updated === 'changed') return 'changed';
    await writeFileAtomic(creds.path, JSON.stringify(updated));
    return 'written';
  }
  if (creds.source !== 'keychain') return 'changed';
  const { stdout } = await findKeychainItem(['-w']);
  const updated = withRefreshedTokens(
    parseCredentialJson(stdout.trim(), 'Keychain item'),
    update,
    expected
  );
  if (updated === 'changed') return 'changed';
  await writeGenericPassword(
    {
      service: KEYCHAIN_SERVICE,
      account: await keychainAccount(),
      secret: JSON.stringify(updated),
    },
    { logger }
  );
  return 'written';
}
