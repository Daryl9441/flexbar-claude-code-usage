/**
 * Follows Antigravity conversations (read-only) for the Session key, across
 * its three programs, which each keep their own conversations:
 *
 * - desktop app and IDE: their running language server answers
 *   `GetAllCascadeTrajectories` (./sessionRpc.ts) with every conversation's
 *   live status; while it does not run (or does not answer), its
 *   `conversation_summaries.db` (./sessionDb.ts) gives the last known state;
 * - agy CLI: its summary database, plus the running agy processes and their
 *   folders (./sessionProcs.ts) to tell a running CLI from a finished one.
 *
 * Cost: a 5 s tick stats a few files per data folder (summary database and
 * WAL, conversations/ and brain/); `ps` runs at most every 10 s (30 s when
 * agy is not installed), `lsof` once per new process; the RPC runs when those
 * files change, on a key press, and otherwise every 10 s while a
 * conversation is active (60 s when none is), never twice within 2 s; a
 * database is read only when it changed and its language server does not
 * answer. Nothing runs while nothing is installed. Never logs titles, ids,
 * paths of conversations or the CSRF token.
 */
import { promises as fsp } from 'node:fs';
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
import { makeStatus, unavailableNotice } from '../kit';
import {
  KeyData,
  Localized,
  Logger,
  SessionNotice,
  SessionPick,
  SessionSource,
} from '../types';

import { AntigravityProduct, DATA_FOLDERS } from './paths';
import { DbReader, SUMMARY_DB } from './sessionDb';
import { AgyProcess, ProcessProbe, ProcessSnapshot } from './sessionProcs';
import { decodeSummary } from './sessionProto';
import { PostFn, fetchTrajectories } from './sessionRpc';
import {
  ConversationFacts,
  Liveness,
  byRecency,
  deriveAgStatus,
  factsFromRow,
  factsFromSummary,
  isEngaged,
  needsUser,
  progressOfTask,
} from './sessionSummary';

const POLL_MS = 5_000;
/** ps while agy is installed (its sessions need the process list) */
const PROBE_CLI_MS = 10_000;
/** ps otherwise (finding the language servers) */
const PROBE_MS = 30_000;
/** …and a key press probes unless one ran this recently */
const PROBE_MIN_GAP_MS = 2_000;
const RPC_ACTIVE_MS = 10_000;
const RPC_IDLE_MS = 60_000;
const RPC_MIN_GAP_MS = 2_000;
/** A server's last answer stands in this long after a failed request */
const KEEP_FACTS_MS = 60_000;
/** Installed programs are looked for again this often */
const INSTALLED_MS = 30_000;
/** Conversations considered per key, besides the active ones */
const HOT_COUNT = 50;
const MAX_RUNNING = 36;
/** A CLI owns a conversation written since it started (ps: 1 s steps) */
const CLI_START_SLACK_MS = 60_000;
const TASK_MAX_BYTES = 256 * 1024;
/** task.md files no key showed for this long are forgotten */
const TASK_KEEP_MS = 60_000;
/** Sources keys asked for this recently are followed */
const WANTED_MS = 60_000;
/** Longest wait before a failing language server is asked again */
const RETRY_MAX_MS = 60_000;

const PRODUCTS: readonly AntigravityProduct[] = ['app', 'ide', 'cli'];

/** What a Session key follows (its `source` setting). */
export type AgSource = 'auto' | AntigravityProduct;

export function sourceOf(data: KeyData | null | undefined): AgSource {
  const value = data?.source;
  return value === 'app' || value === 'ide' || value === 'cli' ? value : 'auto';
}

/** The product named on a key's faces ("Start Antigravity IDE"). */
export const PRODUCT_NAMES: Readonly<Record<AgSource, string>> = {
  auto: 'Antigravity',
  app: 'Antigravity',
  ide: 'Antigravity IDE',
  cli: 'Antigravity CLI',
};

const NEW_SESSION: Localized = { en: 'New session', zh: '新会话' };

/** A language server rejected the request twice (signed out) */
export const SIGNED_OUT: SessionNotice = {
  label: { en: 'Signed out', zh: '未登录' },
  text: { en: 'Sign in to Antigravity', zh: '请登录 Antigravity' },
};

