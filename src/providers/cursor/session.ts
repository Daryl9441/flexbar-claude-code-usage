/**
 * Cursor session key.
 *
 * Each top-level composer is one row. A composer Cursor marks as waiting
 * for the user is Question. One it marks as generating is Working. A recent
 * `lastUpdatedAt` is Done for the key's idle window. There is no
 * session-marker file, so an open Cursor window is not shown as Idle and a
 * chat is never marked Working from message text.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeErrorMessage } from '../../redact';
import { RunningSession, sortRunning } from '../../session';
import { langOf } from '../../sessionView';
import { makeStatus, runningItem, unavailableNotice } from '../kit';
import {
  KeyData,
  PluginConfig,
  SessionDescription,
  SessionNotice,
  SessionPick,
  SessionProvider,
  SessionSource,
  SessionSourceOptions,
  SessionStatus,
} from '../types';

import { CURSOR_BRAND } from './brand';
import { cursorAppCandidates, cursorStateDb, cursorUserDataDir } from './paths';
import { CursorComposer, CursorSnapshot, scanCursor } from './sessionScan';

const POLL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 300;
const DESCRIBE_IDLE_MS = 15 * 60_000;

const UNREADABLE: SessionNotice = {
  label: { en: 'Cannot read chats', zh: '无法读取会话' },
  text: { en: 'Cursor state unreadable', zh: '读不到 Cursor 状态' },
  tone: 'error',
};

export type CursorSessionDeps = {
  exists?: (file: string) => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  readRows?: (databasePath: string) => Promise<unknown[]>;
  /** Agent CLI meta reader. When readRows is stubbed and this is not, CLI scan is off. */
  readCliRows?: (chatsDir: string) => Promise<unknown[]>;
  listProcesses?: () => Promise<string>;
};

function idleMsOf(data: KeyData | undefined): number {
  const minutes = Number(data?.idleMinutes);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DESCRIBE_IDLE_MS;
}

function matches(filter: string, composer: CursorComposer): boolean {
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return true;
  return (
    composer.name.toLowerCase().includes(wanted) ||
    composer.id.toLowerCase().includes(wanted) ||
    (composer.project ?? '').toLowerCase().includes(wanted)
  );
}

function rank(composer: CursorComposer): number {
  if (composer.awaiting) return 0;
  if (composer.generating) return 1;
  return 2;
}

function modeDetail(mode: string | null, lang: 'en' | 'zh'): string | null {
  if (mode === 'agent') return 'Agent';
  if (mode === 'chat') return lang === 'zh' ? '对话' : 'Chat';
  if (mode === 'plan') return lang === 'zh' ? '计划' : 'Plan';
  if (mode === 'edit') return lang === 'zh' ? '编辑' : 'Edit';
  if (mode === 'background') return lang === 'zh' ? '后台' : 'Background';
  return null;
}

function statusOf(
  composer: CursorComposer,
  now: number,
  idleMs: number,
  lang: 'en' | 'zh'
): SessionStatus | null {
  const detail = modeDetail(composer.mode, lang);
  const base = {
    title: composer.name,
    detail,
    project: composer.project,
    sessionId: composer.id,
    lastActivity: composer.at || null,
    since: composer.at || null,
  };
  if (composer.awaiting) {
    return makeStatus({
      ...base,
      state: 'question',
      confident: true,
      question: lang === 'zh' ? '等待你的回复' : 'Waiting for you',
      live: true,
    });
  }
  if (composer.generating) {
    return makeStatus({ ...base, state: 'working', live: true });
  }
  if (composer.at <= 0 || now - composer.at > idleMs) return null;
  return makeStatus({ ...base, state: 'done' });
}

function visible(
  composers: CursorComposer[],
  filter: string,
  now: number,
  idleMs: number,
  lang: 'en' | 'zh'
): { status: SessionStatus; at: number }[] {
  return composers
    .filter(composer => matches(filter, composer))
    .map(composer => ({
      composer,
      status: statusOf(composer, now, idleMs, lang),
    }))
    .filter(
      (row): row is { composer: CursorComposer; status: SessionStatus } =>
        row.status !== null
    )
    .sort((a, b) => {
      const byRank = rank(a.composer) - rank(b.composer);
      if (byRank !== 0) return byRank;
      return b.composer.at - a.composer.at;
    })
    .map(row => ({ status: row.status, at: row.composer.at }));
}

class CursorSessionSource implements SessionSource {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
  private snapshot: CursorSnapshot = {
    installed: false,
    unreadable: false,
    composers: [],
  };
  private scanning: Promise<void> | null = null;

  constructor(
    private readonly options: SessionSourceOptions,
    private readonly deps: {
      databasePath: string;
      userDataDir: string;
      appCandidates: string[];
      exists: (file: string) => boolean;
      readRows?: (databasePath: string) => Promise<unknown[]>;
      cliChatsDir?: string;
      readCliRows?: (chatsDir: string) => Promise<unknown[]>;
      listProcesses?: () => Promise<string>;
      now: () => number;
    }
  ) {}

