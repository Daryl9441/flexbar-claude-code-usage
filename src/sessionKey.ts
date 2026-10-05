/**
 * Session Status keys of one provider: show whether the provider's latest
 * session is working, done, or waiting for the user, kept live by the
 * provider's SessionSource; a press lists all running sessions. Generic over
 * the provider (src/providers/types.ts, Claude Code by default) apart from a
 * few drawing hooks supplied by plugin.ts; never touches the usage API.
 */
import { CLAUDE_BRAND } from './providers/claude/brand';
import { claudeSessionProvider } from './providers/claude/session';
import { keyCid, markOptions, staticSessionSource } from './providers/kit';
import {
  Brand,
  Key,
  KeyData,
  KeyGroup,
  KeyHost,
  PluginConfig,
  SessionDescription,
  SessionNotice,
  SessionPick,
  SessionProvider,
  SessionSource,
  UiMessage,
} from './providers/types';
import { renderSessionKey, renderSessionList } from './sessionRender';
import {
  LIST_TIMEOUT_MS,
  Lang,
  ListPager,
  SessionView,
  buildListView,
  buildNoticeView,
  buildSessionView,
  langOf,
  listPages,
} from './sessionView';

export const SESSION_CID = keyCid('claude', 'session');

const DEFAULT_IDLE_MINUTES = 15;
/** Re-evaluates time-based transitions (permission guess, idle, clock) */
const TICK_MS = 5_000;

export type SessionKeyProvider = {
  cid: string;
  brand: Brand;
  sessions: SessionProvider;
};

/** The original Session Status key: Claude Code sessions. */
export const CLAUDE_SESSION_KEYS: SessionKeyProvider = {
  cid: SESSION_CID,
  brand: CLAUDE_BRAND,
  sessions: claudeSessionProvider,
};

export type SessionKeyDeps = KeyHost & {
  /** Whose sessions the keys show (default: Claude Code) */
  provider?: SessionKeyProvider;
};

type KeySettings = {
  filter: string;
  idleMs: number;
  showProject: boolean;
  marks: ReturnType<typeof markOptions>;
  lang: Lang;
};

function settingsOf(key: Key, brand: Brand): KeySettings {
  const data = key?.data ?? {};
  const idle = Number(data.idleMinutes);
  return {
    filter: typeof data.projectFilter === 'string' ? data.projectFilter : '',
    idleMs:
      (Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_MINUTES) *
      60_000,
    showProject: data.showProject !== false,
    marks: markOptions(brand, data),
    lang: langOf(data.lang),
  };
}

function loadingView(lang: Lang, productName: string): SessionView {
  return {
    tone: 'idle',
    label: productName,
    text: lang === 'zh' ? '加载中…' : 'Loading…',
    time: '',
    project: null,
    progress: null,
    others: 0,
  };
}

/** The source failed: red like a session in the error state */
const BROKEN: SessionNotice = {
  label: { en: 'Error', zh: '出错' },
  text: { en: 'Could not read sessions', zh: '无法读取会话' },
  tone: 'error',
};

export class SessionKeys implements KeyGroup {
  readonly cid: string;
  private keys = new Map<string, Key[]>();
  /** Signature of the image each key shows, by `${serialNumber}#${uid}` */
  private drawn = new Map<string, string>();
  /** Keys with a draw waiting in the queue (it renders the latest view) */
  private queued = new Set<string>();
  /** Keys showing the running-sessions list, by `${serialNumber}#${uid}` */
  private pager = new ListPager();
  private listTimers = new Map<string, NodeJS.Timeout>();
  private monitor: SessionSource | null = null;
  private ready = false;
  private location: string | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private readonly provider: SessionKeyProvider;

  constructor(private readonly deps: SessionKeyDeps) {
    this.provider = deps.provider ?? CLAUDE_SESSION_KEYS;
    this.cid = this.provider.cid;
  }

  private get brand(): Brand {
    return this.provider.brand;
  }

  /** plugin.alive: the device's current plugin keys (any cid). */
  async alive(serialNumber: string, keys: Key[]) {
    const mine = keys.filter(key => key?.cid === this.cid);
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
    try {
      await this.monitor?.rescan();
    } catch (error) {
      this.warn('rescan failed', error);
    }
  }

  /** Global config changed: follow a different data location. */
  async configure(config: PluginConfig | null | undefined) {
    const location = this.locationFor(config ?? {});
    if (!this.monitor || location === this.location) return;
    this.stopMonitor();
    await this.sync();
  }

  /** Settings UI: 'session-status' asks what a key with a filter shows. */
  async message(payload: UiMessage): Promise<unknown> {
    if (payload.data !== 'session-status') return undefined;
    const settings = payload.settings;
    return this.describe(
      `${payload.filter ?? ''}`,
      settings && typeof settings === 'object'
        ? (settings as KeyData)
        : undefined
    );
  }

  /** For the key settings page: what a key with this filter would show. */
  async describe(filter: string, data?: KeyData): Promise<SessionDescription> {
    const config = (await this.deps.loadConfig().catch(() => null)) ?? {};
    try {
      return await this.provider.sessions.describe(filter, config, data);
    } catch (error) {
      this.warn('describe failed', error);
      return {
        success: false,
        projectsDir: null,
        state: null,
        project: null,
        title: null,
        others: 0,
        notice: BROKEN,
      };
    }
  }

