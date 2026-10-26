/**
 * Open the Cursor access token stored in `cursorAuth/accessToken`.
 *
 * Older Cursor builds store a plaintext JWT. Newer ones, when
 * `cursor.storage.authTokenEncryptionAtRest` is on, store
 * `cursor-safe-storage:v1:` plus standard base64 of a Chromium `v10`/`v11`
 * ciphertext (Electron safeStorage, AES-128-CBC). The key comes from the
 * login keychain item `Cursor Safe Storage` / `Cursor Key`: PBKDF2-HMAC-SHA1,
 * salt `saltysalt`, 1003 rounds, 16 bytes, IV sixteen spaces. That is the
 * same scheme the Cursor app uses to read the cell. The password and the
 * token stay in memory; neither is logged, and the password is not kept
 * after the key is derived.
 *
 * The keychain is asked at most once per refusal. Every read can raise
 * macOS's confidential-information dialog, so a denial is remembered until
 * the user presses the key (`allowCursorKeychainPrompt`). A key that was
 * handed over is kept until it stops opening the cell.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { SECURITY_PATH } from '../../keychain';

const execFileAsync = promisify(execFile);

/** Prefix Cursor writes when the access-token cell is sealed. */
export const SEALED_PREFIX = 'cursor-safe-storage:v1:';
const SEALED_RE = /^cursor-safe-storage:v\d+:([\s\S]*)$/;
const KEYCHAIN_SERVICE = 'Cursor Safe Storage';
const KEYCHAIN_ACCOUNT = 'Cursor Key';
const OSCRYPT_SALT = 'saltysalt';
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const KEY_BYTES = 16;
const KEYCHAIN_TIMEOUT_MS = 90_000;

export type OpenedCursorToken =
  | { kind: 'token'; token: string }
  | { kind: 'absent' }
  | { kind: 'keychain-blocked' }
  | { kind: 'login-unreadable' };

export type CursorSealOptions = {
  platform?: NodeJS.Platform;
  /** Test seam. Production reads the login keychain on macOS. */
  readPassword?: () => Promise<string | null>;
};

let cachedKey: Buffer | null = null;
let refused = false;
let pending: Promise<Buffer | null> | null = null;

/** A press: the next sealed read may ask the keychain again. */
export function allowCursorKeychainPrompt(): void {
  refused = false;
}

/** Drops the in-memory key. Tests call this between cases. */
export function resetCursorSealState(): void {
  cachedKey = null;
  refused = false;
  pending = null;
}

/** Three dot-separated parts, the shape of the bearer Cursor's API accepts. */
export function looksLikeJwt(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 3 &&
    parts.every(part => part.length >= 8 && !/\s/.test(part))
  );
}

export function deriveOsCryptKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(
    password,
    OSCRYPT_SALT,
    iterations,
    KEY_BYTES,
    'sha1'
  );
}

/** Chromium OSCrypt `v10`/`v11` (AES-128-CBC). Null when the blob is not one. */
export function decryptOsCrypt(key: Buffer, sealed: Buffer): string | null {
  if (key.length !== KEY_BYTES || sealed.length < 3 + 16) return null;
  const version = sealed.subarray(0, 3).toString('latin1');
  if (version !== 'v10' && version !== 'v11') return null;
  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(3)),
      decipher.final(),
    ]);
    const text = plain.toString('utf8').replace(/\0/g, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function normalized(raw: string): string {
  let text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * The ciphertext, when `stored` is a sealed cell. A plaintext JWT is not
 * one. A bare base64 `v10` blob (no prefix) is, so a cell written without
 * the label is still opened.
 */
export function sealedCiphertext(stored: string): Buffer | null {
  const text = normalized(stored);
  if (!text || looksLikeJwt(text)) return null;
  const prefixed = SEALED_RE.exec(text);
  const encoded = (prefixed ? prefixed[1] : text).replace(/\s/g, '');
  if (!prefixed && !/^[A-Za-z0-9+/]+=*$/.test(encoded)) return null;
  if (encoded.length < 16) return null;
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 19) return null;
  const version = buf.subarray(0, 3).toString('latin1');
  if (version !== 'v10' && version !== 'v11') return null;
  if (!prefixed) {
    const back = buf.toString('base64').replace(/=+$/, '');
    if (back !== encoded.replace(/=+$/, '')) return null;
  }
  return buf;
}

async function defaultReadPassword(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      SECURITY_PATH,
      [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
      ],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024, windowsHide: true }
    );
    const password = String(stdout).replace(/\r?\n$/, '');
    return password || null;
  } catch {
    return null;
  }
}

async function loadKey(options: CursorSealOptions): Promise<Buffer | null> {
  if (cachedKey) return cachedKey;
  if (refused) return null;
  if (pending) return pending;
  const platform = options.platform ?? process.platform;
  const read =
    options.readPassword ??
    (platform === 'darwin' ? defaultReadPassword : null);
  if (!read) {
    refused = true;
    return null;
  }
  pending = (async () => {
    let password: string | null;
    try {
      password = await read();
    } catch {
      password = null;
    }
    if (!password) {
      refused = true;
      return null;
    }
    const iterations = platform === 'linux' ? LINUX_ITERATIONS : MAC_ITERATIONS;
    try {
      cachedKey = deriveOsCryptKey(password, iterations);
    } catch {
      cachedKey = null;
      refused = true;
    }
    return cachedKey;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * The bearer to send, or why there isn't one. A sealed or otherwise
 * non-JWT cell is never returned as the token: sending it is what made
 * Cursor answer 401 while the app was still signed in.
 */
export async function openStoredCursorToken(
  raw: string | null | undefined,
  options: CursorSealOptions = {}
): Promise<OpenedCursorToken> {
  if (raw === null || raw === undefined) return { kind: 'absent' };
  const text = normalized(raw);
  if (!text) return { kind: 'absent' };
  if (looksLikeJwt(text)) return { kind: 'token', token: text };
  const sealed = sealedCiphertext(text);
  if (!sealed) return { kind: 'login-unreadable' };

  const fromMemory = cachedKey !== null;
  let key = await loadKey(options);
  if (!key) return { kind: 'keychain-blocked' };
  let opened = decryptOsCrypt(key, sealed);
  if ((!opened || !looksLikeJwt(opened)) && fromMemory) {
    cachedKey = null;
    refused = false;
    key = await loadKey(options);
    if (!key) return { kind: 'keychain-blocked' };
    opened = decryptOsCrypt(key, sealed);
  }
  if (opened && looksLikeJwt(opened)) return { kind: 'token', token: opened };
  cachedKey = null;
  refused = true;
  return { kind: 'login-unreadable' };
}
