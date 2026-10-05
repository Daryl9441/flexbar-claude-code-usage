/**
 * The Kimi session source shared by all Kimi Session Status keys: Kimi Code
 * CLI sessions (sessionCli.ts) and Kimi desktop "Kimi Work" tasks
 * (sessionDesktop.ts), merged. Read-only.
 *
 * Kept current like Claude's SessionMonitor: fs.watch on the session
 * folders and the desktop stores (debounced), a 5 s poll that re-stats the
 * small files and the hot journals, and an occasional full rescan. Each key
 * picks its sources and filters at query time (its settings arrive as
 * `data`), so one source serves every key.
 */
import { FSWatcher, watch } from 'node:fs';
import path from 'node:path';

import {
  ATTENTION_STATES,
  RunningSession,
  SessionStatus,
  pickSession,
  sortRunning,
} from '../../session';
import { runningItem, unavailableNotice } from '../kit';
import {
  KeyData,
  Logger,
  SessionNotice,
  SessionPick,
  SessionSource,
} from '../types';

import { KIMI_BRAND } from './brand';
import { CliCandidate, CliSessions } from './sessionCli';
import { DesktopCandidate, DesktopSessions } from './sessionDesktop';
import { matchesFilter } from './sessionFs';

const POLL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 300;
const FULL_SCAN_MS = 5 * 60_000;
const FULL_SCAN_UNWATCHED_MS = 30_000;
/** Most recent sessions per filter that are followed and considered */
const HOT_COUNT = 6;
/** Most sessions per filter the running list follows */
const MAX_RUNNING = 36;

export type KimiSourceKind = 'auto' | 'desktop' | 'cli';

/** A key's provider options from its settings (key.data). */
export function keyOptions(data?: KeyData | null): {
  source: KimiSourceKind;
  automations: boolean;
} {
  const source = data?.source;
  return {
    source: source === 'desktop' || source === 'cli' ? source : 'auto',
    automations: data?.includeAutomations === true,
  };
}

/** Not installed, Kimi Work never opened: shown when nothing is found. */
const NOT_SET_UP: SessionNotice = {
  label: { en: 'Not set up', zh: '未设置' },
  text: { en: 'Open Kimi Work', zh: '请打开 Kimi Work' },
};

type RefreshMode = 'watch' | 'poll' | 'full';
const RANK: Record<RefreshMode, number> = { watch: 0, poll: 1, full: 2 };

type Entry = {
  id: string;
  at: number;
  /** Considered however old it is (followed live, or an unread result) */
  followed: boolean;
  status: (now: number, idleMs: number) => SessionStatus;
};

export type KimiSourceOptions = {
  /** Kimi Code home (./paths.ts kimiCodeHome) */
  codeHome: string;
  /** Kimi desktop data folder (./paths.ts kimiDesktopDir) */
  desktopDir: string;
  onChange: () => void;
  logger?: Logger | null;
};

export class KimiSessionSource implements SessionSource {
  readonly cli: CliSessions;
  readonly desktop: DesktopSessions;
  private filters: string[] = [''];
  private runningWindowMs = 0;
  private watchers = new Map<string, FSWatcher>();
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pending: RefreshMode | null = null;
  private running: Promise<void> | null = null;
  private queued: RefreshMode | null = null;
  private lastFullScan = 0;
  private stopped = false;
  private found: { cli: boolean; desktop: boolean; used: boolean } | null =
    null;
  private warnedSqlite = false;

  constructor(private readonly options: KimiSourceOptions) {
    this.cli = new CliSessions(options.codeHome);
    this.desktop = new DesktopSessions(options.desktopDir);
  }

  start() {
    this.stopped = false;
    this.pollTimer = setInterval(() => void this.refresh('poll'), POLL_MS);
    this.ensureWatch();
    void this.refresh('full');
  }

  stop() {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
  }

  rescan(): Promise<void> {
    return this.refresh('full');
  }

