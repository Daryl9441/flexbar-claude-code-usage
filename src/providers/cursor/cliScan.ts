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
export type LiveAgents = {
  resumeIds: Set<string>;
  workspaces: Set<string>;
  /** workspace -> absolute --brief-file of a running cursor_grok.py runner */
  briefs?: Map<string, string>;
};

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
  live.briefs = new Map();
  for (const line of text.split('\n')) {
    const command = line.replace(/^\s*\d+\s+/, '');
    if (/cursor_grok\.py\s+run\s/.test(command)) {
      const ws = /--workspace(?:=|\s+)(.+?)(?=\s--?[a-z]|$)/i.exec(command);
      const brief = /--brief-file(?:=|\s+)(.+?)(?=\s--?[a-z]|$)/i.exec(command);
      if (ws && brief && brief[1].trim().startsWith('/')) {
        live.briefs.set(normPath(ws[1]), brief[1].trim());
      }
      continue;
    }
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

const TITLE_CHARS = 40;
const BRIEF_HEAD_BYTES = 2048;

/** First non-empty line of a brief, heading marks dropped, ~40 chars. */
export function titleFromHead(head: string): string | null {
  for (const raw of head.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*#+\s*/, '')
      .replace(/[\u0000-\u001f\u007f\ufffd]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    const chars = [...line];
    return chars.length > TITLE_CHARS
      ? chars.slice(0, TITLE_CHARS).join('').trimEnd() + '…'
      : line;
  }
  return null;
}

/** Reads at most the first 2 KB of a brief file. Never the rest. */
export async function readBriefTitle(file: string): Promise<string | null> {
  let handle: import('node:fs').promises.FileHandle | null = null;
  try {
    const st = await fsp.lstat(file);
    if (!st.isFile()) return null;
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(BRIEF_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BRIEF_HEAD_BYTES, 0);
    return titleFromHead(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Titles for live runner workspaces: normalized cwd -> title. */
export async function briefTitles(
  live: LiveAgents,
  read: (file: string) => Promise<string | null> = readBriefTitle
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [ws, file] of live.briefs ?? []) {
    const title = await read(file).catch(() => null);
    if (title) out.set(ws, title);
  }
  return out;
}

/** session id -> title seen while its run was live; kept after it exits. */
const TITLE_CACHE = new Map<string, string>();
const TITLE_CACHE_MAX = 300;

function remember(id: string, title: string): void {
  TITLE_CACHE.delete(id);
  TITLE_CACHE.set(id, title);
  while (TITLE_CACHE.size > TITLE_CACHE_MAX) {
    const oldest = TITLE_CACHE.keys().next().value;
    if (oldest === undefined) break;
    TITLE_CACHE.delete(oldest);
  }
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
  live: LiveAgents = NO_LIVE_AGENTS,
  titles: ReadonlyMap<string, string> = new Map()
): CursorComposer[] {
  const out: CursorComposer[] = [];
  const cwdOf = new Map<string, string>();
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
      cwdOf.set(row.id, key);
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
    const cwd = cwdOf.get(item.id);
    const fresh =
      item.generating && cwd && latestByCwd.get(cwd)?.id === item.id
        ? titles.get(cwd)
        : undefined;
    if (fresh) remember(item.id, fresh);
    const title = fresh ?? TITLE_CACHE.get(item.id);
    item.name = title
      ? title
      : item.project
        ? `${CLI_SESSION_NAME} · ${item.project}`
        : CLI_SESSION_NAME;
  }
  return out
    .sort((a, b) => {
      const byLive = Number(b.generating) - Number(a.generating);
      return byLive !== 0 ? byLive : b.at - a.at;
    })
    .slice(0, MAX_CLI);
}
