/**
 * Kimi desktop "Kimi Work" tasks (read-only), from the app's data folder:
 *
 * - `kimi-agent/conversation-statuses.json`: { key: running|completed|blocked },
 *   written by the app on every change; plus the user's renames, archive,
 *   unread list, projects and per-task context usage (its updatedAt).
 * - `daimon-share/daimon/agents/main/runner.state.json`: the local agent
 *   daemon's live state (active turns, pending questions). It also holds a
 *   loopback token: only the fields below are picked out, nothing else is
 *   kept, logged or quoted.
 * - `…/runner.lock/owner.json`: the daemon's heartbeat (every 60 s).
 * - `…/sessions/hosted-logical/conversations.sqlite`: AI-generated titles,
 *   automation tags (opened read-only through node:sqlite when the runtime
 *   has it; titles then fall back to the kernel's state.json).
 * - `daimon-share/daimon/runtime/kimi-code/home/sessions/<wd>/<conv-…>/`:
 *   the embedded Kimi Code kernel's state.json (title, conversation key)
 *   and turn journal, followed for hot tasks (tool, question, timing).
 *
 * Conversation keys look like `agent:main:main:conversation:<uuid>`.
 */
import path from 'node:path';

import type { SessionStatus } from '../../session';
import { makeStatus } from '../kit';

import {
  JsonFile,
  baseName,
  cleanTitle,
  dirMtimeOf,
  isDir,
  isObj,
  mtimeOf,
  readDir,
  str,
  timeOf,
} from './sessionFs';
import { WireFile } from './sessionTail';
import { decay, deriveWireStatus } from './sessionWire';

/** The daemon writes its heartbeat every 60 s */
const HEARTBEAT_FRESH_MS = 3 * 60_000;
/** A live daemon process may miss heartbeats while the Mac sleeps */
const HEARTBEAT_LIVE_PID_MS = 15 * 60_000;
/** Newest conversations read from the sqlite index */
const MAX_ROWS = 500;
/** Kernel session kinds that are not user tasks */
const SKIP_KERNEL = /^(ctitle|sklsum|dvlt|dream)[-_]/;

export type DesktopStatus = 'running' | 'completed' | 'blocked';

type Row = {
  title: string | null;
  automation: boolean;
  workspace: string | null;
  updatedAt: number | null;
};

type KernelSession = {
  dir: string;
  key: string | null;
  title: string | null;
  automation: boolean;
  workDir: string | null;
  updatedAt: number | null;
};

type Pending = { kind: string; toolName: string | null; at: number | null };

type RunnerInfo = {
  generationId: string | null;
  activeTurns: Map<string, number | null>;
  pending: Map<string, Pending>;
};

type OwnerInfo = {
  generationId: string | null;
  heartbeatAt: number | null;
  pid: number | null;
};

export type DesktopCandidate = {
  key: string;
  status: DesktopStatus | null;
  title: string | null;
  project: string | null;
  /** Texts the project filter is matched against */
  filterTexts: string[];
  automation: boolean;
  unread: boolean;
  /** Most recent activity known for this task (ms), or null */
  at: number | null;
};

// --- store converters (never keep more than the listed fields) -----------------

function stringMap(raw: unknown): Map<string, string> | undefined {
  if (!isObj(raw)) return undefined;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value) map.set(key, value);
  }
  return map;
}

function keySet(raw: unknown): Set<string> | undefined {
  // a JSON array of keys, or (archive) an object keyed by conversation
  if (Array.isArray(raw)) {
    return new Set(raw.filter((k): k is string => typeof k === 'string'));
  }
  if (isObj(raw)) return new Set(Object.keys(raw));
  return undefined;
}

function contextTimes(raw: unknown): Map<string, number> | undefined {
  if (!isObj(raw)) return undefined;
  const map = new Map<string, number>();
  for (const [key, value] of Object.entries(raw)) {
    const at = isObj(value) ? timeOf(value.updatedAt) : null;
    if (at !== null) map.set(key, at);
  }
  return map;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObj) : [];
}

/**
 * The daemon's live state: active turns and pending interactions by
 * conversation key. Interactions name their turn or operation, not the
 * conversation, so they are matched through the active operations.
 */
