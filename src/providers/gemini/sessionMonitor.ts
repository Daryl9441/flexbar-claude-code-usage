/**
 * Finds and follows Gemini CLI session files on disk (read-only), and the
 * running CLIs they belong to.
 *
 * Sessions live at `<geminiHome>/tmp/<project>/chats/session-*.json(l)`;
 * `<project>` is a slug of the folder name (or, for old CLIs, the sha256 of
 * the folder path) and `.project_root` / `projects.json` give the folder.
 * Files of one session can appear twice (old hash folders are copied into
 * slug folders), so they are deduplicated by name and session id.
 *
 * Like the Claude monitor: fs.watch on `tmp` (debounced), a 5 s poll that
 * re-stats the files keys may show and lists changed chats folders, a full
 * rescan every few minutes, and a process probe (ps + lsof) at most every
 * 10 s while a key wants live detection. Only the most recent sessions per
 * key filter, the live ones and those in the running-list window are read.
 */
import { createHash } from 'node:crypto';
import { Dirent, FSWatcher, promises as fsp, watch } from 'node:fs';
import path from 'node:path';

import { safeErrorMessage } from '../../redact';
import {
  RunningSession,
  SessionStatus,
  pickSession,
  runningGroup,
  sortRunning,
} from '../../session';
import { langOf } from '../../sessionView';
import { unavailableNotice } from '../kit';
import {
  KeyData,
  Localized,
  Logger,
  SessionNotice,
  SessionPick,
  SessionSource,
} from '../types';

import { GEMINI_BRAND } from './brand';
import {
  GeminiFacts,
  GeminiTranscript,
  LiveSignal,
  deriveGeminiStatus,
  factsOf,
  freshStatus,
  parseDocument,
  parseDocumentSlices,
} from './sessionParse';
import { GeminiInstance, ProcessProbe } from './sessionProcs';

/** Most recent sessions per filter that are read and considered */
const HOT_COUNT = 6;
/** Most sessions per filter the running-sessions list follows */
const MAX_RUNNING = 36;
const POLL_MS = 5_000;
/** Shortest gap between two process probes (a key press probes at once) */
const PROBE_MS = 10_000;
/** …and a rescan probes unless one ran this recently */
const PROBE_MIN_GAP_MS = 2_000;
const WATCH_DEBOUNCE_MS = 300;
const FULL_SCAN_MS = 5 * 60_000;
const FULL_SCAN_UNWATCHED_MS = 30_000;
/** 0.36 documents beyond this are read from their head and tail only */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;
/** JSONL files beyond this are first read from their tail */
const MAX_JSONL_FULL_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const PEEK_BYTES = 4096;
/**
 * A session file is named after the minute (UTC) its CLI (or /clear)
 * started it; a CLI started up to this long after that minute began can
 * still be its author.
 */
const BORN_SLACK_MS = 65_000;
/** Keys asked for live detection this recently: keep probing */
const LIVE_WANTED_MS = 60_000;

const NAME_RE = /^session-(.+)\.(jsonl?)$/;
const NAME_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})(?:-(.*))?$/;
const HASH_DIR_RE = /^[0-9a-f]{64}$/;
/** Entries of a project folder whose changes matter (others: logs, history) */
const WATCHED_ENTRIES = new Set(['chats', '.project_root']);

const NEW_SESSION: Localized = { en: 'New session', zh: '新会话' };

/** "Not installed · Install Gemini CLI", like the Kimi and usage keys */
const CLI_NOT_FOUND: SessionNotice = unavailableNotice(
  'not-installed',
  GEMINI_BRAND
);

/**
 * A project filter or folder in one comparable spelling: lower case, runs
 * of anything but letters and digits as one "-" (CJK names stay intact),
 * so "my_app", "my app" and "My-App" all match "my-app".
 */
