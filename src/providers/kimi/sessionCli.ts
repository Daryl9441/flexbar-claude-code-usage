/**
 * Kimi Code CLI sessions (read-only): `<kimiCodeHome>/sessions/<wd_…>/
 * <session_id>/` with `state.json` (title, cwd, archived, lastTurnReason)
 * and the turn journal `agents/main/wire.jsonl`.
 *
 * Every session directory is a candidate (state.json is small and cached by
 * mtime); only the "hot" ones, those a key may show, get their journal
 * followed. A workspace directory's mtime changes when a session is created
 * in it, so ordinary scans only list changed ones.
 */
import path from 'node:path';

import { SessionState, SessionStatus } from '../../session';
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

export type CliMeta = {
  title: string | null;
  cwd: string | null;
  archived: boolean;
  /** A sub-session (custom.child_session_kind = "child"): never shown */
  child: boolean;
  lastTurnReason: string | null;
  updatedAt: number | null;
};

export type CliCandidate = {
  /** The session directory (unique key) */
  dir: string;
  /** session_<uuid> */
  id: string;
  /** wd_<slug>_<hash> */
  wd: string;
  /**
   * Newest write to state.json or the main journal. Reopening a session
   * moves it too, so it only decides what is followed, never the order.
   */
  mtimeMs: number;
  /** state.json's mtime (for sessions without an updatedAt field) */
  stateMtimeMs: number | null;
  meta: JsonFile<CliMeta | null>;
};

/** The most recent sub-agent journals followed per hot session */
const MAX_SUBAGENTS = 8;

function metaOf(raw: unknown): CliMeta | null {
  if (!isObj(raw)) return null;
  const custom = isObj(raw.custom) ? raw.custom : {};
  return {
    title: cleanTitle(raw.title) ?? cleanTitle(raw.lastPrompt),
    cwd: str(raw.cwd) ?? str(raw.workDir),
    archived: raw.archived === true,
    child: custom.child_session_kind === 'child',
    lastTurnReason: str(raw.lastTurnReason),
    updatedAt: timeOf(raw.updatedAt),
  };
}

/** The project name hidden in a workspace dir name: wd_<slug>_<12 hex>. */
export function slugOf(wd: string): string | null {
  const match = wd.match(/^wd_(.+)_[0-9a-f]{6,}$/i);
  return match ? match[1] : null;
}

const REASON_STATE: Record<string, SessionState> = {
  completed: 'done',
  cancelled: 'interrupted',
  failed: 'error',
  blocked: 'error',
};

export class CliSessions {
  readonly sessionsDir: string;
  readonly candidates = new Map<string, CliCandidate>();
  /** Session dirs a watcher saw change */
  readonly dirty = new Set<string>();
  private wdMtimes = new Map<string, number>();
  private wires = new Map<string, WireFile>();
  private subWires = new Map<string, Map<string, WireFile>>();

  constructor(readonly home: string) {
    this.sessionsDir = path.join(home, 'sessions');
  }

  /** Whether the Kimi Code home exists at all. */
  installed(): Promise<boolean> {
    return isDir(this.home);
  }