/**
 * A project filter or folder in one comparable spelling: lower case, runs of
 * anything but letters and digits as one "-", so "my_app", "my app" and
 * "My-App" all match "my-app".
 */
export function filterKey(text: string | null | undefined): string {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function basename(p: string | null): string | null {
  if (!p) return null;
  return p.split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function samePathKey(p: string, platform: NodeJS.Platform): string {
  let key = p.replace(/[\\/]+$/, '') || p;
  if (platform === 'darwin' || platform === 'win32') key = key.toLowerCase();
  return key;
}

/** Conversation ids become folder names under brain/: nothing else */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type FileStat = { mtimeMs: number; size: number } | null;

async function statOf(file: string): Promise<FileStat> {
  try {
    const st = await fsp.stat(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

async function readSmallText(
  file: string,
  max: number
): Promise<string | null> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(max);
      const { bytesRead } = await fh.read(buffer, 0, max, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

type RefreshMode = 'poll' | 'full';

export type AgMonitorOptions = {
  /** The folder holding the data folders (antigravityRoot()) */
  root: string;
  onChange: () => void;
  logger?: Logger | null;
  /** Running processes; null: none (summary databases only) */
  probe?: ProcessProbe | null;
  /** Loopback RPC transport; null: no RPC (summary databases only) */
  post?: PostFn | null;
  /** Summary database reader; null: none */
  readDb?: DbReader | null;
  /** The installed programs (data folder, app bundle or agy) */
  installed?: () => ReadonlySet<AntigravityProduct>;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Tests: file metadata (default fs.stat) */
  stat?: (file: string) => Promise<FileStat>;
  /** Tests: a small text file (default: its first bytes) */
  readText?: (file: string, maxBytes: number) => Promise<string | null>;
};

/** One conversation and how sure its state is. */
type Entry = { facts: ConversationFacts; liveness: Liveness };

type ServerState = {
  startedAt: number;
  port: number | null;
  lastCall: number;
  lastOk: number;
  /** Rejections (401/403) in a row */
  rejected: number;
  /** Failed calls in a row (backoff) */
  failures: number;
  /** When the current run of failures began */
  failingSince: number;
  /** Signals at the last call */
  signals: string;
  facts: ConversationFacts[] | null;
};

type DbState = { signature: string; facts: ConversationFacts[] };

type TaskState = {
  file: string;
  /** null: not read yet */
  signature: string | null;
  progress: SessionStatus['progress'];
  /** Last time a key showed its conversation */
  wantedAt: number;
};

/** Antigravity conversations as a SessionSource (one per provider, shared by its keys). */
export class AntigravitySessionMonitor implements SessionSource {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly stat: (file: string) => Promise<FileStat>;
  private readonly readText: (
    file: string,
    max: number
  ) => Promise<string | null>;
  private installed: ReadonlySet<AntigravityProduct> = new Set();
  private installedAt = -Infinity;
  private snapshot: ProcessSnapshot | null = null;
  private lastProbe = -Infinity;
  private needProbe = false;
  private servers = new Map<number, ServerState>();
  private dbs = new Map<AntigravityProduct, DbState>();
  private entries = new Map<AntigravityProduct, Entry[]>();
  /** Conversation id → the running agy that writes it */
  private cliOwner = new Map<string, AgyProcess>();
  /** Running agy CLIs without a conversation yet */
  private freshClis: AgyProcess[] = [];
  private signedOut = new Set<AntigravityProduct>();
  /** Signals of each product at the last refresh */
  private lastSignals = new Map<AntigravityProduct, string>();
  private tasks = new Map<string, TaskState>();
  /** Sources keys asked for (getStatus / listRunning), by when */
  private sourcesAsked = new Map<AgSource, number>();
  private taskRefresh: NodeJS.Immediate | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private queued: RefreshMode | null = null;
  private stopped = false;

  constructor(private readonly options: AgMonitorOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.stat = options.stat ?? statOf;
    this.readText = options.readText ?? readSmallText;
  }

  start() {
    this.stopped = false;
    this.pollTimer = setInterval(() => void this.refresh('poll'), POLL_MS);
    void this.refresh('full');
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.taskRefresh) clearImmediate(this.taskRefresh);
    this.taskRefresh = null;
  }

  rescan(): Promise<void> {
    return this.refresh('full');
  }

  setFilters() {
    // every conversation is kept in memory: filters only apply to queries
  }

  setRunningWindow() {
    // every conversation is kept in memory: nothing to widen
  }

  productName(data?: KeyData): string {
    return PRODUCT_NAMES[sourceOf(data)];
  }

  notice(data?: KeyData): SessionNotice | null {
    const products = productsOf(sourceOf(data));
    if (!products.some(p => this.installed.has(p))) {
      return unavailableNotice('not-installed', {
        productName: this.productName(data),
      });
    }
    if (products.some(p => this.signedOut.has(p))) return SIGNED_OUT;
    return null;
  }

  // --- queries -------------------------------------------------------------------

  getStatus(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): SessionPick {
    const source = this.noteSource(data);
    const lang = langOf(data?.lang);
    const all = this.matching(source, filterKey(filter));
    const considered = all.filter(
      (e, i) => i < HOT_COUNT || isEngaged(e.facts) || needsUser(e.facts)
    );
    const derived = considered.map(e => ({
      entry: e,
      status: this.statusOf(e, now, idleMs, lang),
    }));
    const { chosen, others } = pickSession(derived);
    if (chosen) {
      if (data?.showProgress !== false) {
        chosen.status.progress = this.progressFor(chosen.entry.facts);
      }
      return { status: chosen.status, others };
    }
    // an agy that has not recorded a conversation yet beats "No sessions"
    const fresh = this.freshMatching(source, filterKey(filter), lang);
    return { status: fresh[0] ?? null, others: 0 };
  }

  listRunning(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): RunningSession[] {
    const source = this.noteSource(data);
    const lang = langOf(data?.lang);
    const f = filterKey(filter);
    const list: RunningSession[] = [];
    for (const e of this.matching(source, f)) {
      const owned = this.cliOwner.has(e.facts.id) && e.facts.product === 'cli';
      const recent =
        e.facts.lastModified !== null && now - e.facts.lastModified <= idleMs;
      if (!owned && !recent && !isEngaged(e.facts) && !needsUser(e.facts)) {
        continue;
      }
      const status = this.statusOf(e, now, idleMs, lang);
      if (status.state === 'idle' && !owned) continue;
      list.push({
        status,
        group: runningGroup(status),
        at: status.lastActivity ?? 0,
      });
    }
    for (const status of this.freshMatching(source, f, lang)) {
      list.push({
        status,
        group: runningGroup(status),
        at: status.lastActivity ?? 0,
      });
    }
    return sortRunning(list).slice(0, MAX_RUNNING);
  }

  /** The key's source, remembered so the products it covers stay followed. */
  private noteSource(data: KeyData | undefined): AgSource {
    const source = sourceOf(data);
    this.sourcesAsked.set(source, this.now());
    return source;
  }

  /** Whether some key follows a product (all of them while no key asks). */
  private wanted(product: AntigravityProduct): boolean {
    const now = this.now();
    let asked = false;
    for (const [source, at] of this.sourcesAsked) {
      if (now - at > WANTED_MS) continue;
      asked = true;
      if (source === 'auto' || source === product) return true;
    }
    // no key asked lately (none drawn yet): follow everything
    return !asked;
  }

  private statusOf(
    e: Entry,
    now: number,
    idleMs: number,
    lang: 'en' | 'zh'
  ): SessionStatus {
    const status = deriveAgStatus(e.facts, {
      now,
      idleMs,
      liveness: e.liveness,
      lang,
    });
    status.project = basename(e.facts.workspace);
    if (e.facts.product === 'cli' && this.cliOwner.has(e.facts.id)) {
      status.live = true;
    }
    return status;
  }

  /** Visible conversations of a source matching a filter, most recent first. */
  private matching(source: AgSource, filter: string): Entry[] {
    const byId = new Map<string, Entry>();
    for (const product of productsOf(source)) {
      for (const e of this.entries.get(product) ?? []) {
        if (e.facts.hidden) continue;
        if (filter && !filterKey(e.facts.workspace).includes(filter)) continue;
        // the CLI can import an app conversation: one entry per id
        const prev = byId.get(e.facts.id);
        if (
          !prev ||
          (e.facts.lastModified ?? 0) > (prev.facts.lastModified ?? 0) ||
          ((e.facts.lastModified ?? 0) === (prev.facts.lastModified ?? 0) &&
            e.liveness === 'live')
        ) {
          byId.set(e.facts.id, e);
        }
      }
    }
    return [...byId.values()].sort((a, b) => byRecency(a.facts, b.facts));
  }

  private freshMatching(
    source: AgSource,
    filter: string,
    lang: 'en' | 'zh'
  ): SessionStatus[] {
    if (source !== 'auto' && source !== 'cli') return [];
    return this.freshClis
      .filter(c => c.cwd && (!filter || filterKey(c.cwd).includes(filter)))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(c =>
        makeStatus({
          state: 'idle',
          title: NEW_SESSION[lang],
          project: basename(c.cwd),
          lastActivity: c.startedAt,
          since: c.startedAt,
          live: true,
        })
      );
  }

  /** task.md progress of the conversation a key shows (read at the next refresh). */
  private progressFor(f: ConversationFacts): SessionStatus['progress'] {
    if (!SAFE_ID_RE.test(f.id)) return null;
    const key = `${f.product}/${f.id}`;
    const known = this.tasks.get(key);
    if (known) {
      known.wantedAt = this.now();
      return known.progress;
    }
    this.tasks.set(key, {
      file: path.join(
        this.options.root,
        DATA_FOLDERS[f.product],
        'brain',
        f.id,
        'task.md'
      ),
      signature: null,
      progress: null,
      wantedAt: this.now(),
    });
    // not read yet: soon, not at the next tick
    if (!this.taskRefresh && !this.stopped) {
      this.taskRefresh = setImmediate(() => {
        this.taskRefresh = null;
        void this.refresh('poll');
      });
    }
    return null;
  }

  // --- refresh -------------------------------------------------------------------

  private refresh(mode: RefreshMode): Promise<void> {
    if (this.running) {
      if (mode === 'full' || !this.queued) this.queued = mode;
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
          `Antigravity session scan failed: ${safeErrorMessage(error)}`
        );
      } finally {
        this.running = null;
        this.queued = null;
      }
      if (!this.stopped) this.options.onChange();
    })();
    return this.running;
  }

  private async doRefresh(mode: RefreshMode) {
    const now = this.now();
    if (mode === 'full' || now - this.installedAt >= INSTALLED_MS) {
      this.installedAt = now;
      try {
        this.installed = this.options.installed?.() ?? new Set(PRODUCTS);
      } catch {
        this.installed = new Set();
      }
    }
    if (this.installed.size === 0) {
      this.forgetAll();
      return;
    }

    await this.probe(mode, now);
    const signals = new Map<AntigravityProduct, string>();
    for (const product of PRODUCTS) {
      signals.set(product, await this.signalsOf(product));
    }
    for (const product of ['app', 'ide'] as const) {
      await this.refreshDesktop(product, mode, signals.get(product) ?? '');
    }
    await this.refreshCli();
    await this.readTasks();
  }

  private forgetAll() {
    this.snapshot = null;
    this.servers.clear();
    this.dbs.clear();
    this.entries.clear();
    this.cliOwner.clear();
    this.freshClis = [];
    this.signedOut.clear();
    this.lastSignals.clear();
    this.tasks.clear();
  }

  private async probe(mode: RefreshMode, now: number) {
    const probe = this.options.probe;
    if (!probe) {
      this.snapshot = null;
      return;
    }
    const every =
      this.installed.has('cli') && this.wanted('cli') ? PROBE_CLI_MS : PROBE_MS;
    const gap = mode === 'full' || this.needProbe ? PROBE_MIN_GAP_MS : every;
    if (now - this.lastProbe < gap) return;
    this.lastProbe = now;
    this.needProbe = false;
    try {
      this.snapshot = await probe.snapshot();
    } catch {
      this.snapshot = null;
    }
  }

  private dataDir(product: AntigravityProduct): string {
    return path.join(this.options.root, DATA_FOLDERS[product]);
  }

  /** mtimes and sizes of what changes when a conversation does. */
  private async signalsOf(product: AntigravityProduct): Promise<string> {
    if (!this.installed.has(product)) return '';
    const dir = this.dataDir(product);
    const db = path.join(dir, SUMMARY_DB);
    const parts: string[] = [];
    for (const file of [
      db,
      `${db}-wal`,
      path.join(dir, 'conversations'),
      path.join(dir, 'brain'),
    ]) {
      const st = await this.stat(file);
      parts.push(st ? `${st.mtimeMs}:${st.size}` : '-');
    }
    return parts.join('|');
  }

  /** The app's or the IDE's conversations: its language servers, else its database. */
  private async refreshDesktop(
    product: 'app' | 'ide',
    mode: RefreshMode,
    signals: string
  ) {
    const now = this.now();
    const servers = (this.snapshot?.servers ?? []).filter(
      s => s.product === product
    );
    const post = this.options.post;
    if (
      (!this.installed.has(product) && servers.length === 0) ||
      !this.wanted(product)
    ) {
      this.entries.delete(product);
      return;
    }
    // its files changed while no server of it is known: one just started
    const previous = this.lastSignals.get(product);
    this.lastSignals.set(product, signals);
    if (
      servers.length === 0 &&
      previous !== undefined &&
      previous !== signals
    ) {
      this.needProbe = true;
    }
    let live: ConversationFacts[] | null = null;
    let stale = false;
    let rejected = false;
    if (post) {
      for (const server of servers) {
        let state = this.servers.get(server.pid);
        if (!state || Math.abs(state.startedAt - server.startedAt) > 5_000) {
          state = {
            startedAt: server.startedAt,
            port: null,
            lastCall: -Infinity,
            lastOk: -Infinity,
            rejected: 0,
            failures: 0,
            failingSince: -Infinity,
            signals: '',
            facts: null,
          };
          this.servers.set(server.pid, state);
        }
        const since = now - state.lastCall;
        const active = (state.facts ?? []).some(
          f => !f.hidden && (isEngaged(f) || needsUser(f))
        );
        const due =
          state.lastCall === -Infinity ||
          (state.failures > 0
            ? since >=
              Math.min(RETRY_MAX_MS, POLL_MS * 2 ** (state.failures - 1))
            : since >= RPC_MIN_GAP_MS &&
              (mode === 'full' ||
                signals !== state.signals ||
                since >= (active ? RPC_ACTIVE_MS : RPC_IDLE_MS)));
        if (due) await this.callServer(server, state, signals, product);
        if (
          state.facts &&
          (state.failures === 0 ||
            this.now() - state.failingSince <= KEEP_FACTS_MS)
        ) {
          live = mergeById(live ?? [], state.facts);
          if (state.failures > 0) stale = true;
        }
        if (state.rejected >= 2) rejected = true;
      }
    }
    // forget servers that are gone
    const alive = new Set((this.snapshot?.servers ?? []).map(s => s.pid));
    if (this.snapshot) {
      for (const pid of [...this.servers.keys()]) {
        if (!alive.has(pid)) this.servers.delete(pid);
      }
    }
    if (rejected && !live) this.signedOut.add(product);
    else this.signedOut.delete(product);

    if (live && !stale) {
      this.entries.set(
        product,
        live.map(facts => ({ facts, liveness: 'live' as const }))
      );
      return;
    }
    // no answer: the last known state, from the summary database
    const fromDb = await this.dbFacts(product);
    const liveness: Liveness =
      servers.length > 0 || !this.snapshot ? 'unknown' : 'gone';
    const facts = live ? mergeById(fromDb, live) : fromDb;
    this.entries.set(
      product,
      facts.map(f => ({ facts: f, liveness }))
    );
  }

  private async callServer(
    server: ProcessSnapshot['servers'][number],
    state: ServerState,
    signals: string,
    product: 'app' | 'ide'
  ) {
    const post = this.options.post;
    if (!post) return;
    state.lastCall = this.now();
    state.signals = signals;
    const outcome = await fetchTrajectories(server, post, state.port);
    const name = product === 'app' ? 'app' : 'IDE';
    if (outcome.ok) {
      if (state.failures > 0) {
        this.options.logger?.info?.(
          `Antigravity sessions: the ${name}'s language server answers again`
        );
      }
      state.port = outcome.port;
      state.lastOk = this.now();
      state.rejected = 0;
      state.failures = 0;
      state.facts = Object.entries(outcome.summaries)
        .map(([id, summary]) => factsFromSummary(id, summary, product))
        .filter((f): f is ConversationFacts => f !== null);
      return;
    }
    if (state.failures === 0) {
      state.failingSince = this.now();
      this.options.logger?.warn?.(
        `Antigravity sessions: the ${name}'s language server did not answer (${outcome.reason}: ${outcome.detail})`
      );
    }
    state.failures++;
    state.port = null;
    if (outcome.reason === 'rejected') state.rejected++;
    // a new token or port after a restart: look the process up again
    this.options.probe?.forgetPorts(server.pid);
    this.needProbe = true;
  }

  /** A product's conversations from its summary database (re-read on change). */
  private async dbFacts(
    product: AntigravityProduct
  ): Promise<ConversationFacts[]> {
    const read = this.options.readDb;
    if (!read || !this.installed.has(product)) {
      this.dbs.delete(product);
      return [];
    }
    const file = path.join(this.dataDir(product), SUMMARY_DB);
    const db = await this.stat(file);
    if (!db) {
      this.dbs.delete(product);
      return [];
    }
    const wal = await this.stat(`${file}-wal`);
    const signature = `${db.mtimeMs}:${db.size}|${wal ? `${wal.mtimeMs}:${wal.size}` : '-'}`;
    const known = this.dbs.get(product);
    if (known && known.signature === signature) return known.facts;
    const rows = await read(file);
    if (!rows) return known?.facts ?? []; // being written: next time
    const facts = rows
      .map(row => {
        const blob = row.raw_summary;
        const decoded = blob instanceof Uint8Array ? decodeSummary(blob) : null;
        return factsFromRow(row, product, decoded);
      })
      .filter((f): f is ConversationFacts => f !== null);
    this.dbs.set(product, { signature, facts });
    return facts;
  }

  /** agy conversations, and which of them a running CLI writes. */
  private async refreshCli() {
    this.cliOwner.clear();
    this.freshClis = [];
    if (!this.installed.has('cli') || !this.wanted('cli')) {
      this.entries.delete('cli');
      return;
    }
    const facts = (await this.dbFacts('cli')).filter(f => !f.hidden);
    const clis = this.snapshot?.clis ?? null;
    if (!clis) {
      this.entries.set(
        'cli',
        facts.map(f => ({ facts: f, liveness: 'unknown' as const }))
      );
      return;
    }
    const partial = clis.some(c => !c.cwd);
    const claimed = new Set<string>();
    // newest CLI first: it writes the newest conversation of its folder
    for (const cli of [...clis].sort((a, b) => b.startedAt - a.startedAt)) {
      if (!cli.cwd) continue;
      const key = samePathKey(cli.cwd, this.platform);
      const mine = facts
        .filter(
          f =>
            !claimed.has(f.id) &&
            f.workspace !== null &&
            samePathKey(f.workspace, this.platform) === key &&
            (f.lastModified ?? 0) >= cli.startedAt - CLI_START_SLACK_MS
        )
        .sort(byRecency)[0];
      if (mine) {
        claimed.add(mine.id);
        this.cliOwner.set(mine.id, cli);
      } else {
        this.freshClis.push(cli);
      }
    }
    this.entries.set(
      'cli',
      facts.map(f => ({
        facts: f,
        liveness: claimed.has(f.id) ? 'live' : partial ? 'unknown' : 'gone',
      }))
    );
  }

  /** task.md of the conversations keys show (stat; read on change). */
  private async readTasks() {
    const now = this.now();
    for (const [key, task] of [...this.tasks]) {
      if (now - task.wantedAt > TASK_KEEP_MS) {
        this.tasks.delete(key);
        continue;
      }
      const st = await this.stat(task.file);
      const signature = st ? `${st.mtimeMs}:${st.size}` : '-';
      if (task.signature === signature) continue;
      const text = st ? await this.readText(task.file, TASK_MAX_BYTES) : null;
      task.signature = signature;
      task.progress = text ? progressOfTask(text) : null;
    }
  }
}

function productsOf(source: AgSource): readonly AntigravityProduct[] {
  return source === 'auto' ? PRODUCTS : [source];
}

/** Two lists of one product's conversations, the newer of each id kept. */
function mergeById(
  a: ConversationFacts[],
  b: ConversationFacts[]
): ConversationFacts[] {
  const byId = new Map<string, ConversationFacts>();
  for (const f of [...a, ...b]) {
    const prev = byId.get(f.id);
    if (!prev || (f.lastModified ?? 0) >= (prev.lastModified ?? 0)) {
      byId.set(f.id, f);
    }
  }
  return [...byId.values()];
}