export function filterKey(text: string | null | undefined): string {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A folder path in one spelling for comparisons (case-insensitive on macOS/Windows). */
function samePathKey(p: string, platform: NodeJS.Platform): string {
  let key = p.replace(/[\\/]+$/, '') || p;
  if (platform === 'darwin' || platform === 'win32') key = key.toLowerCase();
  return key;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Name parts of a session file: its dedupe key, start minute and id prefix. */
export function parseSessionName(name: string): {
  base: string;
  format: 'json' | 'jsonl';
  bornAt: number | null;
  id8: string | null;
} | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const t = NAME_TIME_RE.exec(m[1]);
  return {
    base: `session-${m[1]}`,
    format: m[2] === 'jsonl' ? 'jsonl' : 'json',
    bornAt: t ? Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5]) : null,
    id8: t?.[6] ? t[6].slice(0, 8) : null,
  };
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readRange(
  file: string,
  from: number,
  to: number
): Promise<Buffer> {
  const fh = await fsp.open(file, 'r');
  try {
    const length = Math.max(0, to - from);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await fh.read(
        buffer,
        read,
        length - read,
        from + read
      );
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await fh.close();
  }
}

type Candidate = {
  path: string;
  /** Folder under tmp/ */
  dir: string;
  base: string;
  format: 'json' | 'jsonl';
  bornAt: number | null;
  id8: string | null;
  mtimeMs: number;
  size: number;
  /** main | subagent, once known (a peek at the file, then its parse) */
  kind: string | null;
  /** mtime the kind was last looked for */
  kindAt: number;
};

/** A session file read in compact form, re-read when it changes. */
class SessionFile {
  facts: GeminiFacts | null = null;
  private transcript = new GeminiTranscript();
  private offset = 0;
  private ino = -1;
  private size = -1;
  private mtimeMs = -1;

  constructor(
    readonly path: string,
    readonly format: 'json' | 'jsonl'
  ) {}

  /** Reads changes; false when nothing changed or the file was half written. */
  async sync(): Promise<boolean> {
    const st = await fsp.stat(this.path);
    if (
      st.ino === this.ino &&
      st.size === this.size &&
      st.mtimeMs === this.mtimeMs
    ) {
      return false;
    }
    if (this.format === 'json') {
      // rewritten whole on every change, not atomically: a failed parse is
      // a read in the middle of a write; keep the last facts and retry
      const transcript =
        st.size <= MAX_DOCUMENT_BYTES
          ? parseDocument(await fsp.readFile(this.path, 'utf8'))
          : await this.readSlices(st.size);
      if (!transcript) return false;
      this.facts = factsOf(transcript);
    } else {
      if (st.ino !== this.ino || st.size < this.offset) {
        this.transcript = new GeminiTranscript();
        this.offset = 0;
      }
      await this.readJsonl(st.size);
      this.facts = factsOf(this.transcript);
    }
    this.ino = st.ino;
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return true;
  }

  private async readSlices(size: number): Promise<GeminiTranscript | null> {
    const head = await readRange(this.path, 0, Math.min(size, HEAD_BYTES));
    const tail = await readRange(
      this.path,
      Math.max(0, size - TAIL_BYTES),
      size
    );
    return parseDocumentSlices(head.toString('utf8'), tail.toString('utf8'));
  }

  /** Applies the complete lines appended since the last read. */
  private async readJsonl(size: number) {
    if (this.offset === 0 && size > MAX_JSONL_FULL_BYTES) {
      // metadata from the first lines, the rest from the tail
      const head = (await readRange(this.path, 0, HEAD_BYTES)).toString('utf8');
      this.transcript.applyLines(head.slice(0, head.lastIndexOf('\n') + 1));
      const from = size - TAIL_BYTES;
      const chunk = await readRange(this.path, from, size);
      const nl = chunk.indexOf(0x0a);
      this.offset = nl < 0 ? size : from + nl + 1;
    }
    while (this.offset < size) {
      const to = Math.min(size, this.offset + READ_CHUNK_BYTES);
      const chunk = await readRange(this.path, this.offset, to);
      if (chunk.length === 0) break;
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl < 0) {
        if (to >= size) break; // a partial last line: next time
        // a line longer than a chunk: read it whole
        const rest = await readRange(this.path, this.offset, size);
        const end = rest.lastIndexOf(0x0a);
        if (end < 0) break;
        this.transcript.applyLines(rest.subarray(0, end).toString('utf8'));
        this.offset += end + 1;
        continue;
      }
      // newline bytes never occur inside a UTF-8 sequence
      this.transcript.applyLines(chunk.subarray(0, lastNl).toString('utf8'));
      this.offset += lastNl + 1;
    }
  }
}