  /**
   * Updates the candidates. Changed workspace dirs are listed again (all of
   * them on a full scan); appends are seen by re-statting hot sessions.
   */
  async scan(full: boolean) {
    const seenWd = new Set<string>();
    for (const wd of await readDir(this.sessionsDir)) {
      if (!wd.isDirectory()) continue;
      const wdPath = path.join(this.sessionsDir, wd.name);
      seenWd.add(wd.name);
      const mtimeMs = await dirMtimeOf(wdPath);
      if (mtimeMs === null) continue;
      if (!full && this.wdMtimes.get(wd.name) === mtimeMs) continue;
      this.wdMtimes.set(wd.name, mtimeMs);
      const present = new Set<string>();
      for (const entry of await readDir(wdPath)) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(wdPath, entry.name);
        present.add(dir);
        if (full || !this.candidates.has(dir)) {
          await this.stat(dir, wd.name, entry.name);
        }
      }
      for (const [dir, c] of this.candidates) {
        if (c.wd === wd.name && !present.has(dir)) this.forget(dir);
      }
    }
    for (const [dir, c] of this.candidates) {
      if (!seenWd.has(c.wd)) this.forget(dir);
    }
    for (const name of this.wdMtimes.keys()) {
      if (!seenWd.has(name)) this.wdMtimes.delete(name);
    }
    // state.json holds the cwd the project filter matches
    if (full) for (const c of this.candidates.values()) await c.meta.sync();
  }

  /** Re-stats one session dir (watcher hit or scan). */
  async stat(dir: string, wd?: string, id?: string) {
    const state = await mtimeOf(path.join(dir, 'state.json'));
    const wire = await mtimeOf(path.join(dir, 'agents', 'main', 'wire.jsonl'));
    if (state === null && wire === null) {
      this.forget(dir);
      return;
    }
    const prev = this.candidates.get(dir);
    const c: CliCandidate = prev ?? {
      dir,
      id: id ?? path.basename(dir),
      wd: wd ?? path.basename(path.dirname(dir)),
      mtimeMs: 0,
      stateMtimeMs: null,
      meta: new JsonFile<CliMeta | null>(
        path.join(dir, 'state.json'),
        null,
        metaOf
      ),
    };
    c.mtimeMs = Math.max(state ?? 0, wire ?? 0);
    c.stateMtimeMs = state;
    this.candidates.set(dir, c);
    if (!prev) await c.meta.sync();
  }

  private forget(dir: string) {
    this.candidates.delete(dir);
    this.wires.delete(dir);
    this.subWires.delete(dir);
  }

  /** Re-stats the sessions a watcher reported, so they can become hot. */
  async syncDirty() {
    for (const dir of this.dirty) {
      await this.stat(dir);
      await this.candidates.get(dir)?.meta.sync();
    }
    this.dirty.clear();
  }

  /** Brings the journals of the hot sessions up to date; drops the rest. */
  async sync(hot: Set<string>) {
    for (const dir of hot) {
      const c = this.candidates.get(dir);
      if (!c) continue;
      await this.stat(dir);
      await c.meta.sync();
      let wire = this.wires.get(dir);
      if (!wire) {
        wire = new WireFile(path.join(dir, 'agents', 'main', 'wire.jsonl'));
        this.wires.set(dir, wire);
      }
      try {
        await wire.sync();
      } catch {
        this.wires.delete(dir); // no journal (yet)
      }
      await this.syncSubagents(dir, wire);
    }
    for (const dir of [...this.wires.keys()]) {
      if (!hot.has(dir)) {
        this.wires.delete(dir);
        this.subWires.delete(dir);
      }
    }
  }

  /**
   * A sub-agent can wait for an approval or answer while the main journal
   * only shows its running Agent call: follow sub-agent journals then.
   */
  private async syncSubagents(dir: string, main: WireFile | undefined) {
    const waitsOnAgent =
      !!main &&
      [...main.acc.tools.values()].some(t => /^Agent/.test(t.name)) &&
      main.acc.interactions.size === 0;
    if (!waitsOnAgent) {
      this.subWires.delete(dir);
      return;
    }
    const agentsDir = path.join(dir, 'agents');
    const found: { file: string; mtimeMs: number }[] = [];
    for (const entry of await readDir(agentsDir)) {
      if (!entry.isDirectory() || entry.name === 'main') continue;
      const file = path.join(agentsDir, entry.name, 'wire.jsonl');
      const mtimeMs = await mtimeOf(file);
      if (mtimeMs !== null) found.push({ file, mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const previous = this.subWires.get(dir) ?? new Map<string, WireFile>();
    const next = new Map<string, WireFile>();
    for (const { file } of found.slice(0, MAX_SUBAGENTS)) {
      const wire = previous.get(file) ?? new WireFile(file);
      try {
        await wire.sync();
        next.set(file, wire);
      } catch {
        // removed meanwhile
      }
    }
    this.subWires.set(dir, next);
  }

  /** Whether a candidate is shown at all (not archived, not a child). */
  visible(c: CliCandidate): boolean {
    const meta = c.meta.value;
    return !meta?.archived && !meta?.child;
  }

  /** Texts the project filter is matched against. */
  filterTexts(c: CliCandidate): string[] {
    return [c.meta.value?.cwd ?? '', slugOf(c.wd) ?? c.wd];
  }

  /** Whether the journal of this session is followed. */
  isHot(c: CliCandidate): boolean {
    return this.wires.has(c.dir);
  }

  /**
   * When a session last did something, for ordering: state.json's updatedAt
   * (its mtime without one) and, while its journal is followed, the newest
   * turn record. Not the journal's mtime: reopening a session appends
   * configuration records without any turn.
   */
  activityAt(c: CliCandidate): number {
    const stored = c.meta.value?.updatedAt ?? c.stateMtimeMs ?? 0;
    const turn = this.wires.get(c.dir)?.acc.lastActivity ?? 0;
    return Math.max(stored, turn) || c.mtimeMs;
  }

  /** The status of one session at `now`. */
  status(c: CliCandidate, now: number, idleMs: number): SessionStatus {
    const meta = c.meta.value;
    const wire = this.wires.get(c.dir);
    let status: SessionStatus;
    if (wire) {
      status = deriveWireStatus(wire.acc, {
        now,
        idleMs,
        mtimeMs: wire.mtimeMs,
      });
      const reason = meta?.lastTurnReason;
      const turnStart = wire.acc.turnStartedAt;
      if (
        status.state === 'working' &&
        reason &&
        REASON_STATE[reason] &&
        meta?.updatedAt != null &&
        (turnStart === null || meta.updatedAt >= turnStart)
      ) {
        // the journal tail lacks the end, state.json has it
        status.state = REASON_STATE[reason];
        status.since = meta.updatedAt;
        status.lastActivity = Math.max(
          status.lastActivity ?? 0,
          meta.updatedAt
        );
        status = decay(status, now, idleMs);
      } else if (status.state === 'working') {
        status = this.withSubagents(c, status, now, idleMs);
      }
    } else {
      // not followed (or no journal): what state.json says
      const reason = meta?.lastTurnReason;
      const at = meta?.updatedAt ?? (c.mtimeMs || null);
      status = decay(
        makeStatus({
          state: (reason && REASON_STATE[reason]) || 'idle',
          lastActivity: at,
          since: at,
        }),
        now,
        idleMs
      );
    }
    status.title = meta?.title ?? null;
    status.project = meta?.cwd ? baseName(meta.cwd) : slugOf(c.wd);
    status.sessionId = c.id;
    return status;
  }

  private withSubagents(
    c: CliCandidate,
    status: SessionStatus,
    now: number,
    idleMs: number
  ): SessionStatus {
    for (const wire of this.subWires.get(c.dir)?.values() ?? []) {
      const sub = deriveWireStatus(wire.acc, {
        now,
        idleMs,
        mtimeMs: wire.mtimeMs,
      });
      if (sub.state === 'question' || sub.state === 'permission') {
        return {
          ...status,
          state: sub.state,
          confident: sub.confident,
          hasQuestion: sub.hasQuestion,
          question: sub.question,
          options: sub.options,
          tool: sub.tool,
          since: sub.since,
        };
      }
    }
    return status;
  }
}