  /** Log prefix; Claude keeps the original "Session keys" wording. */
  private get logName(): string {
    return this.cid === SESSION_CID
      ? 'Session keys'
      : `${this.brand.name} session keys`;
  }

  private warn(what: string, error: unknown) {
    const text = error instanceof Error ? error.message : `${error}`;
    this.deps.logger?.warn?.(`${this.logName}: ${what}: ${text.slice(0, 200)}`);
  }

  private watched(location: string): string {
    try {
      return this.provider.sessions.watched?.(location) ?? location;
    } catch {
      return location;
    }
  }

  private locationFor(config: PluginConfig): string {
    try {
      return this.provider.sessions.location(config);
    } catch (error) {
      this.warn('no session location', error);
      return '';
    }
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
      keys.map(key => settingsOf(key, this.brand))
    );
    try {
      this.monitor?.setFilters(settings.map(s => s.filter));
      this.monitor?.setRunningWindow(Math.max(...settings.map(s => s.idleMs)));
    } catch (error) {
      this.warn('could not apply key settings', error);
    }
    this.redraw();
  }

  private async ensureMonitor() {
    if (this.monitor) return;
    if (!this.starting) {
      this.starting = (async () => {
        const config = (await this.deps.loadConfig().catch(() => null)) ?? {};
        if (this.monitor || !this.hasKeys()) return;
        this.location = this.locationFor(config);
        this.ready = false;
        const onChange = () => {
          if (this.monitor !== monitor) return;
          this.ready = true;
          this.redraw();
        };
        let monitor: SessionSource;
        try {
          monitor = this.provider.sessions.create({
            location: this.location,
            config,
            onChange,
            logger: this.deps.logger,
          });
        } catch (error) {
          this.warn('could not start', error);
          monitor = staticSessionSource({ onChange }, BROKEN);
        }
        this.monitor = monitor;
        try {
          monitor.start();
        } catch (error) {
          this.warn('could not start', error);
          this.monitor = staticSessionSource({ onChange }, BROKEN);
          monitor = this.monitor;
          monitor.start();
        }
        this.ticker = setInterval(() => this.redraw(), TICK_MS);
        this.deps.logger?.info?.(
          `${this.logName}: watching ${this.watched(this.location)}`
        );
      })().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private stopMonitor() {
    try {
      this.monitor?.stop();
    } catch (error) {
      this.warn('could not stop', error);
    }
    this.monitor = null;
    this.ready = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Pages of the running-sessions list on this key now (at least 1). */
  private listPagesFor(key: Key, now: number): number {
    if (!this.monitor || !this.ready) return 1;
    const { filter, idleMs } = settingsOf(key, this.brand);
    const count = this.running(filter, now, idleMs, key?.data ?? {}).length;
    return listPages(count, this.deps.keyWidth(key));
  }

  private running(filter: string, now: number, idleMs: number, data: KeyData) {
    try {
      return this.monitor?.listRunning(filter, now, idleMs, data) ?? [];
    } catch {
      return [];
    }
  }

  private pick(
    filter: string,
    now: number,
    idleMs: number,
    data: KeyData
  ): SessionPick {
    try {
      return (
        this.monitor?.getStatus(filter, now, idleMs, data) ?? {
          status: null,
          others: 0,
        }
      );
    } catch {
      return { status: null, others: 0 };
    }
  }

  private notice(data: KeyData): SessionNotice | null {
    try {
      return this.monitor?.notice?.(data) ?? null;
    } catch {
      return BROKEN;
    }
  }

  /** The product a key follows (Kimi: Kimi Code or Kimi Work). */
  private productName(data: KeyData): string {
    try {
      return this.monitor?.productName?.(data) ?? this.brand.productName;
    } catch {
      return this.brand.productName;
    }
  }

  /**
   * What a key shows now: the running-sessions list while it is open, else
   * the latest session. Equal signatures give equal images.
   */
  private viewFor(serialNumber: string, key: Key, now: number) {
    const settings = settingsOf(key, this.brand);
    const id = `${serialNumber}#${key.uid}`;
    const width = this.deps.keyWidth(key);
    const bgColor = this.deps.bgColor(key);
    const page = this.pager.pageOf(id, now);

    if (page !== null && this.monitor && this.ready) {
      const list = buildListView(
        this.running(settings.filter, now, settings.idleMs, key?.data ?? {}),
        { lang: settings.lang, width, page }
      );
      return {
        id,
        signature: JSON.stringify([
          'list',
          list,
          width,
          bgColor,
          settings.marks.markColor,
        ]),
        render: () =>
          renderSessionList(width, list, {
            bgColor,
            markColor: settings.marks.markColor,
          }),
      };
    }

    let view: SessionView;
    if (!this.monitor || !this.ready) {
      view = loadingView(settings.lang, this.productName(key?.data ?? {}));
    } else {
      const { status, others } = this.pick(
        settings.filter,
        now,
        settings.idleMs,
        key?.data ?? {}
      );
      const notice = status ? null : this.notice(key?.data ?? {});
      view = notice
        ? buildNoticeView(notice, settings.lang)
        : buildSessionView(status, {
            lang: settings.lang,
            showProject: settings.showProject,
            now,
            others,
            productName: this.productName(key?.data ?? {}),
          });
    }
    const options = { ...settings.marks, bgColor };
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