type RefreshMode = 'watch' | 'poll' | 'full';
const RANK: Record<RefreshMode, number> = { watch: 0, poll: 1, full: 2 };

export type GeminiMonitorOptions = {
  /** The Gemini CLI home (geminiHome()) */
  home: string;
  onChange: () => void;
  logger?: Logger | null;
  /** Running CLIs; null: no live detection (files only) */
  probe?: ProcessProbe | null;
  /** Whether the Gemini CLI program is installed (for the notice) */
  cliInstalled?: () => boolean;
  platform?: NodeJS.Platform;
  /** Watch the folder (off for one-off scans and tests) */
  watch?: boolean;
  now?: () => number;
};

type ProjectDir = {
  /** Folder of `.project_root` content, or null */
  root: string | null;
  rootMtime: number;
  chatsMtime: number;
};

/** Live state of the session files, from the last process probe. */
type LiveMap = {
  /** Session file → the CLI that writes it */
  byPath: Map<string, GeminiInstance>;
  /** CLIs without a session file yet */
  fresh: GeminiInstance[];
  /** Some CLI's folder is unknown: sessions without a CLI may still run */
  partial: boolean;
};

/** Gemini CLI sessions as a SessionSource (one per provider, shared by its keys). */
export class GeminiSessionMonitor implements SessionSource {
  readonly tmpDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private candidates = new Map<string, Candidate>();
  private projects = new Map<string, ProjectDir>();
  private projectsJson: { mtimeMs: number; slugRoot: Map<string, string> } = {
    mtimeMs: -1,
    slugRoot: new Map(),
  };
  private hashRoot = new Map<string, string>();
  /** Visible (deduplicated main) sessions, most recent first */
  private list: Candidate[] = [];
  /** Files whose session id another, newer file also has */
  private shadowed = new Set<string>();
  private files = new Map<string, SessionFile>();
  /** `<dir>/<id8>` → newest subagent write */
  private subagentAt = new Map<string, number>();
  private dirty = new Set<string>();
  private filters: string[] = [''];
  private runningWindowMs = 0;
  private instances: GeminiInstance[] | null = null;
  private live: LiveMap | null = null;
  private lastProbe = 0;
  private liveAskedAt: number | null = null;
  private liveRefusedAt: number | null = null;
  private homeExists = false;
  private cliFound: boolean | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchMode: RefreshMode | null = null;
  private running: Promise<void> | null = null;
  private queued: RefreshMode | null = null;
  private lastFullScan = 0;
  private stopped = false;

