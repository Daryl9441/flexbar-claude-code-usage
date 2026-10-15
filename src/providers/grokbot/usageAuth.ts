/**
 * Read-only lookup of Cursor's access token in its VS Code state database
 * (`cursorAuth/accessToken`). Grok Bot keeps its own copy in Electron safe
 * storage, which this plugin does not decrypt. The token stays in memory
 * and is sent only to Cursor's dashboard host. Nothing is logged, and a
 * failed read never quotes the database contents.
 *
 * A WAL database is copied into a temp folder first: opening the original
 * read-only can still create -wal/-shm files beside it.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GrokbotUsageError } from './usageText';

/** ItemTable key of the Cursor app's access token. Not the token itself. */
const CURSOR_AUTH_ITEM = 'cursorAuth/accessToken';
const MAX_DB_BYTES = 256 * 1024 * 1024;
const MAX_TOKEN_CHARS = 8192;
const COPY_PREFIX = 'flexbar-grokbot-';
const COPY_RE = /^flexbar-grokbot-[A-Za-z0-9]{6}$/;
const COPY_MAX_AGE_MS = 60_000;

type Statement = { all(...params: unknown[]): unknown[] };
type Database = { prepare(sql: string): Statement; close(): void };
type SqliteModule = {
  DatabaseSync: new (
    location: string | URL,
    options?: { readOnly?: boolean }
  ) => Database;
};

let sqliteModule: SqliteModule | null | undefined;

export function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    const mod = process.getBuiltinModule?.('node:sqlite') as
      SqliteModule | undefined;
    sqliteModule = mod && typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function tokenText(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === 'string') text = value;
  else if (value instanceof Uint8Array)
    text = Buffer.from(value).toString('utf8');
  if (text === null) return null;
  const trimmed = text.replace(/\0/g, '').trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_CHARS) return null;
  return trimmed;
}

function readRow(sqlite: SqliteModule, location: string | URL): string | null {
  let db: Database;
  try {
    db = new sqlite.DatabaseSync(location, { readOnly: true });
  } catch {
    throw new GrokbotUsageError(
      'state-unreadable',
      'Cursor state database could not be opened'
    );
  }
  try {
    let rows: unknown[];
    try {
      rows = db
        .prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1')
        .all(CURSOR_AUTH_ITEM);
    } catch {
      throw new GrokbotUsageError(
        'state-unreadable',
        'Cursor state database could not be queried'
      );
    }
    const row = rows[0];
    if (!row || typeof row !== 'object') return null;
    return tokenText((row as { value?: unknown }).value);
  } finally {
    try {
      db.close();
    } catch {
      // the token, if any, is already in memory
    }
  }
}

async function regularSize(file: string): Promise<number | null | 'bad'> {
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) return 'bad';
    if (st.size > MAX_DB_BYTES) return 'bad';
    return st.size;
  } catch {
    return null;
  }
}

async function sweepCopies(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const uid = process.getuid?.() ?? null;
  const now = Date.now();
  for (const name of names) {
    if (!COPY_RE.test(name)) continue;
    const folder = path.join(dir, name);
    try {
      const st = await fsp.lstat(folder);
      if (!st.isDirectory() || now - st.mtimeMs < COPY_MAX_AGE_MS) continue;
      if (uid !== null && st.uid !== uid) continue;
      await fsp.rm(folder, { recursive: true, force: true });
    } catch {
      // gone, or not ours
    }
  }
}

/**
 * The access token, or null when Cursor is not signed in. Throws
 * GrokbotUsageError when the database is present but cannot be read, or
 * when this runtime has no node:sqlite.
 */
export async function readCursorAccessToken(
  databasePath: string,
  tmpDir: string = os.tmpdir()
): Promise<string | null> {
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new GrokbotUsageError(
      'state-unreadable',
      'This runtime has no node:sqlite, so the Cursor login cannot be read'
    );
  }
  const size = await regularSize(databasePath);
  if (size === null) return null;
  if (size === 'bad') {
    throw new GrokbotUsageError(
      'state-unreadable',
      'Cursor state database is not a regular file this plugin can read'
    );
  }
  const wal = `${databasePath}-wal`;
  const walSize = await regularSize(wal);
  if (walSize === 'bad') {
    throw new GrokbotUsageError(
      'state-unreadable',
      'Cursor state database WAL is not a regular file'
    );
  }
  if (!walSize) {
    const url = pathToFileURL(databasePath);
    url.searchParams.set('mode', 'ro');
    url.searchParams.set('immutable', '1');
    return readRow(sqlite, url);
  }
  await sweepCopies(tmpDir);
  const dir = await fsp.mkdtemp(path.join(tmpDir, COPY_PREFIX));
  try {
    const copy = path.join(dir, 'state.vscdb');
    await fsp.copyFile(databasePath, copy);
    await fsp.copyFile(wal, `${copy}-wal`);
    try {
      await fsp.copyFile(`${databasePath}-shm`, `${copy}-shm`);
    } catch {
      // the WAL copy is enough when there is no shm
    }
    return readRow(sqlite, copy);
  } catch (error) {
    if (error instanceof GrokbotUsageError) throw error;
    throw new GrokbotUsageError(
      'state-unreadable',
      'Cursor state database could not be copied for a read-only lookup'
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
