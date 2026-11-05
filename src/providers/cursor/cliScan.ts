/**
 * Cursor Agent CLI sessions (`agent` / `cursor-agent`, also what
 * grok-delegate dispatches). The CLI does not write composerData into
 * state.vscdb; each run keeps `~/.cursor/chats/<workspace-hash>/<session-id>/`
 * with a small `meta.json` (createdAtMs, updatedAtMs, cwd) beside an
 * encrypted `store.db`. Only meta.json is read. store.db is never opened:
 * it holds message blobs and the key that unlocks them.
 */
import { execFile } from 'node:child_process';
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

/** Live Agent CLI runs, parsed from one `ps` listing. Command text stays in memory. */
export type LiveAgents = { resumeIds: Set<string>; workspaces: Set<string> };

export const NO_LIVE_AGENTS: LiveAgents = {
  resumeIds: new Set(),
  workspaces: new Set(),
};

const AGENT_BIN = /(?:^|\/)(?:agent|cursor-agent)(?:\s|$)/;

function normPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/[/\\]+$/, '') : trimmed;
}

/** `ps -axo pid=,command=` text -> resumed session ids and workspaces. */
export function parseAgentProcesses(text: string): LiveAgents {
  const live: LiveAgents = { resumeIds: new Set(), workspaces: new Set() };
  for (const line of text.split('\n')) {
    const command = line.replace(/^\s*\d+\s+/, '');
    const bin = command.split(' --')[0];
    if (!AGENT_BIN.test(bin)) continue;
    if (/\sworker-server(\s|$)/.test(command)) continue;
    const resume = /--resume(?:=|\s+)([0-9a-f-]{36})/i.exec(command);
    if (resume && UUID.test(resume[1])) {
      live.resumeIds.add(resume[1].toLowerCase());
      continue;
    }
    const ws = /--workspace(?:=|\s+)(.+?)(?=\s--?[a-z]|$)/i.exec(command);
    if (ws) live.workspaces.add(normPath(ws[1]));
  }
  return live;
}

export type ProcessLister = () => Promise<string>;

/** One `ps` per poll. Any failure -> empty text (everything stays done). */
export const listProcesses: ProcessLister = () =>
  new Promise(resolve => {
    try {
      execFile(
        '/bin/ps',
        ['-axo', 'pid=,command='],
        { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => resolve(error ? '' : String(stdout))
      );
    } catch {
      resolve('');
    }
  });

export async function liveAgents(lister: ProcessLister): Promise<LiveAgents> {
  try {
    return parseAgentProcesses(await lister());
  } catch {
    return NO_LIVE_AGENTS;
  }
}

/**
 * Rows become generating while their agent process is alive: a `--resume`
 * id matches directly; otherwise a `--workspace` matches the most recently
 * updated session whose meta.json cwd is that path.
 */
export function cliComposersFromRows(
  rows: readonly unknown[],
  live: LiveAgents = NO_LIVE_AGENTS
): CursorComposer[] {
  const out: CursorComposer[] = [];
  const latestByCwd = new Map<string, { id: string; at: number }>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)) {
      continue;
    }
    const at = ms(row.updatedAtMs) ?? ms(row.createdAtMs);
    if (at === null) continue;
    if (typeof row.cwd === 'string' && row.cwd.trim()) {
      const key = normPath(row.cwd);
      const prev = latestByCwd.get(key);
      if (!prev || at > prev.at) latestByCwd.set(key, { id: row.id, at });
    }
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
  const byWorkspace = new Set<string>();
  for (const ws of live.workspaces) {
    const hit = latestByCwd.get(ws);
    if (hit) byWorkspace.add(hit.id);
  }
  for (const item of out) {
    if (live.resumeIds.has(item.id.toLowerCase()) || byWorkspace.has(item.id)) {
      item.generating = true;
    }
  }
  return out
    .sort((a, b) => {
      const byLive = Number(b.generating) - Number(a.generating);
      return byLive !== 0 ? byLive : b.at - a.at;
    })
    .slice(0, MAX_CLI);
}
