/**
 * Grok Bot session key.
 *
 * Each named bot in the local roster is one row. `awaitingUserResponse`
 * is Question. A recent `lastActivityAt` (or the newest transcript
 * timestamp, when the roster has none) is Done for the key's idle window.
 * The app process, from sand-session-marker.json plus a live pid whose name
 * mentions Grok, is Idle: open, with no evidence it is generating. Local
 * work in local-exec-daemon.json is Working, and it is not pinned to a bot.
 *
 * The agent itself runs on Grok Bot's remote computer. Nothing local says
 * that a particular bot is mid-reply, so this key does not invent a Working
 * state from a fresh transcript line.
 */
import fs from 'node:fs';
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

import { GROKBOT_BRAND } from './brand';
import {
  PERSISTENCE_DIR,
  grokbotAppCandidates,
  grokbotDataRoot,
  grokbotUserDataDir,
} from './paths';
import { PidAlive, pidIsGrokBot } from './sessionProcs';
import { GrokbotBot, GrokbotSnapshot, scanGrokbot } from './sessionScan';

const POLL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 300;
const DESCRIBE_IDLE_MS = 15 * 60_000;

type Item =
  | {
      kind: 'bot';
      id: string;
      name: string;
      awaiting: boolean;
      at: number | null;
    }
  | { kind: 'local'; count: number; at: number }
  | { kind: 'app'; at: number | null };

export type GrokbotSessionDeps = {
  pidAlive?: PidAlive;
  exists?: (file: string) => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
};

function idleMsOf(data: KeyData | undefined): number {
  const minutes = Number(data?.idleMinutes);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DESCRIBE_IDLE_MS;
}

function itemsOf(
  snapshot: GrokbotSnapshot,
  now: number,
  live: boolean
): Item[] {
  const items: Item[] = [];
  if (live && snapshot.inflight > 0) {
    items.push({ kind: 'local', count: snapshot.inflight, at: now });
  }
  for (const bot of snapshot.bots) {
    items.push({
      kind: 'bot',
      id: bot.id,
      name: bot.name,
      awaiting: bot.awaitingUser,
      at: bot.lastActivityAt,
    });
  }
  if (live && snapshot.appRunning) {
    items.push({ kind: 'app', at: snapshot.appSince });
  }
  return items;
}

function matches(filter: string, item: Item): boolean {
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return true;
  if (item.kind === 'bot') {
    return (
      item.name.toLowerCase().includes(wanted) ||
      item.id.toLowerCase().includes(wanted)
    );
  }
  if (item.kind === 'local') return 'local work'.includes(wanted);
  return 'grok bot'.includes(wanted);
}

function rank(item: Item): number {
  if (item.kind === 'bot' && item.awaiting) return 0;
  if (item.kind === 'local') return 1;
  if (item.kind === 'bot') return 2;
  return 3;
}

function statusOf(
  item: Item,
  now: number,
  idleMs: number,
  lang: 'en' | 'zh'
): SessionStatus | null {
  if (item.kind === 'local') {
    const detail =
      lang === 'zh'
        ? `${item.count} 个本地任务`
        : item.count === 1
          ? '1 local task'
          : `${item.count} local tasks`;
    return makeStatus({
      state: 'working',
      title: lang === 'zh' ? '本地任务' : 'Local work',
      detail,
      project: 'Grok Bot',
      sessionId: 'local-exec',
      lastActivity: item.at,
      since: item.at,
      live: true,
    });
  }
  if (item.kind === 'app') {
    return makeStatus({
      state: 'idle',
      title: 'Grok Bot',
      project: null,
      sessionId: 'app',
      lastActivity: item.at,
      since: item.at,
      live: true,
    });
  }
  if (item.awaiting) {
    return makeStatus({
      state: 'question',
      confident: true,
      title: item.name,
      question: lang === 'zh' ? '等待你的回复' : 'Waiting for you',
      project: item.name,
      sessionId: item.id,
      lastActivity: item.at,
      since: item.at,
      live: true,
    });
  }
  if (item.at === null || now - item.at > idleMs) return null;
  return makeStatus({
    state: 'done',
    title: item.name,
    project: item.name,
    sessionId: item.id,
    lastActivity: item.at,
    since: item.at,
  });
}

