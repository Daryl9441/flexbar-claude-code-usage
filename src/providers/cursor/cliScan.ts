/**
 * Cursor Agent CLI sessions (`agent` / `cursor-agent`, also what
 * grok-delegate dispatches). The CLI does not write composerData into
 * state.vscdb; each run keeps `~/.cursor/chats/<workspace-hash>/<session-id>/`
 * with a small `meta.json` (createdAtMs, updatedAtMs, cwd) beside an
 * encrypted `store.db`. Only meta.json is read. store.db is never opened:
 * it holds message blobs and the key that unlocks them.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { CursorComposer } from './sessionScan';

const MAX_CLI = 36;
const MAX_META_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLI_SESSION_NAME = 'Agent CLI';

export type CliRow = {
  id: string;
  createdAtMs?: unknown;
  updatedAtMs?: unknown;
  cwd?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads only meta.json per session; skips anything odd. Missing dir -> []. */
export async function readCliRows(chatsDir: string): Promise<CliRow[]> {
  let hashes: string[];
  try {
    hashes = await fsp.readdir(chatsDir);
  } catch {
    return [];
  }
  const rows: CliRow[] = [];
  for (const hash of hashes) {
    if (!/^[0-9a-f]{8,64}$/i.test(hash)) continue;
    let ids: string[];
    try {
      ids = await fsp.readdir(path.join(chatsDir, hash));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!UUID.test(id)) continue;
      const file = path.join(chatsDir, hash, id, 'meta.json');
      try {
        const st = await fsp.lstat(file);
        if (!st.isFile() || st.size > MAX_META_BYTES) continue;
        const meta: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!isRecord(meta)) continue;
        rows.push({
          id,
          createdAtMs: meta.createdAtMs,
          updatedAtMs: meta.updatedAtMs,
          cwd: meta.cwd,
        });
      } catch {
        // unreadable or half-written meta; skip this session
      }
    }
  }
  return rows;
}

function ms(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > Date.UTC(2020, 0, 1) &&
    value < Date.UTC(2100, 0, 1)
    ? value
    : null;
}

function base(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  const cleaned = last.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  return cleaned || null;
}

/** Done-only rows: the CLI leaves no live status in meta.json. */
export function cliComposersFromRows(rows: readonly unknown[]): CursorComposer[] {
  const out: CursorComposer[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)) {
      continue;
    }
    const at = ms(row.updatedAtMs) ?? ms(row.createdAtMs);
    if (at === null) continue;
    out.push({
      id: row.id,
      name: CLI_SESSION_NAME,
      project: base(row.cwd),
      mode: 'agent',
      awaiting: false,
      generating: false,
      at,
      source: 'cli',
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_CLI);
}