  constructor(private readonly options: GeminiMonitorOptions) {
    this.tmpDir = path.join(options.home, 'tmp');
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
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

  setFilters(filters: string[]) {
    const next = [...new Set(filters.map(filterKey))].sort();
    if (next.join('\n') === this.filters.join('\n')) return;
    this.filters = next.length ? next : [''];
    void this.refresh('poll');
  }

  setRunningWindow(ms: number) {
    const next = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (next === this.runningWindowMs) return;
    this.runningWindowMs = next;
    void this.refresh('poll');
  }

  rescan(): Promise<void> {
    return this.refresh('full');
  }

  notice(): SessionNotice | null {
    return this.cliFound === false ? CLI_NOT_FOUND : null;
  }

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
        this.options.logger?.warn?.(
          `Gemini session scan failed: ${safeErrorMessage(error)}`
        );
      } finally {
        this.running = null;
        this.queued = null;
      }
      if (!this.stopped) this.options.onChange();
    })();
    return this.running;
  }

  // --- queries -------------------------------------------------------------------

  getStatus(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): SessionPick {
    const useLive = this.noteLiveWish(data, now);
    const f = filterKey(filter);
    const derived = this.matching(f)
      .map(c => this.statusOf(c, now, idleMs, useLive))
      .filter((s): s is SessionStatus => s !== null)
      .map(status => ({ status }));
    const { chosen, others } = pickSession(derived);
    if (chosen) return { status: chosen.status, others };
    // a CLI that has not recorded a prompt yet beats "No sessions"
    const fresh = useLive ? this.freshMatching(f, data) : [];
    return { status: fresh[0] ?? null, others: 0 };
  }

  listRunning(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): RunningSession[] {
    const useLive = this.noteLiveWish(data, now);
    const f = filterKey(filter);
    const list: RunningSession[] = [];
    for (const c of this.runningCandidates(f, now, idleMs, useLive)) {
      const status = this.statusOf(c, now, idleMs, useLive);
      if (!status || (!status.live && status.state === 'idle')) continue;
      list.push({
        status,
        group: runningGroup(status),
        at: status.lastActivity ?? c.mtimeMs,
      });
    }
    if (useLive) {
      for (const status of this.freshMatching(f, data)) {
        list.push({
          status,
          group: runningGroup(status),
          at: status.lastActivity ?? 0,
        });
      }
    }
    return sortRunning(list);
  }

  /** Records whether a key wants live detection; true when it does. */
  private noteLiveWish(data: KeyData | undefined, now: number): boolean {
    if (data?.liveDetection === false) {
      this.liveRefusedAt = now;
      return false;
    }
    this.liveAskedAt = now;
    return true;
  }

  private liveWanted(): boolean {
    if (!this.options.probe || !this.homeExists) return false;
    // before any key asked, or a key without the opt-out asked lately
    if (this.liveAskedAt === null) return this.liveRefusedAt === null;
    return this.now() - this.liveAskedAt < LIVE_WANTED_MS;
  }

  private liveOf(c: Candidate, useLive: boolean): LiveSignal | null {
    if (!useLive || !this.live) return null;
    const instance = this.live.byPath.get(c.path);
    if (instance) {
      return {
        alive: true,
        toolChildAt: instance.toolChildAt,
        approvalMode: instance.approvalMode,
      };
    }
    return this.live.partial
      ? null
      : { alive: false, toolChildAt: null, approvalMode: null };
  }

  private statusOf(
    c: Candidate,
    now: number,
    idleMs: number,
    useLive: boolean
  ): SessionStatus | null {
    const facts = this.files.get(c.path)?.facts;
    if (!facts || this.shadowed.has(c.path)) return null;
    const root = this.rootOf(c.dir);
    return deriveGeminiStatus(facts, {
      now,
      idleMs,
      live: this.liveOf(c, useLive),
      subagentAt: c.id8
        ? (this.subagentAt.get(`${c.dir}/${c.id8}`) ?? null)
        : null,
      project: root ? basename(root) : null,
    });
  }

  private freshMatching(filter: string, data?: KeyData): SessionStatus[] {
    const title = NEW_SESSION[langOf(data?.lang)];
    return (this.live?.fresh ?? [])
      .filter(i => i.cwd && (!filter || filterKey(i.cwd).includes(filter)))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(i =>
        freshStatus({
          project: basename(i.cwd as string),
          startedAt: i.startedAt,
          title,
        })
      );
  }

  /** Visible sessions matching a filter: the newest few plus the live ones. */
  private matching(filter: string): Candidate[] {
    const all = this.list.filter(c => this.matches(c, filter));
    const hot = all.slice(0, HOT_COUNT);
    for (const c of all.slice(HOT_COUNT)) {
      if (this.live?.byPath.has(c.path)) hot.push(c);
    }
    return hot;
  }

  /** Sessions that may be running: a live CLI, or written within windowMs. */
  private runningCandidates(
    filter: string,
    now: number,
    windowMs: number,
    useLive = true
  ): Candidate[] {
    return this.list
      .filter(
        c =>
          ((useLive && this.live?.byPath.has(c.path)) ||
            now - c.mtimeMs <= windowMs) &&
          this.matches(c, filter)
      )
      .slice(0, MAX_RUNNING);
  }

  private matches(c: Candidate, filter: string): boolean {
    if (!filter) return true;
    return filterKey(this.rootOf(c.dir) ?? c.dir).includes(filter);
  }

  private rootOf(dir: string): string | null {
    return (
      this.projects.get(dir)?.root ??
      this.projectsJson.slugRoot.get(dir) ??
      this.hashRoot.get(dir) ??
      null
    );
  }

  // --- refresh -------------------------------------------------------------------

  private ensureWatch() {
    if (this.options.watch === false) return;
    // one-off scans (never started) need no watcher
    if (this.watcher || this.stopped || !this.pollTimer) return;
    try {
      this.watcher = watch(
        this.tmpDir,
        { recursive: true, persistent: false },
        (_event, filename) => this.onWatch(filename?.toString() ?? null)
      );
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null; // the poll sets it up again
      });
    } catch {
      this.watcher = null; // no tmp folder yet, or no recursive watch
    }
  }

  private onWatch(filename: string | null) {
    let mode: RefreshMode = 'poll';
    if (filename) {
      const parts = filename.split(/[\\/]/);
      if (
        parts.length === 3 &&
        parts[1] === 'chats' &&
        NAME_RE.test(parts[2])
      ) {
        const file = path.join(this.tmpDir, filename);
        const known = this.candidates.get(file);
        if (known?.kind === 'subagent') {
          this.noteSubagent(parts[0], known.id8, Date.now());
          return;
        }
        this.dirty.add(file);
        mode = 'watch';
      } else if (
        parts.length === 4 &&
        parts[1] === 'chats' &&
        parts[3].endsWith('.jsonl')
      ) {
        // a subagent of session <parts[2]> wrote: the next redraw sees it
        this.noteSubagent(parts[0], parts[2].slice(0, 8), Date.now());
        return;
      } else if (
        parts.length > 2 ||
        (parts.length === 2 && !WATCHED_ENTRIES.has(parts[1]))
      ) {
        return; // logs.json, tool outputs, shell history, plans…
      }
    }
    // the widest refresh asked for within the debounce wins
    if (!this.watchMode || RANK[mode] > RANK[this.watchMode]) {
      this.watchMode = mode;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const next = this.watchMode ?? 'poll';
      this.debounceTimer = null;
      this.watchMode = null;
      void this.refresh(next);
    }, WATCH_DEBOUNCE_MS);
  }

  private noteSubagent(dir: string, id8: string | null, at: number) {
    if (!id8) return;
    const key = `${dir}/${id8}`;
    if ((this.subagentAt.get(key) ?? 0) < at) this.subagentAt.set(key, at);
  }

  private async doRefresh(mode: RefreshMode) {
    this.ensureWatch();
    if (mode !== 'watch') {
      const now = this.now();
      const every = this.watcher ? FULL_SCAN_MS : FULL_SCAN_UNWATCHED_MS;
      const full = mode === 'full' || now - this.lastFullScan > every;
      if (full) {
        this.lastFullScan = now;
        this.checkCli();
      }
      await this.scanProjects(full);
      await this.readProjectsJson();
      const gap = mode === 'full' ? PROBE_MIN_GAP_MS : PROBE_MS;
      if (this.liveWanted() && now - this.lastProbe >= gap) {
        await this.probe();
      } else if (!this.liveWanted()) {
        this.instances = null;
      }
    }
    for (const file of this.dirty) await this.statCandidate(file);
    this.dirty.clear();

    this.buildList();
    this.mapInstances();

    // the sessions keys show, those their running lists may show, live ones
    const hot = new Map<string, Candidate>();
    const now = this.now();
    for (const filter of this.filters) {
      for (const c of this.matching(filter)) hot.set(c.path, c);
      for (const c of this.runningCandidates(
        filter,
        now,
        this.runningWindowMs
      )) {
        hot.set(c.path, c);
      }
    }
    for (const hit of hot.values()) {
      // re-stat: appends to known files move them up the list
      await this.statCandidate(hit.path);
      const c = this.candidates.get(hit.path);
      if (!c) continue;
      let file = this.files.get(c.path);
      if (!file) {
        file = new SessionFile(c.path, c.format);
        this.files.set(c.path, file);
      }
      try {
        await file.sync();
      } catch {
        this.files.delete(c.path);
        this.candidates.delete(c.path);
        continue;
      }
      const kind = file.facts?.kind ?? null;
      if (kind && kind !== c.kind) {
        c.kind = kind;
        if (kind === 'subagent') this.noteSubagent(c.dir, c.id8, c.mtimeMs);
      }
    }
    this.buildList();
    this.mapInstances();
    this.dedupeSessions();
    // forget parsed files that left the hot set
    for (const p of this.files.keys()) {
      if (!hot.has(p)) this.files.delete(p);
    }
  }

  private checkCli() {
    try {
      this.cliFound = this.options.cliInstalled
        ? this.options.cliInstalled()
        : null;
    } catch {
      this.cliFound = null;
    }
  }

  private async probe() {
    this.lastProbe = this.now();
    try {
      this.instances = (await this.options.probe?.()) ?? null;
    } catch {
      this.instances = null;
    }
  }

  /**
   * Updates the project folders and candidates. A chats folder's mtime
   * changes when a session file is created in it, so only changed folders
   * are listed again (all of them on a full scan); writes to existing files
   * are caught by re-statting the hot files.
   */
  private async scanProjects(full: boolean) {
    let dirs: Dirent[];
    try {
      dirs = await fsp.readdir(this.tmpDir, { withFileTypes: true });
      this.homeExists = true;
    } catch {
      dirs = [];
      try {
        await fsp.access(this.options.home);
        this.homeExists = true;
      } catch {
        this.homeExists = false;
      }
    }
    const seen = new Set<string>();
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name === 'bin') continue;
      seen.add(dir.name);
      const dirPath = path.join(this.tmpDir, dir.name);
      let project = this.projects.get(dir.name);
      if (!project) {
        project = { root: null, rootMtime: -1, chatsMtime: -1 };
        this.projects.set(dir.name, project);
      }
      if (full || project.rootMtime < 0)
        await this.readProjectRoot(dirPath, project);
      const chats = path.join(dirPath, 'chats');
      let mtimeMs: number;
      try {
        mtimeMs = (await fsp.stat(chats)).mtimeMs;
      } catch {
        project.chatsMtime = -1;
        this.dropCandidates(dir.name, new Set());
        continue;
      }
      if (!full && project.chatsMtime === mtimeMs) continue;
      project.chatsMtime = mtimeMs;
      const present = new Set<string>();
      for (const entry of await readDir(chats)) {
        if (entry.isDirectory()) {
          // newer releases: subagents of session <name> in chats/<name>/
          if (full)
            await this.statSubagents(
              dir.name,
              path.join(chats, entry.name),
              entry.name
            );
          continue;
        }
        if (!entry.isFile() || !NAME_RE.test(entry.name)) continue;
        const file = path.join(chats, entry.name);
        present.add(file);
        if (full || !this.candidates.has(file)) await this.statCandidate(file);
      }
      this.dropCandidates(dir.name, present);
    }
    for (const [file, c] of this.candidates) {
      if (!seen.has(c.dir)) this.candidates.delete(file);
    }
    for (const name of this.projects.keys()) {
      if (!seen.has(name)) this.projects.delete(name);
    }
  }

  private dropCandidates(dir: string, present: Set<string>) {
    for (const [file, c] of this.candidates) {
      if (c.dir === dir && !present.has(file)) this.candidates.delete(file);
    }
  }

  private async statSubagents(dir: string, folder: string, parent: string) {
    for (const entry of await readDir(folder)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const { mtimeMs } = await fsp.stat(path.join(folder, entry.name));
        this.noteSubagent(dir, parent.slice(0, 8), mtimeMs);
      } catch {
        // removed meanwhile
      }
    }
  }

  private async readProjectRoot(dirPath: string, project: ProjectDir) {
    const file = path.join(dirPath, '.project_root');
    try {
      const { mtimeMs } = await fsp.stat(file);
      if (mtimeMs === project.rootMtime) return;
      project.rootMtime = mtimeMs;
      const root = (await fsp.readFile(file, 'utf8')).trim();
      project.root = root && path.isAbsolute(root) ? root : null;
    } catch {
      project.rootMtime = 0;
      project.root = null;
    }
    if (project.root) this.hashRoot.set(sha256(project.root), project.root);
  }

  /** `projects.json`: {"projects": {"/abs/root": "slug"}} */
  private async readProjectsJson() {
    const file = path.join(this.options.home, 'projects.json');
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(file)).mtimeMs;
    } catch {
      this.projectsJson = { mtimeMs: -1, slugRoot: new Map() };
      return;
    }
    if (mtimeMs === this.projectsJson.mtimeMs) return;
    const slugRoot = new Map<string, string>();
    try {
      const data: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
      const projects =
        data && typeof data === 'object'
          ? (data as { projects?: unknown }).projects
          : null;
      if (projects && typeof projects === 'object') {
        for (const [root, slug] of Object.entries(projects)) {
          if (typeof slug !== 'string' || !path.isAbsolute(root)) continue;
          slugRoot.set(slug, root);
          this.hashRoot.set(sha256(root), root);
        }
      }
    } catch {
      return; // being rewritten: next poll
    }
    this.projectsJson = { mtimeMs, slugRoot };
  }

  private async statCandidate(file: string) {
    const rel = path.relative(this.tmpDir, file).split(path.sep);
    const name = parseSessionName(rel[2] ?? '');
    if (rel.length !== 3 || rel[1] !== 'chats' || !name) return;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return;
      const prev = this.candidates.get(file);
      const c: Candidate = {
        path: file,
        dir: rel[0],
        ...name,
        mtimeMs: st.mtimeMs,
        size: st.size,
        kind: prev?.kind ?? null,
        kindAt: prev?.kindAt ?? -1,
      };
      if (c.kind === null && c.kindAt !== c.mtimeMs) {
        c.kindAt = c.mtimeMs;
        c.kind = await this.peekKind(c);
      }
      this.candidates.set(file, c);
      if (c.kind === 'subagent') this.noteSubagent(c.dir, c.id8, c.mtimeMs);
    } catch {
      this.candidates.delete(file);
    }
  }

  /**
   * A session file's kind without reading it all: the top-level `"kind"`
   * near the end of a 0.36 document, or in the first line of a JSONL file.
   */
  private async peekKind(c: Candidate): Promise<string | null> {
    try {
      if (c.format === 'json') {
        const tail = await readRange(
          c.path,
          Math.max(0, c.size - PEEK_BYTES),
          c.size
        );
        const matches = [
          ...tail.toString('utf8').matchAll(/\n {2}"kind": "([a-z_-]+)"/g),
        ];
        return matches.length ? matches[matches.length - 1][1] : null;
      }
      const head = (
        await readRange(c.path, 0, Math.min(c.size, PEEK_BYTES))
      ).toString('utf8');
      const nl = head.indexOf('\n');
      if (nl < 0) return null;
      const first: unknown = JSON.parse(head.slice(0, nl));
      const kind =
        first && typeof first === 'object'
          ? (first as { kind?: unknown }).kind
          : null;
      return typeof kind === 'string' ? kind : null;
    } catch {
      return null;
    }
  }

  /**
   * The sessions keys can show, most recent first: one file per name (old
   * hash folders are copied into slug folders, `.json` becomes `.jsonl` on
   * resume), subagent files left out.
   */
  private buildList() {
    const byBase = new Map<string, Candidate>();
    for (const c of this.candidates.values()) {
      if (c.kind === 'subagent') continue;
      const prev = byBase.get(c.base);
      if (
        !prev ||
        c.mtimeMs > prev.mtimeMs ||
        (c.mtimeMs === prev.mtimeMs &&
          (c.format === 'jsonl' || HASH_DIR_RE.test(prev.dir)))
      ) {
        byBase.set(c.base, c);
      }
    }
    this.list = [...byBase.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** One file per session id (the most recently written one). */
  private dedupeSessions() {
    const owner = new Map<string, { path: string; at: number }>();
    this.shadowed.clear();
    for (const c of this.list) {
      const facts = this.files.get(c.path)?.facts;
      const id = facts?.sessionId;
      if (!id) continue;
      const at = facts.lastActivity ?? c.mtimeMs;
      const prev = owner.get(id);
      if (!prev) owner.set(id, { path: c.path, at });
      else if (at > prev.at) {
        this.shadowed.add(prev.path);
        owner.set(id, { path: c.path, at });
      } else this.shadowed.add(c.path);
    }
  }

  /**
   * Which session file each running CLI writes. Per folder: a session
   * belongs to the CLI started last before the session's file was started
   * (named after that minute); each CLI writes the newest of its sessions
   * (older ones were left by /clear). A CLI without one has resumed an older
   * session if one was written since it started, else it has no file yet.
   * A best effort with several CLIs in one folder.
   */
  private mapInstances() {
    if (!this.instances) {
      this.live = null;
      return;
    }
    const byPath = new Map<string, GeminiInstance>();
    const fresh: GeminiInstance[] = [];
    const groups = new Map<string, GeminiInstance[]>();
    let partial = false;
    for (const instance of this.instances) {
      if (!instance.cwd) {
        partial = true;
        continue;
      }
      const key = samePathKey(instance.cwd, this.platform);
      groups.set(key, [...(groups.get(key) ?? []), instance]);
    }
    for (const [key, instances] of groups) {
      const cwd = instances[0].cwd as string;
      const hash = sha256(cwd);
      const sessions = this.list.filter(c => {
        const root = this.rootOf(c.dir);
        return (
          (root !== null && samePathKey(root, this.platform) === key) ||
          c.dir === hash
        );
      });
      instances.sort((a, b) => a.startedAt - b.startedAt);
      const owned = new Map<GeminiInstance, Candidate[]>();
      for (const s of sessions) {
        const born = s.bornAt ?? s.mtimeMs;
        let owner: GeminiInstance | null = null;
        for (const i of instances) {
          if (i.startedAt <= born + BORN_SLACK_MS) owner = i;
        }
        if (owner) owned.set(owner, [...(owned.get(owner) ?? []), s]);
      }
      const claimed = new Set<string>();
      const waiting: GeminiInstance[] = [];
      for (const i of instances) {
        const mine = (owned.get(i) ?? []).sort((a, b) => b.mtimeMs - a.mtimeMs);
        const current = mine.find(s => !claimed.has(s.path));
        if (current) {
          byPath.set(current.path, i);
          claimed.add(current.path);
        } else waiting.push(i);
      }
      // newest CLI first: a resumed session written since it started
      for (const i of waiting.sort((a, b) => b.startedAt - a.startedAt)) {
        const resumed = sessions.find(
          s => !claimed.has(s.path) && s.mtimeMs >= i.startedAt - 2_000
        );
        if (resumed) {
          byPath.set(resumed.path, i);
          claimed.add(resumed.path);
        } else fresh.push(i);
      }
    }
    this.live = { byPath, fresh, partial };
  }
}
