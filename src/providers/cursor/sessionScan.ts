/**
 * Reads Cursor composer metadata from state.vscdb. Read-only: a regular
 * file, opened with SQLite's immutable URI so a lookup does not create a
 * WAL beside the original. Only title, status, mode and timestamps are
 * copied out. Message text stays in the database: the query never selects
 * the conversation or a bubble body.
 *
 * Cursor has no session-marker file, so this scan does not claim the app
 * process is idle or that a transcript line means a turn is still running.
 * `generating` (or a non-empty generatingBubbleIds list) is Working.
 * `awaitingUserResponse`, or a status Cursor uses for a user decision, is
 * Question. Anything else is only Done while it is inside the key's idle
 * window.
 */
import { promises as fsp } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadSqlite } from '../grokbot/usageAuth';
import { cliComposersFromRows, readCliRows } from './cliScan';

const MAX_COMPOSERS = 36;
const MIN_MS = Date.UTC(2020, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

const GENERATING_STATUS = new Set(['generating', 'applying']);
const WAITING_STATUS = new Set([
  'awaiting_user',
  'needs_user',
  'question',
  'waiting',
]);
const MODE = new Set(['agent', 'chat', 'plan', 'edit', 'background']);

/**
 * Indexed prefix scan. `substr` is 1-based, so 14 drops `composerData:`.
 * The selected expressions are metadata. Do not add `value` or a message
 * field here.
 */
export const COMPOSER_SQL = `
SELECT
  substr(key, 14) AS id,
  json_extract(value, '$.name') AS name,
  json_extract(value, '$.status') AS status,
  json_extract(value, '$.lastUpdatedAt') AS updatedAt,
  json_extract(value, '$.createdAt') AS createdAt,
  json_extract(value, '$.unifiedMode') AS mode,
  json_extract(value, '$.isArchived') AS archived,
  json_extract(value, '$.isSubagent') AS subagent,
  json_extract(value, '$.awaitingUserResponse') AS awaiting,
  COALESCE(
    json_extract(value, '$.parentComposerId'),
    json_extract(value, '$.subagentInfo.parentComposerId')
  ) AS parentId,
  COALESCE(
    json_extract(value, '$.workspacePath'),
    json_extract(value, '$.workspaceFolder')
  ) AS project,
  CASE
    WHEN json_type(value, '$.generatingBubbleIds') = 'array'
    THEN json_array_length(value, '$.generatingBubbleIds')
    ELSE 0
  END AS generatingCount
FROM cursorDiskKV
WHERE key >= 'composerData:' AND key < 'composerData;'
`.trim();

export type CursorComposer = {
  id: string;
  name: string;
  project: string | null;
  mode: string | null;
  awaiting: boolean;
  generating: boolean;
  at: number;
  /** 'cli' for Agent CLI / grok-delegate runs; absent for app composers. */
  source?: 'cli';
};

export type CursorSnapshot = {
  installed: boolean;
  /** The database is there but this runtime could not query it. */
  unreadable: boolean;
  composers: CursorComposer[];
};

type Statement = { all(...params: unknown[]): unknown[] };
type Database = { prepare(sql: string): Statement; close(): void };

export type ScanInput = {
  databasePath: string;
  userDataDir: string;
  appCandidates: string[];
  exists: (file: string) => boolean;
  /** Defaults to the sqlite reader. Tests pass a stub. */
  readRows?: (databasePath: string) => Promise<unknown[]>;
  /** ~/.cursor/chats. Omitted: no Agent CLI scan (app composers only). */
  cliChatsDir?: string;
  readCliRows?: (chatsDir: string) => Promise<unknown[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 0 && value < MIN_MS ? value * 1000 : value;
    return ms >= MIN_MS && ms < MAX_MS ? ms : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && !/[tT\-:Z]/.test(value)) {
      return epochMs(asNumber);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= MIN_MS && parsed < MAX_MS
      ? parsed
      : null;
  }
  return null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code < 32 ? ' ' : char;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || null;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 80) return null;
  for (const char of cleaned) {
    const code = char.charCodeAt(0);
    if (code <= 32) return null;
  }
  return cleaned;
}

