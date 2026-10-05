/**
 * Finds and follows Claude Code session transcripts on disk (read-only).
 *
 * Main-session transcripts live at `<claudeDir>/projects/<project>/<id>.jsonl`
 * (subagent transcripts sit deeper, under `<id>/subagents/`). Claude Code
 * also keeps a registry of running sessions in `<claudeDir>/sessions/
 * <pid>.json` with a live busy/idle/waiting status, used when present.
 *
 * Transcripts are read from the tail on first sight and then incrementally:
 * only bytes appended since the last read are parsed.
 */
import { Dirent, FSWatcher, promises as fsp, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Accumulator,
  LiveInfo,
  RunningSession,
  SessionStatus,
  createAccumulator,
  deriveStatus,
  observeLines,
  pickSession,
  runningGroup,
  sortRunning,
} from './session';

const INITIAL_TAIL_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
/** Most recent transcripts per filter that are parsed and considered */
const HOT_COUNT = 6;
/** Most sessions per filter the running-sessions list follows */
const MAX_RUNNING = 36;
const POLL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 300;
const FULL_SCAN_MS = 5 * 60_000;
const FULL_SCAN_UNWATCHED_MS = 30_000;

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

/** `~` expansion for user-entered paths. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** The Claude Code config dir: override, then CLAUDE_CONFIG_DIR, ~/.claude. */
export function resolveClaudeDir(override?: string | null): string {
  const custom = override?.trim();
  if (custom) return path.resolve(expandHome(custom));
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env) return path.resolve(expandHome(env));
  return path.join(os.homedir(), '.claude');
}

/**
 * Project filter in Claude Code's project-dir spelling: the dir name is the
 * cwd with every non-alphanumeric character replaced by "-".
 */
