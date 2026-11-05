/**
 * Cursor's access token for the usage key.
 *
 * The read is the one Grok Bot already uses (`readCursorAccessToken`):
 * read-only, WAL copied aside when it is small enough, a sealed cell opened
 * with the login-keychain item, a non-JWT never sent, nothing logged and
 * nothing written back. A state database that reader refuses for size is
 * opened again with SQLite's immutable read-only URI, which does not create
 * a WAL, and the same cell is passed through `openStoredCursorToken`.
 */
import { promises as fsp } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  CursorSealOptions,
  openStoredCursorToken,
} from '../grokbot/cursorSeal';
import { loadSqlite, readCursorAccessToken } from '../grokbot/usageAuth';
import { GrokbotUsageError } from '../grokbot/usageText';

import { CursorUsageError } from './usageText';

/** ItemTable key of the Cursor app's access token. Not the token itself. */
const CURSOR_AUTH_ITEM = 'cursorAuth/accessToken';
const MAX_CELL_CHARS = 8192;

const STATIC: Record<
  'keychain-blocked' | 'login-unreadable' | 'state-unreadable',
  string
> = {
  'keychain-blocked':
    'Cursor sealed its login and the keychain did not hand over the key',
  'login-unreadable':
    'Cursor login is stored, but it is not a usable access token',
  'state-unreadable': 'Cursor state database could not be read',
};

type Statement = { all(...params: unknown[]): unknown[] };
type Database = { prepare(sql: string): Statement; close(): void };

export type CursorLoginDeps = {
  /** Defaults to the shared reader. Tests pass a stub. */
  readToken?: (databasePath: string) => Promise<string | null>;
  /**
   * The raw `cursorAuth/accessToken` cell, used only when the shared reader
   * reports the database unreadable. Tests pass a stub. Not logged.
   */
  readStoredCell?: (databasePath: string) => Promise<string | null>;
  seal?: CursorSealOptions;
};

function loginError(
  problem: 'keychain-blocked' | 'login-unreadable' | 'state-unreadable'
): CursorUsageError {
  return new CursorUsageError(problem, STATIC[problem]);
}

function asCursorLoginError(error: unknown): CursorUsageError {
  if (error instanceof CursorUsageError) return error;
  if (error instanceof GrokbotUsageError) {
    if (
      error.problem === 'keychain-blocked' ||
      error.problem === 'login-unreadable' ||
      error.problem === 'state-unreadable'
    ) {
      return loginError(error.problem);
    }
  }
  return loginError('state-unreadable');
}

function cellText(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === 'string') text = value;
  else if (value instanceof Uint8Array)
    text = Buffer.from(value).toString('utf8');
  if (text === null) return null;
  const trimmed = text.replace(/\0/g, '').trim();
  if (!trimmed || trimmed.length > MAX_CELL_CHARS) return null;
  return trimmed;
}

/** One indexed lookup. Does not copy the database and does not log the cell. */
export async function readStoredCellImmutable(
  file: string
): Promise<string | null> {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch {
    throw loginError('state-unreadable');
  }
  if (!st.isFile() || st.isSymbolicLink()) throw loginError('state-unreadable');
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new CursorUsageError(
      'state-unreadable',
      'This runtime has no node:sqlite, so the Cursor login cannot be read'
    );
  }
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  let db: Database;
  try {
    db = new sqlite.DatabaseSync(url, { readOnly: true });
  } catch {
    throw loginError('state-unreadable');
  }
  try {
    let rows: unknown[];
    try {
      rows = db
        .prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1')
        .all(CURSOR_AUTH_ITEM);
    } catch {
      throw loginError('state-unreadable');
    }
    const row = rows[0];
    if (!row || typeof row !== 'object') return null;
    return cellText((row as { value?: unknown }).value);
  } finally {
    try {
      db.close();
    } catch {
      // the cell, if any, is already in memory
    }
  }
}

async function finishCell(
  stored: string | null,
  seal?: CursorSealOptions
): Promise<string | null> {
  const opened = await openStoredCursorToken(stored, seal);
  if (opened.kind === 'token') return opened.token;
  if (opened.kind === 'absent') return null;
  if (opened.kind === 'keychain-blocked') throw loginError('keychain-blocked');
  throw loginError('login-unreadable');
}

/**
 * The access token, or null when Cursor is not signed in. Throws a
 * CursorUsageError whose message does not quote the database or the token.
 */
export async function loadCursorAccessToken(
  databasePath: string,
  deps: CursorLoginDeps = {}
): Promise<string | null> {
  const readToken =
    deps.readToken ?? ((file: string) => readCursorAccessToken(file));
  try {
    const token = await readToken(databasePath);
    return token?.trim() || null;
  } catch (error) {
    if (
      !(error instanceof GrokbotUsageError) ||
      error.problem !== 'state-unreadable'
    ) {
      throw asCursorLoginError(error);
    }
  }
  const readCell = deps.readStoredCell ?? readStoredCellImmutable;
  let stored: string | null;
  try {
    stored = await readCell(databasePath);
  } catch (error) {
    throw asCursorLoginError(error);
  }
  return finishCell(stored, deps.seal);
}