  setFilters(filters: string[]) {
    const next = [...new Set(filters.map(f => f.trim().toLowerCase()))].sort();
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

  getStatus(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): SessionPick {
    const list = this.entries(filter, now, data);
    const derived: { status: SessionStatus }[] = list
      .slice(0, HOT_COUNT)
      .map(e => ({ status: e.status(now, idleMs) }));
    // older sessions count when they wait for the user
    for (const e of list.slice(HOT_COUNT)) {
      if (!e.followed) continue;
      const status = e.status(now, idleMs);
      if (ATTENTION_STATES.has(status.state)) derived.push({ status });
    }
    const { chosen, others } = pickSession(derived);
    return { status: chosen?.status ?? null, others };
  }

  listRunning(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): RunningSession[] {
    const out: RunningSession[] = [];
    for (const e of this.entries(filter, now, data)) {
      if (!e.followed && now - e.at > idleMs) continue;
      const status = e.status(now, idleMs);
      if (status.state === 'idle') continue;
      out.push(
        runningItem({
          title: status.title,
          status,
          at: status.lastActivity ?? e.at,
        })
      );
    }
    return sortRunning(out).slice(0, MAX_RUNNING);
  }

  notice(): SessionNotice | null {
    const found = this.found;
    if (!found) return null;
    if (!found.cli && !found.desktop) {
      return unavailableNotice('not-installed', KIMI_BRAND);
    }
    if (!found.cli && !found.used) return NOT_SET_UP;
    return null;
  }

  /** Sessions a key with this filter and settings considers, newest first. */
  private entries(filter: string, now: number, data?: KeyData): Entry[] {
    const { source, automations } = keyOptions(data);
    const out: Entry[] = [];
    if (source !== 'desktop') {
      for (const c of this.cli.candidates.values()) {
        if (!this.cli.visible(c)) continue;
        if (!matchesFilter(filter, this.cli.filterTexts(c))) continue;
        out.push(this.cliEntry(c));
      }
    }
    if (source !== 'cli') {
      for (const c of this.desktop.candidates(now)) {
        if (c.automation && !automations) continue;
        if (!matchesFilter(filter, c.filterTexts)) continue;
        out.push(this.desktopEntry(c, now));
      }
    }
    return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }

  private cliEntry(c: CliCandidate): Entry {
    return {
      id: c.dir,
      at: c.mtimeMs,
      followed: this.cli.isHot(c),
      status: (now, idleMs) => this.cli.status(c, now, idleMs),
    };
  }

  private desktopEntry(c: DesktopCandidate, now: number): Entry {
    return {
      id: c.key,
      at: c.at ?? 0,
      // unread results stay listed until seen (see DesktopSessions.status)
      followed: this.desktop.isActive(c, now) || c.unread,
      status: (at, idleMs) => this.desktop.status(c, at, idleMs),
    };
  }

  // --- refresh -----------------------------------------------------------------

  /**
   * Brings everything up to date: "watch" re-reads the stores and the hot
   * journals, "poll" also looks for new sessions, "full" re-lists all.
   */
  private refresh(mode: RefreshMode): Promise<void> {
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
        const code = (error as NodeJS.ErrnoException)?.code;
        // never the error message: it may name a session folder
        this.options.logger?.warn?.(
          `Kimi session scan failed${typeof code === 'string' ? ` (${code})` : ''}`
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
    this.ensureWatch();
    await this.desktop.readStores();
    if (mode === 'watch') {
      await this.desktop.syncDirty();
    } else {
      const now = Date.now();
      const every = this.watchers.size ? FULL_SCAN_MS : FULL_SCAN_UNWATCHED_MS;
      const full = mode === 'full' || now - this.lastFullScan > every;
      if (full) this.lastFullScan = now;
      await this.cli.scan(full);
      await this.desktop.scanKernel(full);
      if (full || !this.found) {
        this.found = {
          cli: await this.cli.installed(),
          desktop: await this.desktop.installed(),
          used: await this.desktop.used(),
        };
      }
    }
    await this.cli.syncDirty();
    const { cli, desktop } = this.hotSets(Date.now());
    await this.cli.sync(cli);
    await this.desktop.sync(desktop);
    if (this.desktop.sqliteOk === false && !this.warnedSqlite) {
      this.warnedSqlite = true;
      this.options.logger?.info?.(
        'Kimi sessions: task titles from the kernel (sqlite index not readable)'
      );
    }
  }

  /**
   * What is followed: per filter the most recent sessions, those inside the
   * running window, and desktop tasks the app or daemon reports as active.
   */
  private hotSets(now: number) {
    const window = this.runningWindowMs;
    const cliAll = [...this.cli.candidates.values()]
      .filter(c => this.cli.visible(c))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const deskAll = this.desktop
      .candidates(now)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const cli = new Set<string>();
    const desktop = new Set<string>();
    for (const filter of this.filters) {
      const c = cliAll.filter(x =>
        matchesFilter(filter, this.cli.filterTexts(x))
      );
      for (const x of c.slice(0, HOT_COUNT)) cli.add(x.dir);
      for (const x of c
        .filter(y => now - y.mtimeMs <= window)
        .slice(0, MAX_RUNNING)) {
        cli.add(x.dir);
      }
      const d = deskAll.filter(x => matchesFilter(filter, x.filterTexts));
      for (const x of d.slice(0, HOT_COUNT)) desktop.add(x.key);
      for (const x of d.filter(y => !y.automation).slice(0, HOT_COUNT)) {
        desktop.add(x.key);
      }
      for (const x of d
        .filter(
          y =>
            this.desktop.isActive(y, now) ||
            (y.at !== null && now - y.at <= window)
        )
        .slice(0, MAX_RUNNING)) {
        desktop.add(x.key);
      }
    }
    return { cli, desktop };
  }

  // --- watching ----------------------------------------------------------------

  private ensureWatch() {
    // one-off scans (never started) need no watchers
    if (this.stopped || !this.pollTimer) return;
    this.watchDir(this.cli.sessionsDir, true, name => this.onCliWatch(name));
    this.watchDir(this.desktop.agentDir, false, name =>
      name === null || name.startsWith('conversation-') ? 'watch' : null
    );
    this.watchDir(this.desktop.runnerDir, false, name =>
      name === null || name === 'runner.state.json' ? 'watch' : null
    );
    this.watchDir(this.desktop.kernelDir, true, name =>
      this.onKernelWatch(name)
    );
  }

  private watchDir(
    dir: string,
    recursive: boolean,
    classify: (name: string | null) => RefreshMode | null
  ) {
    if (this.watchers.has(dir)) return;
    try {
      const watcher = watch(
        dir,
        { recursive, persistent: false },
        (_event, filename) => {
          const mode = classify(filename?.toString() ?? null);
          if (mode) this.schedule(mode);
        }
      );
      watcher.on('error', () => {
        watcher.close();
        if (this.watchers.get(dir) === watcher) this.watchers.delete(dir);
      });
      this.watchers.set(dir, watcher);
    } catch {
      // not there yet, or no recursive watch here: the poll covers it
    }
  }

  /** sessions/<wd>/<session>/{state.json, agents/…/wire.jsonl} */
  private onCliWatch(name: string | null): RefreshMode | null {
    if (name === null) return 'poll';
    const parts = name.split(/[\\/]/);
    if (parts.length <= 2) return 'poll'; // a session dir came or went
    if (parts[2] !== 'state.json' && parts[2] !== 'agents') return null;
    this.cli.dirty.add(path.join(this.cli.sessionsDir, parts[0], parts[1]));
    return 'watch';
  }

  private onKernelWatch(name: string | null): RefreshMode | null {
    if (name === null) return 'poll';
    const parts = name.split(/[\\/]/);
    if (parts.length <= 2) return 'poll';
    if (parts[2] !== 'state.json' && parts[2] !== 'agents') return null;
    this.desktop.dirty.add(
      path.join(this.desktop.kernelDir, parts[0], parts[1])
    );
    return 'watch';
  }

  private schedule(mode: RefreshMode) {
    if (!this.pending || RANK[mode] > RANK[this.pending]) this.pending = mode;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const next = this.pending ?? 'watch';
      this.pending = null;
      void this.refresh(next);
    }, WATCH_DEBOUNCE_MS);
  }
}