export function runnerInfo(raw: unknown): RunnerInfo | undefined {
  if (!isObj(raw)) return undefined;
  const generation = isObj(raw.daemonGeneration) ? raw.daemonGeneration : {};
  const info: RunnerInfo = {
    generationId: str(generation.generationId),
    activeTurns: new Map(),
    pending: new Map(),
  };
  const byOperation = new Map<string, string>();
  const byTurn = new Map<string, Set<string>>();
  const note = (op: Record<string, unknown>) => {
    const key = str(op.conversationKey);
    if (!key) return null;
    const opId = str(op.operationId);
    if (opId) byOperation.set(opId, key);
    const turn = op.turnId === undefined ? null : `${op.turnId}`;
    if (turn) byTurn.set(turn, (byTurn.get(turn) ?? new Set()).add(key));
    return key;
  };
  for (const turn of list(raw.activeKernelTurns)) {
    if (turn.sessionKind && turn.sessionKind !== 'conversation') continue;
    const key = note(turn);
    if (key) info.activeTurns.set(key, timeOf(turn.startedAt));
  }
  for (const op of list(raw.activeOperations)) {
    const key = note(op);
    if (!key) continue;
    if (op.kind === 'kernel_turn' && !info.activeTurns.has(key)) {
      info.activeTurns.set(key, timeOf(op.startedAt));
    } else if (op.kind === 'kernel_question') {
      info.pending.set(key, {
        kind: 'question',
        toolName: null,
        at: timeOf(op.startedAt),
      });
    }
  }
  const activeKeys = new Set(info.activeTurns.keys());
  for (const item of list(raw.activePendingInteractions)) {
    const kind = str(item.interactionKind) ?? 'question';
    // external_tool: the kernel waits for the app, not for the user
    if (kind === 'external_tool') continue;
    let key = str(item.conversationKey);
    const opId = str(item.operationId);
    if (!key && opId) key = byOperation.get(opId) ?? null;
    if (!key && item.turnId !== undefined) {
      const keys = byTurn.get(`${item.turnId}`);
      if (keys?.size === 1) key = [...keys][0];
    }
    if (!key && activeKeys.size === 1) key = [...activeKeys][0];
    if (!key) continue;
    info.pending.set(key, {
      kind,
      toolName: str(item.toolName),
      at: timeOf(item.startedAt),
    });
  }
  return info;
}

function ownerInfo(raw: unknown): OwnerInfo | undefined {
  if (!isObj(raw)) return undefined;
  return {
    generationId: str(raw.generationId),
    heartbeatAt: timeOf(raw.heartbeatAt),
    pid: typeof raw.pid === 'number' ? raw.pid : null,
  };
}

function pidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function kernelSession(dir: string) {
  return (raw: unknown): KernelSession | null | undefined => {
    if (!isObj(raw)) return undefined;
    const custom = isObj(raw.custom) ? raw.custom : {};
    const kind = str(custom.sessionKind);
    return {
      dir,
      key: kind && kind !== 'conversation' ? null : str(custom.conversationKey),
      title: cleanTitle(raw.title),
      automation: custom.workTag === 'cron',
      workDir: str(custom.workspacePath) ?? str(raw.workDir),
      updatedAt: timeOf(raw.updatedAt),
    };
  };
}

/** A project setting as a short name: a folder's last segment, or the name. */
function projectName(value: string | undefined): string | null {
  if (!value) return null;
  const name = /[\\/]/.test(value) ? baseName(value) : value;
  return cleanTitle(name);
}

// --- sqlite --------------------------------------------------------------------

type Database = {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};
type SqliteModule = {
  DatabaseSync: new (
    file: string,
    options?: { readOnly?: boolean }
  ) => Database;
};

let sqlite: SqliteModule | null | undefined;