function visible(
  items: Item[],
  filter: string,
  now: number,
  idleMs: number,
  lang: 'en' | 'zh'
): { status: SessionStatus; at: number }[] {
  return items
    .filter(item => matches(filter, item))
    .map(item => ({ item, status: statusOf(item, now, idleMs, lang) }))
    .filter(
      (row): row is { item: Item; status: SessionStatus } => row.status !== null
    )
    .sort((a, b) => {
      const byRank = rank(a.item) - rank(b.item);
      if (byRank !== 0) return byRank;
      return (b.item.at ?? 0) - (a.item.at ?? 0);
    })
    .map(row => ({ status: row.status, at: row.item.at ?? 0 }));
}

class GrokbotSessionSource implements SessionSource {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;
  private snapshot: GrokbotSnapshot = {
    installed: false,
    appRunning: false,
    appSince: null,
    inflight: 0,
    bots: [],
  };
  private scanning: Promise<void> | null = null;

  constructor(
    private readonly options: SessionSourceOptions,
    private readonly deps: Required<
      Pick<
        GrokbotSessionDeps,
        'pidAlive' | 'exists' | 'platform' | 'env' | 'home' | 'now'
      >
    > & { userDataDir: string; dataRoot: string; appCandidates: string[] }
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

  /** One-off scans (the settings page) install a snapshot without watching. */
  applySnapshot(snapshot: GrokbotSnapshot): void {
    this.snapshot = snapshot;
  }

  getStatus(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): SessionPick {
    const rows = visible(
      itemsOf(this.snapshot, now, data?.liveDetection !== false),
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
      itemsOf(this.snapshot, now, data?.liveDetection !== false),
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
    return this.snapshot.installed
      ? null
      : unavailableNotice('not-installed', GROKBOT_BRAND);
  }

  productName(): string {
    return GROKBOT_BRAND.productName;
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
      const snapshot = await scanGrokbot({
        userDataDir: this.deps.userDataDir,
        dataRoot: this.deps.dataRoot,
        appCandidates: this.deps.appCandidates,
        exists: this.deps.exists,
        pidAlive: this.deps.pidAlive,
        checkPids: true,
      });
      // An explicit rescan still fills the snapshot while the source is
      // stopped. onChange is only for a source that is running.
      this.snapshot = snapshot;
    } catch (error) {
      this.options.logger?.warn?.(
        `Grok Bot session scan failed: ${safeErrorMessage(error)}`
      );
    }
    if (!this.stopped) this.options.onChange();
  }

  private watch(): void {
    for (const dir of [this.deps.userDataDir, this.deps.dataRoot]) {
      try {
        const watcher = fs.watch(dir, () => this.schedule());
        this.watchers.push(watcher);
      } catch {
        // the folder may not exist yet; the poll still runs
      }
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
  deps: GrokbotSessionDeps
) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? undefined;
  const platform = deps.platform ?? process.platform;
  const resolvedHome = home ?? undefined;
  return {
    userDataDir: grokbotUserDataDir(config, env, resolvedHome, platform),
    dataRoot: grokbotDataRoot(config, env, resolvedHome),
    appCandidates: grokbotAppCandidates(resolvedHome, platform, env),
  };
}

export function createGrokbotSessionProvider(
  deps: GrokbotSessionDeps = {}
): SessionProvider {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fs.existsSync;
  const pidAlive =
    deps.pidAlive ?? ((pid: number) => pidIsGrokBot(pid, platform));
  const now = deps.now ?? (() => Date.now());

  const places = (config: PluginConfig | null | undefined) =>
    layout(config, { ...deps, platform, env });

  return {
    location: config => places(config).userDataDir,
    watched: () => 'Grok Bot data',
    create(options: SessionSourceOptions): SessionSource {
      const where = places(options.config);
      return new GrokbotSessionSource(options, {
        pidAlive,
        exists,
        platform,
        env,
        home: deps.home ?? '',
        now,
        ...where,
      });
    },
    async describe(filter, config, data): Promise<SessionDescription> {
      const where = places(config);
      const snapshot = await scanGrokbot({
        ...where,
        exists,
        pidAlive,
        checkPids: data?.liveDetection !== false,
      });
      const source = new GrokbotSessionSource(
        {
          location: where.userDataDir,
          config,
          onChange() {},
        },
        {
          pidAlive,
          exists,
          platform,
          env,
          home: deps.home ?? '',
          now,
          ...where,
        }
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
        projectsDir: path.join(where.userDataDir, PERSISTENCE_DIR),
        state: status?.state ?? null,
        project: status?.project ?? null,
        title: status?.title ?? null,
        others,
        notice: status ? null : snapshot.installed ? null : source.notice(),
      };
    },
  };
}

export const sessionProvider: SessionProvider = createGrokbotSessionProvider();

export type { GrokbotBot };
