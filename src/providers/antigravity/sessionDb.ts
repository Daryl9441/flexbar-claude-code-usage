/**
 * Reads Antigravity's `conversation_summaries.db` (SQLite in WAL mode, one per
 * product data folder) without touching it: SQLite would create `-wal` and
 * `-shm` files next to a WAL database even for a read-only open, so
 *
 * - without a WAL file (or an empty one) the database is opened through a
 *   `file:` URI with `mode=ro&immutable=1`, which creates nothing;
 * - with a WAL file (a language server or agy is writing) the database and
 *   its WAL are copied into a private temp folder, read there and deleted.
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

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
}

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

  const readOnce = async (file: string): Promise<SummaryRow[] | null> => {
    if ((await sizeOf(file)) === null) return null;
    const walSize = await sizeOf(`${file}-wal`);
    if (!walSize) return readWith(sqlite, immutableUri(file));
    const dir = await fsp.mkdtemp(path.join(tmpRoot, 'flexbar-ag-'));
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
