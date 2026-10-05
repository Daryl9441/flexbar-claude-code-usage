/**
 * The Session Status key: shows whether the latest Claude Code session is
 * working, done, or waiting for the user, kept live from the transcripts on
 * disk; a press lists all running sessions. Self-contained apart from a few
 * drawing hooks supplied by plugin.ts, and never touches the usage API.
 */
import { renderSessionKey, renderSessionList } from './sessionRender';
import { SessionMonitor, resolveClaudeDir } from './sessionSource';
import {
  LIST_TIMEOUT_MS,
  Lang,
  ListPager,
  SessionView,
  buildListView,
  buildSessionView,
  langOf,
  listPages,
} from './sessionView';

export const SESSION_CID = 'dev.sese.flexbar_claude_code_usage.session';

const DEFAULT_IDLE_MINUTES = 15;
/** Re-evaluates time-based transitions (permission guess, idle, clock) */
const TICK_MS = 5_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Key = any;

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type SessionKeyDeps = {
  /** Runs a draw after every draw queued before it */
  enqueue: (task: () => Promise<void>) => Promise<void>;
  /** Sends a rendered image to a key; may reject */
  send: (serialNumber: string, key: Key, image: string) => Promise<void>;
  isOffline: (serialNumber: string) => boolean;
  keyWidth: (key: Key) => number;
  bgColor: (key: Key) => string | undefined;
  loadConfig: () => Promise<{ claudeDir?: string } | null | undefined>;
  logger?: Logger | null;
};

type KeySettings = {
  filter: string;
  idleMs: number;
  showProject: boolean;
  showClawd: boolean;
  lang: Lang;
};

function settingsOf(key: Key): KeySettings {
  const data = key?.data ?? {};
  const idle = Number(data.idleMinutes);
  return {
    filter: typeof data.projectFilter === 'string' ? data.projectFilter : '',
    idleMs:
      (Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_MINUTES) *
      60_000,
    showProject: data.showProject !== false,
    showClawd: data.showClawd === true,
    lang: langOf(data.lang),
  };
}

function loadingView(lang: Lang): SessionView {
  return {
    tone: 'idle',
    label: 'Claude Code',
    text: lang === 'zh' ? '加载中…' : 'Loading…',
    time: '',
    project: null,
    progress: null,
    others: 0,
  };
}