export function normalizeFilter(filter: string | null | undefined): string {
  return (filter ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-');
}

type Candidate = {
  path: string;
  projectDir: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
};

/** A transcript followed incrementally. */
export class TranscriptFile {
  acc: Accumulator = createAccumulator();
  private offset = 0;
  private ino = -1;
  private size = -1;
  private mtimeMs = -1;

  constructor(readonly path: string) {}

  /** Reads what was appended since the last sync; true when anything was. */
  async sync(): Promise<boolean> {
    const st = await fsp.stat(this.path);
    if (st.ino !== this.ino || st.size < this.offset) {
      // new or truncated/replaced file: start over from the tail
      this.ino = st.ino;
      this.size = -1;
      this.offset = 0;
      await this.readTail(st.size);
    } else if (st.size === this.size && st.mtimeMs === this.mtimeMs) {
      return false;
    } else if (st.size > this.offset) {
      await this.readRange(this.offset, st.size, false);
    }
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return true;
  }

  /**
   * Parses the end of the file, widening the window until it holds part of
   * the conversation (metadata lines alone say nothing about the state).
   */
  private async readTail(size: number) {
    for (let window = INITIAL_TAIL_BYTES; ; window *= 4) {
      const start = Math.max(0, size - window);
      this.acc = createAccumulator();
      this.offset = start;
      await this.readRange(start, size, start > 0);
      if (this.acc.sawConversation || start === 0 || window >= MAX_TAIL_BYTES) {
        return;
      }
    }
  }

  /**
   * Feeds the complete lines in [from, to) to the accumulator; a trailing
   * partial line is left for the next read. With skipFirst, bytes up to the
   * first newline are dropped (the read starts mid-line).
   */
  private async readRange(from: number, to: number, skipFirst: boolean) {
    const fh = await fsp.open(this.path, 'r');
    try {
      let pos = from;
      let carry: Buffer = Buffer.alloc(0);
      let skipping = skipFirst;
      while (pos < to) {
        const length = Math.min(READ_CHUNK_BYTES, to - pos);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await fh.read(chunk, 0, length, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        let data: Buffer = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        if (skipping) {
          const nl = data.indexOf(0x0a);
          if (nl < 0) {
            carry = Buffer.alloc(0);
            this.offset = pos;
            continue;
          }
          data = data.subarray(nl + 1);
          skipping = false;
        }
        // newline bytes never occur inside a UTF-8 sequence, so splitting
        // at the last one keeps every decoded line intact
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl < 0) {
          carry = data;
          continue;
        }
        observeLines(this.acc, data.subarray(0, lastNl).toString('utf8'));
        carry = data.subarray(lastNl + 1);
        this.offset = pos - carry.length;
      }
    } finally {
      await fh.close();
    }
  }
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

type RefreshMode = 'watch' | 'poll' | 'full';
const RANK: Record<RefreshMode, number> = { watch: 0, poll: 1, full: 2 };

/**
 * Subagent activity only matters while tool calls are pending (a running
 * Agent call vs. a permission prompt) or after a turn ended (agents or
 * workflows still running in the background).
 */
function mayDependOnSubagents(acc: Accumulator): boolean {
  return acc.pending.size > 0 || acc.last?.kind === 'assistant';
}

export type MonitorOptions = {
  claudeDir: string;
  /** Called after each refresh, so keys can redraw when their image changed */
  onChange: () => void;
  logger?: Logger | null;
};

export type SessionPick = {
  status: SessionStatus | null;
  /** Other sessions (same filter) that are working or need the user */
  others: number;
};

/**
 * Keeps the newest transcripts parsed and up to date: fs.watch on the
 * projects dir (debounced), a poll that re-stats the hot files and the
 * project dirs, and an occasional full rescan.
 */
export class SessionMonitor {
  readonly projectsDir: string;
  private readonly sessionsDir: string;
  private candidates = new Map<string, Candidate>();
  private dirMtimes = new Map<string, number>();
  private files = new Map<string, TranscriptFile>();
  private live = new Map<string, LiveInfo>();
  private registryCache = new Map<
    string,
    { mtimeMs: number; data: Record<string, unknown> | null }
  >();
  private subagentAt = new Map<string, number>();
  private dirty = new Set<string>();
  private filters: string[] = [''];
  private runningWindowMs = 0;
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private queued: RefreshMode | null = null;
  private lastFullScan = 0;
  private stopped = false;

  constructor(private readonly options: MonitorOptions) {
    this.projectsDir = path.join(options.claudeDir, 'projects');
    this.sessionsDir = path.join(options.claudeDir, 'sessions');
  }

  start() {
    this.stopped = false;
    this.pollTimer = setInterval(() => void this.refresh('poll'), POLL_MS);
    this.ensureWatch();
    void this.refresh('full');
  }

  stop() {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
  }

  /** Project filters of the alive keys ("" = all projects). */
  setFilters(filters: string[]) {
    const next = [...new Set(filters.map(normalizeFilter))].sort();
    if (next.join('\n') === this.filters.join('\n')) return;
    this.filters = next.length ? next : [''];
    void this.refresh('poll');
  }

  /**
   * Keeps the transcripts that listRunning() may show parsed: those of live
   * processes and those written within this window (the largest idle
   * threshold of the alive keys).
   */
  setRunningWindow(ms: number) {
    const next = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (next === this.runningWindowMs) return;
    this.runningWindowMs = next;
    void this.refresh('poll');
  }

  /** Re-scans everything now (key press). */
  rescan(): Promise<void> {
    return this.refresh('full');
  }

  /**
   * Brings candidates and hot transcripts up to date. "watch" (a transcript
   * changed) only re-reads files, "poll" also looks for new session files
   * and re-reads the registry, "full" re-lists every project dir.
   */
  refresh(mode: RefreshMode = 'poll'): Promise<void> {
    if (this.running) {
      if (!this.queued || RANK[mode] > RANK[this.queued]) this.queued = mode;
      return this.running;
    }
    this.running = (async () => {
      try {
        let next: RefreshMode | null = mode;
        while (next && !this.stopped) {
          this.queued = null;
          await this.doRefresh(next);
          next = this.queued;
        }
      } catch (error) {
        this.options.logger?.warn?.('Session scan failed:', error);
      } finally {
        this.running = null;
        this.queued = null;
      }
      if (!this.stopped) this.options.onChange();
    })();
    return this.running;
  }

  /** The session a key with this filter shows, as of `now`. */
  getStatus(filter: string, now: number, idleMs: number): SessionPick {
    const list = this.matching(normalizeFilter(filter));
    const derived = list
      .filter(c => this.files.has(c.path))
      .map(c => {
        const file = this.files.get(c.path) as TranscriptFile;
        return {
          status: deriveStatus(file.acc, {
            now,
            idleMs,
            live: this.live.get(c.sessionId) ?? null,
            subagentActiveAt: this.subagentAt.get(c.sessionId) ?? null,
            project: c.projectDir,
            sessionId: c.sessionId,
          }),
        };
      });
    const { chosen, others } = pickSession(derived);
    return { status: chosen?.status ?? null, others };
  }

  /**
   * The running sessions a key with this filter lists, as of `now`: those
   * with a live Claude Code process plus those active within idleMs, minus
   * idle ones without a process. Ordered by sortRunning().
   */
  listRunning(filter: string, now: number, idleMs: number): RunningSession[] {
    const list: RunningSession[] = [];
    const f = normalizeFilter(filter);
    for (const c of this.runningCandidates(f, now, idleMs)) {
      const file = this.files.get(c.path);
      if (!file) continue;
      const live = this.live.get(c.sessionId) ?? null;
      const status = deriveStatus(file.acc, {
        now,
        idleMs,
        live,
        subagentActiveAt: this.subagentAt.get(c.sessionId) ?? null,
        project: c.projectDir,
        sessionId: c.sessionId,
      });
      if (!live && status.state === 'idle') continue;
      list.push({
        status,
        group: runningGroup(status),
        at: status.lastActivity ?? c.mtimeMs,
      });
    }
    return sortRunning(list);
  }

  /**
   * Candidates that may be running: a live process, or written within
   * windowMs. Most recent first, at most MAX_RUNNING.
   */
  private runningCandidates(
    filter: string,
    now: number,
    windowMs: number
  ): Candidate[] {
    return [...this.candidates.values()]
      .filter(
        c =>
          (this.live.has(c.sessionId) || now - c.mtimeMs <= windowMs) &&
          (!filter || this.matches(c, filter))
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_RUNNING);
  }

  /** Candidates matching a normalized filter, most recent first. */
  private matching(filter: string): Candidate[] {
    const all = [...this.candidates.values()]
      .filter(c => !filter || this.matches(c, filter))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const hot = all.slice(0, HOT_COUNT);
    // sessions a live process reports as waiting count however old
    for (const c of all.slice(HOT_COUNT)) {
      if (this.live.get(c.sessionId)?.status === 'waiting') hot.push(c);
    }
    return hot;
  }

  private matches(c: Candidate, filter: string): boolean {
    if (c.projectDir.toLowerCase().includes(filter)) return true;
    const cwd = this.files.get(c.path)?.acc.cwd;
    return !!cwd && normalizeFilter(cwd).includes(filter);
  }

  private ensureWatch() {
    // one-off scans (never started) need no watcher
    if (this.watcher || this.stopped || !this.pollTimer) return;
    try {
      this.watcher = watch(
        this.projectsDir,
        { recursive: true, persistent: false },
        (_event, filename) => this.onWatch(filename?.toString() ?? null)
      );
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null; // the poll sets it up again
      });
    } catch {
      this.watcher = null; // no projects dir yet, or no recursive watch
    }
  }

  private onWatch(filename: string | null) {
    if (filename) {
      const parts = filename.split(/[\\/]/);
      if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
        this.dirty.add(path.join(this.projectsDir, filename));
      } else {
        if (parts.length > 3 && parts[2] === 'subagents') {
          // the poll picks this up; subagents write too often to react
          this.subagentAt.set(parts[1], Date.now());
        }
        return;
      }
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh(filename ? 'watch' : 'poll');
    }, WATCH_DEBOUNCE_MS);
  }

  private async doRefresh(mode: RefreshMode) {
    this.ensureWatch();
    if (mode !== 'watch') {
      const now = Date.now();
      // without a watcher, appends to sessions outside the hot set are
      // only seen by a full scan, so scan more often
      const every = this.watcher ? FULL_SCAN_MS : FULL_SCAN_UNWATCHED_MS;
      const fullScan = mode === 'full' || now - this.lastFullScan > every;
      if (fullScan) this.lastFullScan = now;
      await this.scanProjects(fullScan);
      await this.readRegistry();
    }

    // re-stat watcher hits so new activity can enter the hot set
    for (const file of this.dirty) await this.statCandidate(file);
    this.dirty.clear();

    // the sessions keys show, plus those their running lists may show
    const hot = new Map<string, Candidate>();
    for (const filter of this.filters) {
      for (const c of this.matching(filter)) hot.set(c.path, c);
      const listed = this.runningCandidates(
        filter,
        Date.now(),
        this.runningWindowMs
      );
      for (const c of listed) hot.set(c.path, c);
    }
    for (const c of hot.values()) {
      await this.statCandidate(c.path);
      let file = this.files.get(c.path);
      if (!file) {
        file = new TranscriptFile(c.path);
        this.files.set(c.path, file);
      }
      try {
        await file.sync();
      } catch {
        this.files.delete(c.path);
        this.candidates.delete(c.path);
        continue;
      }
      // the watcher reports subagent writes as they happen; stat them on
      // full scans (startup, key press) and whenever there is no watcher
      if (
        (mode === 'full' || (mode === 'poll' && !this.watcher)) &&
        mayDependOnSubagents(file.acc)
      ) {
        await this.checkSubagents(c);
      }
    }
    // forget parsed files that left the hot set
    for (const p of this.files.keys()) {
      if (!hot.has(p)) this.files.delete(p);
    }
  }

  /**
   * Updates the candidate list. A project dir's mtime changes when a session
   * file is created in it, so only changed dirs are listed again (all of
   * them on a full scan); appends are caught by re-statting hot files.
   */
  private async scanProjects(full: boolean) {
    const dirs = await readDir(this.projectsDir);
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(this.projectsDir, dir.name);
      seen.add(dir.name);
      let mtimeMs: number;
      try {
        mtimeMs = (await fsp.stat(dirPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!full && this.dirMtimes.get(dir.name) === mtimeMs) continue;
      this.dirMtimes.set(dir.name, mtimeMs);
      const present = new Set<string>();
      for (const entry of await readDir(dirPath)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(dirPath, entry.name);
        present.add(file);
        if (full || !this.candidates.has(file)) await this.statCandidate(file);
      }
      for (const [file, c] of this.candidates) {
        if (c.projectDir === dir.name && !present.has(file)) {
          this.candidates.delete(file);
        }
      }
    }
    for (const [file, c] of this.candidates) {
      if (!seen.has(c.projectDir)) this.candidates.delete(file);
    }
    for (const name of this.dirMtimes.keys()) {
      if (!seen.has(name)) this.dirMtimes.delete(name);
    }
  }

  private async statCandidate(file: string) {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return;
      const rel = path.relative(this.projectsDir, file).split(path.sep);
      if (rel.length !== 2) return;
      this.candidates.set(file, {
        path: file,
        projectDir: rel[0],
        sessionId: path.basename(file, '.jsonl'),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      this.candidates.delete(file);
    }
  }

  /**
   * Live sessions from Claude Code's registry: `<pid>.json` files whose
   * process is still running. Only the .json files are read.
   */
  private async readRegistry() {
    const live = new Map<string, LiveInfo & { updatedAt: number }>();
    const seen = new Set<string>();
    for (const entry of await readDir(this.sessionsDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.sessionsDir, entry.name);
      seen.add(file);
      let data: Record<string, unknown> | null = null;
      try {
        const { mtimeMs } = await fsp.stat(file);
        const cached = this.registryCache.get(file);
        if (cached && cached.mtimeMs === mtimeMs) {
          data = cached.data;
        } else {
          try {
            const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
            data = parsed && typeof parsed === 'object' ? parsed : null;
          } catch {
            data = null; // being rewritten; try again next poll
          }
          this.registryCache.set(file, { mtimeMs, data });
        }
      } catch {
        continue;
      }
      if (!data || typeof data.sessionId !== 'string' || !isAlive(data.pid)) {
        continue;
      }
      const updatedAt = Number(data.statusUpdatedAt ?? data.updatedAt) || 0;
      const prev = live.get(data.sessionId);
      if (prev && prev.updatedAt >= updatedAt) continue;
      live.set(data.sessionId, {
        status: typeof data.status === 'string' ? data.status : 'unknown',
        waitingFor:
          typeof data.waitingFor === 'string' ? data.waitingFor : undefined,
        statusUpdatedAt: Number(data.statusUpdatedAt) || undefined,
        updatedAt,
      });
    }
    for (const file of this.registryCache.keys()) {
      if (!seen.has(file)) this.registryCache.delete(file);
    }
    this.live = live;
  }

  /** Newest write to the session's subagent transcripts (any depth). */
  private async checkSubagents(c: Candidate) {
    const dir = path.join(
      this.projectsDir,
      c.projectDir,
      c.sessionId,
      'subagents'
    );
    let newest = this.subagentAt.get(c.sessionId) ?? 0;
    let entries: string[];
    try {
      entries = (await fsp.readdir(dir, { recursive: true })) as string[];
    } catch {
      return;
    }
    for (const rel of entries) {
      if (!rel.endsWith('.jsonl')) continue;
      try {
        newest = Math.max(
          newest,
          (await fsp.stat(path.join(dir, rel))).mtimeMs
        );
      } catch {
        // removed meanwhile
      }
    }
    if (newest > 0) this.subagentAt.set(c.sessionId, newest);
  }
}
