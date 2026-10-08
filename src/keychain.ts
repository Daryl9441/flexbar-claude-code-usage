/**
 * Writes a generic password item to the macOS login Keychain without putting
 * the secret on a command line, where `ps` shows it to every local user: one
 * `add-generic-password -U -a "<account>" -s "<service>" -X <hex>` line on
 * the stdin of `/usr/bin/security -i`.
 *
 * Measured with a fake item (macOS 26): security -i reads its input into a
 * 4096-byte buffer, 4095 characters per read, the newline included. A longer
 * command is split, so its first part writes a truncated item and the rest
 * fails as an unknown command whose error echoes it (the secret in hex). A
 * command of exactly 4095 characters runs whole, but leaves its newline for
 * the next read: an empty command, whose exit status 0 replaces a failure's.
 * So the line, newline included, is kept within 4095 bytes. A last line
 * without "\n" is silently ignored. The exit code is the last command's; a
 * failure also prints "<command>: returned <status>" and a success prints
 * nothing. (`-w` last, with the password on stdin, stores only its first 128
 * bytes, so it is no alternative.)
 */
import { ChildProcess, execFile, spawn } from 'node:child_process';

import { safeErrorMessage } from './redact';

export const SECURITY_PATH = '/usr/bin/security';
/** The longest line, its "\n" included, security -i reads in one piece */
export const INTERACTIVE_LINE_MAX = 4095;
const WRITE_TIMEOUT_MS = 15_000;
const STDERR_MAX = 8192;

export type KeychainItem = { service: string; account: string; secret: string };

export type KeychainWriteOptions = {
  spawn?: typeof spawn;
  execFile?: typeof execFile;
  logger?: { warn?: (...args: unknown[]) => void };
  timeoutMs?: number;
};

export type InteractiveLine =
  { line: string } | { problem: 'unsafe characters' | 'too long' };

/**
 * A value security -i takes inside double quotes. How it escapes a quote or
 * backslash is undocumented, and a control character could end the line, so
 * such values are not sent this way (macOS account names never have them).
 */
function quotable(value: string): boolean {
  return [...value].every(ch => {
    const code = ch.charCodeAt(0);
    return ch !== '"' && ch !== '\\' && code >= 0x20 && code !== 0x7f;
  });
}

/** The security -i command line for an item, or why there is none. */
export function interactiveAddLine(item: KeychainItem): InteractiveLine {
  if (!quotable(item.account) || !quotable(item.service)) {
    return { problem: 'unsafe characters' };
  }
  const hex = Buffer.from(item.secret, 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${item.account}" -s "${item.service}" -X ${hex}\n`;
  return Buffer.byteLength(line, 'utf8') <= INTERACTIVE_LINE_MAX
    ? { line }
    : { problem: 'too long' };
}

/** The last Keychain status security printed ("returned <status>"), if any. */
function lastStatus(stderr: string): string | undefined {
  return [...stderr.matchAll(/returned (-?\d+)/g)].at(-1)?.[1];
}

/**
 * Null for a successful run: exit 0 and no non-zero Keychain status (a
 * second guard should an empty command reset the exit code). Otherwise the
 * exit code and Keychain status only: security's stderr can echo the line,
 * i.e. the secret in hex.
 */
function interactiveFailure(
  code: number | null,
  stderr: string
): string | null {
  const status = lastStatus(stderr);
  if (code === 0 && (status === undefined || Number(status) === 0)) {
    return null;
  }
  const exit = code === null ? 'killed' : `exit ${code}`;
  return `security -i failed (${exit}${status ? `, status ${status}` : ''})`;
}

function runInteractive(
  line: string,
  options: KeychainWriteOptions
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? WRITE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawn)(SECURITY_PATH, ['-i'], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`Could not run security: ${safeErrorMessage(error)}`));
      return;
    }
    let stderr = '';
    let settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error(`security -i timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += chunk.toString('utf8');
    });
    child.on('error', error =>
      settle(new Error(`Could not run security: ${safeErrorMessage(error)}`))
    );
    child.on('close', code => {
      const failure = interactiveFailure(code, stderr);
      settle(failure === null ? null : new Error(failure));
    });
    // EPIPE when security exits early; its exit code says what went wrong
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(line);
  });
}

function runWithArgs(
  args: string[],
  options: KeychainWriteOptions
): Promise<void> {
  // an error from here repeats the command line, secret included: only a
  // sanitized message leaves this function
  const failed = (error: unknown) =>
    new Error(`Keychain write failed: ${safeErrorMessage(error)}`);
  return new Promise((resolve, reject) => {
    try {
      (options.execFile ?? execFile)(
        SECURITY_PATH,
        args,
        { timeout: options.timeoutMs ?? WRITE_TIMEOUT_MS, windowsHide: true },
        error => (error ? reject(failed(error)) : resolve())
      );
    } catch (error) {
      reject(failed(error));
    }
  });
}

/**
 * Adds or updates (-U, matched on service and account) a generic password
 * item. Returns how it was written: 'stdin' normally, 'argv' when security -i
 * cannot carry the item (see writeGenericPassword's fallback below).
 */
export async function writeGenericPassword(
  item: KeychainItem,
  options: KeychainWriteOptions = {}
): Promise<'stdin' | 'argv'> {
  const built = interactiveAddLine(item);
  if ('line' in built) {
    await runInteractive(built.line, options);
    return 'stdin';
  }
  // Fallback on purpose: the caller has just refreshed a login, which
  // rotated its refresh token. Not writing the new pair back would leave
  // Claude Code with a used-up refresh token and log it out, and a split
  // stdin line would store a truncated item. So such an item is written the
  // way it always was: as an argument, visible to `ps` while security runs.
  options.logger?.warn?.(
    `Keychain item ${built.problem === 'too long' ? 'too long' : 'has characters it cannot quote'} for security -i; writing it as a command-line argument instead`
  );
  await runWithArgs(
    [
      'add-generic-password',
      '-U',
      '-s',
      item.service,
      '-a',
      item.account,
      '-w',
      item.secret,
    ],
    options
  );
  return 'argv';
}
