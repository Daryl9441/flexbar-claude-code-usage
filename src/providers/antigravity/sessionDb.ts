/**
 * Reads Antigravity's `conversation_summaries.db` (SQLite in WAL mode, one per
 * product data folder) without touching it: SQLite would create `-wal` and
 * `-shm` files next to a WAL database even for a read-only open, so
 *
 * - without a WAL file (or an empty one) the database is opened through a
 *   `file:` URI with `mode=ro&immutable=1`, which creates nothing;
 * - with a WAL file (a language server or agy is writing) the database and
 *   its WAL are copied into a private temp folder, read there and deleted.
 *   Copies an earlier run left behind (the plugin was killed mid-read) are
 *   removed when the first reader is created.
 *
 * Only regular files are read (a named pipe in their place would block the
 * open), and none larger than 256 MiB.
 *
 * node:sqlite comes with FlexDesigner's Node runtime (22.x); without it the
 * reader is off and the sessions come from the language servers alone.
 * Rows are only parsed in memory; nothing from them is logged.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SummaryRow } from './sessionSummary';

export const SUMMARY_DB = 'conversation_summaries.db';
/** Rows read per database, newest first */
const ROW_LIMIT = 300;
/** Larger databases (or WAL files) are not read or copied */
const MAX_DB_BYTES = 256 * 1024 * 1024;
/** Temp folders of the copies: flexbar-ag-<6 characters> (mkdtemp) */
const COPY_PREFIX = 'flexbar-ag-';
const COPY_RE = /^flexbar-ag-[A-Za-z0-9]{6}$/;
/** Leftover copies older than this are removed by sweepDbCopies */
const COPY_MAX_AGE_MS = 60_000;

/** The rows of one summary database, or null when it cannot be read. */
export type DbReader = (file: string) => Promise<SummaryRow[] | null>;

type Statement = { all(...params: unknown[]): unknown[] };
type Database = { prepare(sql: string): Statement; close(): void };
type SqliteModule = {
  DatabaseSync: new (
    location: string | URL,
    options?: { readOnly?: boolean }
  ) => Database;
};

let sqliteModule: SqliteModule | null | undefined;

/** node:sqlite, or null when this runtime has none. */
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

const QUERIES = [
  `SELECT * FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ${ROW_LIMIT}`,
  `SELECT * FROM conversation_summaries LIMIT ${ROW_LIMIT}`,
];

function query(db: Database): SummaryRow[] {
  let lastError: unknown = null;
  for (const sql of QUERIES) {
    try {
      return db.prepare(sql).all() as SummaryRow[];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function readWith(sqlite: SqliteModule, location: string | URL): SummaryRow[] {
  const db = new sqlite.DatabaseSync(location, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

/**
 * The size of a regular file; null when it is missing, and 'unreadable'
 * when it is something else (a named pipe, a folder) or too large.
 */
async function sizeOf(file: string): Promise<number | null | 'unreadable'> {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  return st.isFile() && st.size <= MAX_DB_BYTES ? st.size : 'unreadable';
}

/**
 * Removes the temp copies this plugin left in `dir` (a read cut short when
 * the plugin was stopped) that are older than `maxAgeMs`: only this user's
 * folders named like the reader's. Never throws; resolves to how many were
 * removed.
 */
export async function sweepDbCopies(
  dir: string = os.tmpdir(),
  maxAgeMs: number = COPY_MAX_AGE_MS,
  now: number = Date.now()
): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const uid = process.getuid?.() ?? null;
  let removed = 0;
  for (const name of names) {
    if (!COPY_RE.test(name)) continue;
    const folder = path.join(dir, name);
    try {
      const st = await fsp.lstat(folder);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      if (uid !== null && st.uid !== uid) continue;
      await fsp.rm(folder, { recursive: true, force: true });
      removed++;
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
  return removed;
}

/** Temp folders already swept in this process */
const swept = new Set<string>();

/** The immutable read-only URI of a database file. */
export function immutableUri(file: string): URL {
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return url;
}

export type DbReaderOptions = {
  sqlite?: SqliteModule | null;
  /** Where the temp copies go (default: the system temp folder) */
  tmpDir?: string;
};

/** A reader for this computer; null without node:sqlite. */
export function createDbReader(options: DbReaderOptions = {}): DbReader | null {
  const sqlite = options.sqlite === undefined ? loadSqlite() : options.sqlite;
  if (!sqlite) return null;
  const tmpRoot = options.tmpDir ?? os.tmpdir();
  if (!swept.has(tmpRoot)) {
    swept.add(tmpRoot);
    void sweepDbCopies(tmpRoot);
  }

  const readOnce = async (file: string): Promise<SummaryRow[] | null> => {
    const dbSize = await sizeOf(file);
    if (dbSize === null || dbSize === 'unreadable') return null;
    const walSize = await sizeOf(`${file}-wal`);
    if (walSize === 'unreadable') return null;
    if (!walSize) return readWith(sqlite, immutableUri(file));
    const dir = await fsp.mkdtemp(path.join(tmpRoot, COPY_PREFIX));
    try {
      const copy = path.join(dir, SUMMARY_DB);
      await fsp.copyFile(file, copy);
      try {
        await fsp.copyFile(`${file}-wal`, `${copy}-wal`);
      } catch {
        // checkpointed and removed meanwhile: the database alone is current
      }
      return readWith(sqlite, copy);
    } finally {
      await fsp
        .rm(dir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  };

  return async file => {
    try {
      return await readOnce(file);
    } catch {
      // read in the middle of a write or a checkpoint: once more
      try {
        return await readOnce(file);
      } catch {
        return null;
      }
    }
  };
}