  start(): void {
    this.stopped = false;
    this.watch();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  rescan(): Promise<void> {
    return this.tick();
  }

  setFilters(): void {}

  setRunningWindow(): void {}

  applySnapshot(snapshot: CursorSnapshot): void {
    this.snapshot = snapshot;
  }

  getStatus(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): SessionPick {
    const rows = visible(
      this.snapshot.composers,
      filter,
      now,
      idleMs,
      langOf(data?.lang)
    );
    const chosen =
      rows.find(row => row.status.state === 'question') ?? rows[0] ?? null;
    const others = rows.filter(
      row =>
        row !== chosen &&
        (row.status.state === 'working' || row.status.state === 'question')
    ).length;
    return { status: chosen?.status ?? null, others };
  }

  listRunning(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): RunningSession[] {
    const rows = visible(
      this.snapshot.composers,
      filter,
      now,
      idleMs,
      langOf(data?.lang)
    );
    return sortRunning(
      rows.map(row =>
        runningItem({
          title: row.status.title,
          status: row.status,
          at: row.at,
        })
      )
    );
  }

  notice(): SessionNotice | null {
    if (!this.snapshot.installed) {
      return unavailableNotice('not-installed', CURSOR_BRAND);
    }
    return this.snapshot.unreadable ? UNREADABLE : null;
  }

  productName(): string {
    return CURSOR_BRAND.productName;
  }

  private async tick(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.read().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async read(): Promise<void> {
    try {
      this.snapshot = await scanCursor({
        databasePath: this.deps.databasePath,
        userDataDir: this.deps.userDataDir,
        appCandidates: this.deps.appCandidates,
        exists: this.deps.exists,
        readRows: this.deps.readRows,
        cliChatsDir: this.deps.cliChatsDir,
        readCliRows: this.deps.readCliRows,
        listProcesses: this.deps.listProcesses,
      });
    } catch (error) {
      this.options.logger?.warn?.(
        `Cursor session scan failed: ${safeErrorMessage(error)}`
      );
    }
    if (!this.stopped) this.options.onChange();
  }

  private watch(): void {
    const dir = path.dirname(this.deps.databasePath);
    try {
      const watcher = fs.watch(dir, () => this.schedule());
      this.watchers.push(watcher);
    } catch {
      // the folder may not exist yet; the poll still runs
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => void this.tick(), WATCH_DEBOUNCE_MS);
  }
}

function layout(
  config: PluginConfig | null | undefined,
  deps: CursorSessionDeps
) {
  const env = deps.env ?? process.env;
  const home = deps.home;
  const platform = deps.platform ?? process.platform;
  return {
    databasePath: cursorStateDb(config, env, home, platform),
    userDataDir: cursorUserDataDir(config, env, home, platform),
    appCandidates: cursorAppCandidates(home, platform, env),
    cliChatsDir:
      deps.readRows && !deps.readCliRows
        ? undefined
        : path.join(home ?? os.homedir(), '.cursor', 'chats'),
  };
}

export function createCursorSessionProvider(
  deps: CursorSessionDeps = {}
): SessionProvider {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fs.existsSync;
  const now = deps.now ?? (() => Date.now());
  const places = (config: PluginConfig | null | undefined) =>
    layout(config, { ...deps, platform, env });

  return {
    location: config => places(config).databasePath,
    watched: () => 'Cursor state database',
    create(options: SessionSourceOptions): SessionSource {
      const where = places(options.config);
      return new CursorSessionSource(options, {
        ...where,
        exists,
        readRows: deps.readRows,
        readCliRows: deps.readCliRows,
        listProcesses: deps.listProcesses,
        now,
      });
    },
    async describe(filter, config, data): Promise<SessionDescription> {
      const where = places(config);
      const snapshot = await scanCursor({
        ...where,
        exists,
        readRows: deps.readRows,
        readCliRows: deps.readCliRows,
        listProcesses: deps.listProcesses,
      });
      const source = new CursorSessionSource(
        { location: where.databasePath, config, onChange() {} },
        { ...where, exists, readRows: deps.readRows,
        readCliRows: deps.readCliRows,
        listProcesses: deps.listProcesses, now }
      );
      source.applySnapshot(snapshot);
      const { status, others } = source.getStatus(
        filter,
        now(),
        idleMsOf(data),
        data
      );
      return {
        success: !!status,
        projectsDir: where.databasePath,
        state: status?.state ?? null,
        project: status?.project ?? null,
        title: status?.title ?? null,
        others,
        notice: status ? null : source.notice(),
      };
    },
  };
}

export const sessionProvider: SessionProvider = createCursorSessionProvider();