/** node:sqlite when this runtime has it (Node ≥ 22.5), else null. */
function loadSqlite(): SqliteModule | null {
  if (sqlite !== undefined) return sqlite;
  try {
    const mod = process.getBuiltinModule?.('node:sqlite') as
      Partial<SqliteModule> | undefined;
    sqlite =
      typeof mod?.DatabaseSync === 'function' ? (mod as SqliteModule) : null;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

const ROWS_SQL = `SELECT conversation_key, title, work_tag, workspace_path, updated_at_ms
FROM conversations WHERE agent_id = 'main' ORDER BY updated_at_ms DESC LIMIT ${MAX_ROWS}`;

/** Titles and tags from the daemon's index; null when it cannot be read. */
function readRows(file: string): Map<string, Row> | null {
  const mod = loadSqlite();
  if (!mod) return null;
  let db: Database | null = null;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    const rows = new Map<string, Row>();
    for (const raw of db.prepare(ROWS_SQL).all()) {
      if (!isObj(raw)) continue;
      const key = str(raw.conversation_key);
      if (!key) continue;
      rows.set(key, {
        title: cleanTitle(raw.title),
        automation: raw.work_tag === 'cron',
        workspace: str(raw.workspace_path),
        updatedAt: timeOf(raw.updated_at_ms),
      });
    }
    return rows;
  } catch {
    return null; // busy, locked, or another schema
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

// --- the reader ------------------------------------------------------------------

export class DesktopSessions {
  readonly agentDir: string;
  readonly runnerDir: string;
  readonly kernelDir: string;
  private readonly dbFile: string;
  private readonly statuses: JsonFile<Map<string, string>>;
  private readonly titles: JsonFile<Map<string, string>>;
  private readonly archive: JsonFile<Set<string>>;
  private readonly unread: JsonFile<Set<string>>;
  private readonly projects: JsonFile<Map<string, string>>;
  private readonly context: JsonFile<Map<string, number>>;
  private readonly runner: JsonFile<RunnerInfo | null>;
  private readonly owner: JsonFile<OwnerInfo | null>;
  /** When each status last changed while we watched (ms) */
  private statusChangedAt = new Map<string, number>();
  private rows = new Map<string, Row>();
  private rowsSignature = '';
  /** Whether the sqlite index could be read (null: not tried) */
  sqliteOk: boolean | null = null;
  /** Kernel workspace dirs: mtime and the session dirs listed in them */
  private kernelWd = new Map<string, { mtimeMs: number; dirs: string[] }>();
  private kernel = new Map<string, JsonFile<KernelSession | null>>();
  /** Kernel session dir by conversation key */
  private kernelByKey = new Map<string, KernelSession>();
  private wires = new Map<string, WireFile>();
  /** Kernel session dirs a watcher saw change */
  readonly dirty = new Set<string>();

  constructor(readonly root: string) {
    this.agentDir = path.join(root, 'kimi-agent');
    const daimon = path.join(root, 'daimon-share', 'daimon');
    this.runnerDir = path.join(daimon, 'agents', 'main');
    this.kernelDir = path.join(
      daimon,
      'runtime',
      'kimi-code',
      'home',
      'sessions'
    );
    this.dbFile = path.join(
      this.runnerDir,
      'sessions',
      'hosted-logical',
      'conversations.sqlite'
    );
    const store = <T>(
      name: string,
      empty: T,
      convert: (raw: unknown) => T | undefined
    ) => new JsonFile<T>(path.join(this.agentDir, name), empty, convert);
    this.statuses = store('conversation-statuses.json', new Map(), stringMap);
    this.titles = store('conversation-titles.json', new Map(), stringMap);
    this.archive = store('conversation-archive.json', new Set(), keySet);
    this.unread = store('conversation-unread.json', new Set(), keySet);
    this.projects = store('conversation-projects.json', new Map(), stringMap);
    this.context = store(
      'conversation-context-usage.json',
      new Map(),
      contextTimes
    );
    this.runner = new JsonFile<RunnerInfo | null>(
      path.join(this.runnerDir, 'runner.state.json'),
      null,
      runnerInfo
    );
    this.owner = new JsonFile<OwnerInfo | null>(
      path.join(this.runnerDir, 'runner.lock', 'owner.json'),
      null,
      ownerInfo
    );
  }

  /** The app's data folder exists. */
  installed(): Promise<boolean> {
    return isDir(this.root);
  }

  /** Kimi Work was used at least once (its folders exist). */
  async used(): Promise<boolean> {
    return (
      (await isDir(this.agentDir)) ||
      (await isDir(path.join(this.root, 'daimon-share')))
    );
  }

  /** Re-reads the stores, the daemon state and the sqlite index if changed. */
  async readStores() {
    const before = new Map(this.statuses.value);
    const hadStatuses = this.statuses.mtimeMs !== null;
    if (await this.statuses.sync()) {
      const at = this.statuses.mtimeMs ?? Date.now();
      for (const [key, value] of this.statuses.value) {
        // the first read says nothing about when statuses were set
        if (hadStatuses && before.get(key) !== value) {
          this.statusChangedAt.set(key, at);
        }
      }
      for (const key of this.statusChangedAt.keys()) {
        if (!this.statuses.value.has(key)) this.statusChangedAt.delete(key);
      }
    }
    for (const file of [
      this.titles,
      this.archive,
      this.unread,
      this.projects,
      this.context,
      this.runner,
      this.owner,
    ]) {
      await file.sync();
    }
    await this.readIndex();
  }

  private async readIndex() {
    const parts = await Promise.all(
      ['', '-wal'].map(suffix => mtimeOf(this.dbFile + suffix))
    );
    if (parts[0] === null) {
      this.rows = new Map();
      this.rowsSignature = '';
      return;
    }
    const signature = parts.join(':');
    if (signature === this.rowsSignature) return;
    const rows = readRows(this.dbFile);
    this.sqliteOk = rows !== null;
    if (rows) {
      this.rows = rows;
      this.rowsSignature = signature;
    }
  }

  /**
   * Lists the embedded kernel's sessions (changed workspace dirs only,
   * unless full) and maps them to conversation keys.
   */
  async scanKernel(full: boolean) {
    const seen = new Set<string>();
    const seenWd = new Set<string>();
    for (const wd of await readDir(this.kernelDir)) {
      if (!wd.isDirectory()) continue;
      const wdPath = path.join(this.kernelDir, wd.name);
      const mtimeMs = await dirMtimeOf(wdPath);
      if (mtimeMs === null) continue;
      seenWd.add(wd.name);
      const known = this.kernelWd.get(wd.name);
      if (!full && known?.mtimeMs === mtimeMs) {
        // no session came or went: state.json changes arrive as watcher hits
        for (const dir of known.dirs) seen.add(dir);
        continue;
      }
      const dirs: string[] = [];
      for (const entry of await readDir(wdPath)) {
        if (!entry.isDirectory() || SKIP_KERNEL.test(entry.name)) continue;
        const dir = path.join(wdPath, entry.name);
        dirs.push(dir);
        seen.add(dir);
        let file = this.kernel.get(dir);
        if (!file) {
          file = new JsonFile(
            path.join(dir, 'state.json'),
            null,
            kernelSession(dir)
          );
          this.kernel.set(dir, file);
        }
        await file.sync();
      }
      this.kernelWd.set(wd.name, { mtimeMs, dirs });
    }
    for (const name of this.kernelWd.keys()) {
      if (!seenWd.has(name)) this.kernelWd.delete(name);
    }
    for (const dir of this.kernel.keys()) {
      if (!seen.has(dir)) this.kernel.delete(dir);
    }
    await this.syncDirty();
  }

  /** Re-reads the kernel state.json files a watcher reported. */
  async syncDirty() {
    for (const dir of this.dirty) await this.kernel.get(dir)?.sync();
    this.dirty.clear();
    this.kernelByKey = new Map();
    for (const file of this.kernel.values()) {
      const session = file.value;
      if (!session?.key) continue;
      const prev = this.kernelByKey.get(session.key);
      if (!prev || (session.updatedAt ?? 0) > (prev.updatedAt ?? 0)) {
        this.kernelByKey.set(session.key, session);
      }
    }
  }

  /** Follows the journals of the hot tasks; drops the rest. */
  async sync(hot: Set<string>) {
    for (const key of hot) {
      const session = this.kernelByKey.get(key);
      if (!session) continue;
      const file = path.join(session.dir, 'agents', 'main', 'wire.jsonl');
      let wire = this.wires.get(key);
      if (!wire || wire.path !== file) {
        wire = new WireFile(file);
        this.wires.set(key, wire);
      }
      try {
        await wire.sync();
      } catch {
        this.wires.delete(key);
      }
    }
    for (const key of [...this.wires.keys()]) {
      if (!hot.has(key)) this.wires.delete(key);
    }
  }

  /** Whether the agent daemon is running now. */
  daemonAlive(now: number): boolean {
    const owner = this.owner.value;
    if (!owner?.heartbeatAt) return false;
    const age = now - owner.heartbeatAt;
    if (age < HEARTBEAT_FRESH_MS) return true;
    return age < HEARTBEAT_LIVE_PID_MS && pidAlive(owner.pid);
  }

  /** The daemon state, when it belongs to the running daemon. */
  private liveRunner(now: number): RunnerInfo | null {
    const runner = this.runner.value;
    if (!runner || !this.daemonAlive(now)) return null;
    const owner = this.owner.value;
    if (
      runner.generationId &&
      owner?.generationId &&
      runner.generationId !== owner.generationId
    ) {
      return null; // left behind by an earlier daemon
    }
    return runner;
  }

  /** Every task the app knows of, archived ones left out. */
  candidates(now: number): DesktopCandidate[] {
    const keys = new Set<string>([
      ...this.statuses.value.keys(),
      ...this.rows.keys(),
      ...this.kernelByKey.keys(),
    ]);
    const runner = this.liveRunner(now);
    for (const key of runner?.activeTurns.keys() ?? []) keys.add(key);
    const archived = this.archive.value;
    const out: DesktopCandidate[] = [];
    for (const key of keys) {
      if (archived.has(key)) continue;
      const row = this.rows.get(key);
      const kernel = this.kernelByKey.get(key);
      const wire = this.wires.get(key);
      const status = this.statuses.value.get(key);
      const times = [
        row?.updatedAt,
        kernel?.updatedAt,
        this.context.value.get(key),
        this.statusChangedAt.get(key),
        wire?.acc.lastActivity,
        wire?.mtimeMs,
        runner?.activeTurns.get(key),
      ].filter((t): t is number => typeof t === 'number' && t > 0);
      const project = projectName(this.projects.value.get(key));
      out.push({
        key,
        status:
          status === 'running' || status === 'completed' || status === 'blocked'
            ? status
            : null,
        title:
          cleanTitle(this.titles.value.get(key)) ??
          row?.title ??
          kernel?.title ??
          null,
        project,
        filterTexts: [
          this.projects.value.get(key) ?? '',
          row?.workspace ?? '',
          kernel?.workDir ?? '',
          project ? '' : 'Kimi Work',
        ],
        automation: !!(row?.automation || kernel?.automation),
        unread: this.unread.value.has(key),
        at: times.length ? Math.max(...times) : null,
      });
    }
    return out;
  }

  /** Whether the task is running or waiting in the daemon now. */
  isActive(c: DesktopCandidate, now: number): boolean {
    const runner = this.liveRunner(now);
    return (
      c.status === 'running' ||
      !!runner?.activeTurns.has(c.key) ||
      !!runner?.pending.has(c.key)
    );
  }

  /** The status of one task at `now`. */
  status(c: DesktopCandidate, now: number, idleMs: number): SessionStatus {
    const alive = this.daemonAlive(now);
    const runner = this.liveRunner(now);
    const wire = this.wires.get(c.key);
    const journal = wire
      ? deriveWireStatus(wire.acc, { now, idleMs, mtimeMs: wire.mtimeMs })
      : null;
    const pending = runner?.pending.get(c.key) ?? null;
    const active = runner?.activeTurns.has(c.key) ?? false;
    const base = {
      title: c.title,
      project: c.project ?? 'Kimi Work',
      sessionId: c.key,
      lastActivity: c.at,
      since: c.at,
      live: alive,
    };
    let status: SessionStatus;
    if (pending) {
      const asking = pending.kind === 'question';
      status = makeStatus({
        ...base,
        state: asking ? 'question' : 'permission',
        hasQuestion: asking,
        question: asking ? (journal?.question ?? null) : null,
        options: asking ? (journal?.options ?? []) : [],
        tool: asking ? null : (journal?.tool ?? pending.toolName),
        since: pending.at ?? c.at,
      });
    } else if (c.status === 'running' || active) {
      if (
        journal &&
        (journal.state === 'question' ||
          journal.state === 'permission' ||
          journal.state === 'plan')
      ) {
        status = { ...journal, ...base, since: journal.since };
      } else if (alive) {
        const turnAt = runner?.activeTurns.get(c.key) ?? null;
        status = makeStatus({
          ...base,
          state: 'working',
          tool: journal?.state === 'working' ? journal.tool : null,
          since: turnAt ?? journal?.turnStartedAt ?? c.at,
          turnStartedAt: turnAt ?? journal?.turnStartedAt ?? null,
        });
        // "running" with no daemon turn and nothing written for long:
        // the app or daemon stopped mid-turn
        if (!active) status = decay(status, now, idleMs);
        if (status.state === 'idle') {
          status.state = 'interrupted';
          status.confident = false;
        }
      } else {
        status = makeStatus({
          ...base,
          state: 'interrupted',
          confident: false,
        });
      }
    } else if (c.status === 'completed') {
      status = makeStatus({
        ...base,
        state: 'done',
        hasQuestion: journal?.state === 'done' && journal.hasQuestion,
        question: journal?.state === 'done' ? journal.question : null,
      });
    } else if (c.status === 'blocked') {
      status = makeStatus({
        ...base,
        state: 'error',
        detail: journal?.state === 'error' ? journal.detail : null,
      });
    } else if (journal) {
      status = { ...journal, ...base, since: journal.since };
    } else {
      status = makeStatus({ ...base, state: 'idle' });
    }
    // a turn the daemon reports as active is working however quiet it is
    if (status.state === 'working' && active) return status;
    // an unread result stays "done" (up to half a day) until it is seen
    return decay(status, now, idleMs, c.unread);
  }
}