export class SessionKeys {
  private keys = new Map<string, Key[]>();
  /** Signature of the image each key shows, by `${serialNumber}#${uid}` */
  private drawn = new Map<string, string>();
  /** Keys with a draw waiting in the queue (it renders the latest view) */
  private queued = new Set<string>();
  /** Keys showing the running-sessions list, by `${serialNumber}#${uid}` */
  private pager = new ListPager();
  private listTimers = new Map<string, NodeJS.Timeout>();
  private monitor: SessionMonitor | null = null;
  private ready = false;
  private claudeDir: string | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly deps: SessionKeyDeps) {}

  /** plugin.alive: the device's current plugin keys (any cid). */
  async alive(serialNumber: string, keys: Key[]) {
    const mine = keys.filter(key => key?.cid === SESSION_CID);
    if (mine.length > 0) this.keys.set(serialNumber, mine);
    else this.keys.delete(serialNumber);
    // the page was (re)loaded: repaint everything on it
    for (const id of [...this.drawn.keys()]) {
      if (id.startsWith(`${serialNumber}#`)) this.drawn.delete(id);
    }
    await this.sync();
  }

  /** plugin.dead: keys that left the device page (all when none listed). */
  async dead(serialNumber: string, keys: Key[]) {
    const dead = new Set(keys.map(key => key?.uid));
    const remaining =
      dead.size === 0
        ? []
        : (this.keys.get(serialNumber) ?? []).filter(k => !dead.has(k.uid));
    if (remaining.length > 0) this.keys.set(serialNumber, remaining);
    else this.keys.delete(serialNumber);
    await this.sync();
  }

  /**
   * Key press: show the running-sessions list, then its next page; a press
   * on the last page goes back to the normal view. Also rescans now.
   */
  async press(serialNumber: string, pressed: Key) {
    const keys = this.keys.get(serialNumber);
    const index = keys?.findIndex(key => key.uid === pressed.uid) ?? -1;
    if (keys && index >= 0) keys[index] = pressed;
    const id = `${serialNumber}#${pressed.uid}`;
    const now = Date.now();
    const page = this.pager.press(id, now, this.listPagesFor(pressed, now));
    // back to the normal view once the list times out
    clearTimeout(this.listTimers.get(id));
    this.listTimers.delete(id);
    if (page !== null) {
      this.listTimers.set(
        id,
        setTimeout(() => {
          this.listTimers.delete(id);
          this.redraw();
        }, LIST_TIMEOUT_MS + 50)
      );
    }
    this.redraw();
    await this.monitor?.rescan();
  }

  /** Global config changed: follow a different Claude config dir. */
  async configure(config: { claudeDir?: string } | null | undefined) {
    const dir = resolveClaudeDir(config?.claudeDir);
    if (!this.monitor || dir === this.claudeDir) return;
    this.stopMonitor();
    await this.sync();
  }

  /** For the key settings page: what a key with this filter would show. */
  async describe(filter: string) {
    const config = await this.deps.loadConfig().catch(() => null);
    const monitor = new SessionMonitor({
      claudeDir: resolveClaudeDir(config?.claudeDir),
      onChange: () => undefined,
    });
    monitor.setFilters([filter]);
    await monitor.rescan();
    monitor.stop();
    const { status, others } = monitor.getStatus(
      filter,
      Date.now(),
      DEFAULT_IDLE_MINUTES * 60_000
    );
    return {
      success: !!status,
      projectsDir: monitor.projectsDir,
      state: status?.state ?? null,
      project: status?.project ?? null,
      title: status?.title ?? null,
      others,
    };
  }

  private hasKeys(): boolean {
    for (const keys of this.keys.values()) if (keys.length > 0) return true;
    return false;
  }

  private async sync() {
    if (!this.hasKeys()) {
      this.stopMonitor();
      this.drawn.clear();
      this.pager.close();
      for (const timer of this.listTimers.values()) clearTimeout(timer);
      this.listTimers.clear();
      return;
    }
    await this.ensureMonitor();
    const settings = [...this.keys.values()].flatMap(keys =>
      keys.map(settingsOf)
    );
    this.monitor?.setFilters(settings.map(s => s.filter));
    this.monitor?.setRunningWindow(Math.max(...settings.map(s => s.idleMs)));
    this.redraw();
  }

  private async ensureMonitor() {
    if (this.monitor) return;
    if (!this.starting) {
      this.starting = (async () => {
        const config = await this.deps.loadConfig().catch(() => null);
        if (this.monitor || !this.hasKeys()) return;
        this.claudeDir = resolveClaudeDir(config?.claudeDir);
        this.ready = false;
        const monitor = new SessionMonitor({
          claudeDir: this.claudeDir,
          logger: this.deps.logger,
          onChange: () => {
            if (this.monitor !== monitor) return;
            this.ready = true;
            this.redraw();
          },
        });
        this.monitor = monitor;
        monitor.start();
        this.ticker = setInterval(() => this.redraw(), TICK_MS);
        this.deps.logger?.info?.(
          `Session keys: watching ${monitor.projectsDir}`
        );
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private stopMonitor() {
    this.monitor?.stop();
    this.monitor = null;
    this.ready = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Pages of the running-sessions list on this key now (at least 1). */
  private listPagesFor(key: Key, now: number): number {
    if (!this.monitor || !this.ready) return 1;
    const { filter, idleMs } = settingsOf(key);
    const count = this.monitor.listRunning(filter, now, idleMs).length;
    return listPages(count, this.deps.keyWidth(key));
  }

  /**
   * What a key shows now: the running-sessions list while it is open, else
   * the latest session. Equal signatures give equal images.
   */
  private viewFor(serialNumber: string, key: Key, now: number) {
    const settings = settingsOf(key);
    const id = `${serialNumber}#${key.uid}`;
    const width = this.deps.keyWidth(key);
    const bgColor = this.deps.bgColor(key);
    const page = this.pager.pageOf(id, now);

    if (page !== null && this.monitor && this.ready) {
      const list = buildListView(
        this.monitor.listRunning(settings.filter, now, settings.idleMs),
        { lang: settings.lang, width, page }
      );
      return {
        id,
        signature: JSON.stringify(['list', list, width, bgColor]),
        render: () => renderSessionList(width, list, { bgColor }),
      };
    }

    let view: SessionView;
    if (!this.monitor || !this.ready) {
      view = loadingView(settings.lang);
    } else {
      const { status, others } = this.monitor.getStatus(
        settings.filter,
        now,
        settings.idleMs
      );
      view = buildSessionView(status, {
        lang: settings.lang,
        showProject: settings.showProject,
        now,
        others,
      });
    }
    const options = { showClawd: settings.showClawd, bgColor };
    return {
      id,
      signature: JSON.stringify([view, width, options]),
      render: () => renderSessionKey(width, view, options),
    };
  }

  /** Queues a draw for every key whose image would change. */
  redraw() {
    const now = Date.now();
    for (const [serialNumber, keys] of this.keys) {
      for (const key of keys) {
        const { id, signature } = this.viewFor(serialNumber, key, now);
        if (this.drawn.get(id) === signature || this.queued.has(id)) continue;
        this.queued.add(id);
        void this.deps.enqueue(async () => {
          this.queued.delete(id);
          await this.draw(serialNumber, key.uid);
        });
      }
    }
  }

  private async draw(serialNumber: string, uid: unknown) {
    // look the key up again: it may have died or changed while queued
    const key = this.keys.get(serialNumber)?.find(k => k.uid === uid);
    if (!key || this.deps.isOffline(serialNumber)) return;
    const { id, signature, render } = this.viewFor(
      serialNumber,
      key,
      Date.now()
    );
    // recorded up front: a failed image is retried once the view changes
    // (at the latest when the clock ticks over), not every few seconds
    this.drawn.set(id, signature);
    try {
      await this.deps.send(serialNumber, key, await render());
    } catch (error) {
      const text = error instanceof Error ? error.message : `${error}`;
      this.deps.logger?.warn?.(
        `Could not draw session key ${uid}: ${text.slice(0, 200)}`
      );
    }
  }
}