function projectName(value: unknown): string | null {
  const cleaned = cleanName(value);
  if (!cleaned) return null;
  const parts = cleaned.split(/[/\\]/).filter(Boolean);
  const base = parts.length > 1 ? parts[parts.length - 1] : cleaned;
  if (base.startsWith('file:')) return null;
  return cleanName(base);
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function statusText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function modeOf(value: unknown): string | null {
  const text = statusText(value);
  return MODE.has(text) ? text : null;
}

function fallbackName(mode: string | null): string {
  if (mode === 'agent') return 'Agent';
  if (mode === 'plan') return 'Plan';
  if (mode === 'edit') return 'Edit';
  return 'Chat';
}

/** Drops message fields, subagents, archived chats and empty rows. */
export function composersFromRows(rows: readonly unknown[]): CursorComposer[] {
  const byId = new Map<string, CursorComposer>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = cleanId(row.id);
    if (!id) continue;
    if (flag(row.archived) || flag(row.subagent)) continue;
    const parent = cleanId(row.parentId);
    if (parent) continue;
    const status = statusText(row.status);
    const generating =
      flag(row.generating) ||
      (typeof row.generatingCount === 'number' && row.generatingCount > 0) ||
      GENERATING_STATUS.has(status);
    const awaiting = flag(row.awaiting) || WAITING_STATUS.has(status);
    const at = epochMs(row.updatedAt) ?? epochMs(row.createdAt);
    if (!generating && !awaiting && at === null) continue;
    const mode = modeOf(row.mode);
    const composer: CursorComposer = {
      id,
      name: cleanName(row.name) ?? fallbackName(mode),
      project: projectName(row.project),
      mode,
      awaiting,
      generating,
      at: at ?? 0,
    };
    const existing = byId.get(id);
    if (!existing || composer.at >= existing.at) byId.set(id, composer);
  }
  return [...byId.values()]
    .sort((a, b) => {
      const rank = (item: CursorComposer) =>
        item.awaiting ? 0 : item.generating ? 1 : 2;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return b.at - a.at;
    })
    .slice(0, MAX_COMPOSERS);
}

function placeExists(file: string, exists: (path: string) => boolean): boolean {
  try {
    return exists(file);
  } catch {
    return false;
  }
}

/** Composer rows, or [] when the table is not there yet. Throws when the file cannot be queried. */
export async function readComposerRows(
  databasePath: string
): Promise<unknown[]> {
  let st;
  try {
    st = await fsp.lstat(databasePath);
  } catch {
    return [];
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size <= 0) {
    throw new Error('Cursor state database could not be queried');
  }
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('Cursor state database could not be queried');
  const url = pathToFileURL(databasePath);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  let db: Database;
  try {
    db = new sqlite.DatabaseSync(url, { readOnly: true });
  } catch {
    throw new Error('Cursor state database could not be queried');
  }
  try {
    try {
      return db.prepare(COMPOSER_SQL).all();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/no such table/i.test(message)) return [];
      throw new Error('Cursor state database could not be queried');
    }
  } finally {
    try {
      db.close();
    } catch {
      // rows, if any, are already in memory
    }
  }
}

/** App composers win on id clash; CLI rows fill the rest. */
export function mergeComposers(
  app: readonly CursorComposer[],
  cli: readonly CursorComposer[]
): CursorComposer[] {
  const byId = new Map<string, CursorComposer>();
  for (const item of app) byId.set(item.id, item);
  for (const item of cli) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()]
    .sort((a, b) => {
      const rank = (item: CursorComposer) =>
        item.awaiting ? 0 : item.generating ? 1 : 2;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return b.at - a.at;
    })
    .slice(0, MAX_COMPOSERS);
}

async function cliComposers(input: ScanInput): Promise<CursorComposer[]> {
  if (!input.cliChatsDir) return [];
  try {
    const read = input.readCliRows ?? readCliRows;
    return cliComposersFromRows(await read(input.cliChatsDir));
  } catch {
    return [];
  }
}

export async function scanCursor(input: ScanInput): Promise<CursorSnapshot> {
  const snapshot = await scanCursorApp(input);
  const cli = await cliComposers(input);
  if (!cli.length) return snapshot;
  return {
    installed: true,
    unreadable: snapshot.unreadable,
    composers: mergeComposers(snapshot.composers, cli),
  };
}

async function scanCursorApp(input: ScanInput): Promise<CursorSnapshot> {
  const installed = [
    input.databasePath,
    input.userDataDir,
    ...input.appCandidates,
  ].some(place => placeExists(place, input.exists));
  if (!installed) return { installed: false, unreadable: false, composers: [] };
  const readRows = input.readRows ?? readComposerRows;
  let present = false;
  try {
    present = input.exists(input.databasePath);
  } catch {
    present = false;
  }
  if (!present) return { installed: true, unreadable: false, composers: [] };
  try {
    const rows = await readRows(input.databasePath);
    return {
      installed: true,
      unreadable: false,
      composers: composersFromRows(rows),
    };
  } catch {
    return { installed: true, unreadable: true, composers: [] };
  }
}
