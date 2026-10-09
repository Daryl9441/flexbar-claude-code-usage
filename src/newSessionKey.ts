/**
 * New Session keys of one provider: a press opens a new session of the
 * provider's coding agent (Claude: the Claude desktop app's "new Claude Code
 * session" page through its claude:// deep link). Generic over the provider
 * (src/providers/types.ts, Claude by default) apart from a few drawing hooks
 * supplied by plugin.ts. The face only changes on plugin.alive, on a press
 * (new width or settings) and for the brief press feedback; there are no
 * periodic redraws.
 */
import os from 'node:os';

import {
  CommandRunner,
  TerminalOpener,
  createTerminalOpener,
  runCommand,
} from './launch';
import {
  MacAppNewSessionOpener,
  openMacAppNewSession,
} from './macAppNewSession';
import {
  CLAUDE_NEW_SESSION_STRINGS,
  NewSessionState,
  NewSessionStrings,
  buildNewSessionView,
  newSessionSettings,
  resolveFolder,
} from './newSession';
import { renderNewSessionKey } from './newSessionRender';
import { Launcher, openUrl } from './openUrl';
import { CLAUDE_BRAND } from './providers/claude/brand';
import { claudeNewSessionLauncher } from './providers/claude/newSession';
import { ProviderError, brandMark, keyCid, pick } from './providers/kit';
import {
  Brand,
  Key,
  KeyGroup,
  LaunchTarget,
  Localized,
  NewSessionLauncher,
  NewSessionRequest,
  PluginConfig,
  UiMessage,
} from './providers/types';

export const NEW_SESSION_CID = keyCid('claude', 'newsession');

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type NewSessionKeyProvider = {
  cid: string;
  brand: Brand;
  launcher: NewSessionLauncher;
};

/** The original New Session key: the Claude app's new Claude Code session. */
export const CLAUDE_NEW_SESSION_KEYS: NewSessionKeyProvider = {
  cid: NEW_SESSION_CID,
  brand: CLAUDE_BRAND,
  launcher: claudeNewSessionLauncher,
};

/** A provider's key texts: its own strings over the generic defaults. */
export function newSessionStrings(
  provider: NewSessionKeyProvider
): NewSessionStrings {
  if (provider.launcher === claudeNewSessionLauncher) {
    return CLAUDE_NEW_SESSION_STRINGS;
  }
  const own = provider.launcher.strings ?? {};
  const name = provider.brand.name;
  const defaults = {
    ready: { en: 'New Session', zh: '新建会话' },
    opening: { en: 'Opening…', zh: '正在打开…' },
    error: { en: `${name} not available`, zh: `${name} 不可用` },
  };
  const table = (lang: 'en' | 'zh') => ({
    ready: pick(own.ready ?? defaults.ready, lang),
    opening: pick(own.opening ?? defaults.opening, lang),
    error: pick(own.error ?? defaults.error, lang),
  });
  return { en: table('en'), zh: table('zh') };
}

export type NewSessionTimings = {
  /** How long "Opening…" stays on the key after a press */
  openingMs: number;
  /** How long a failed launch is shown */
  errorMs: number;
  /** Presses of the same key within this window are ignored */
  debounceMs: number;
};

const DEFAULT_TIMINGS: NewSessionTimings = {
  openingMs: 1_200,
  errorMs: 3_000,
  debounceMs: 1_000,
};

/**
 * Longest wait for the global settings before a press goes ahead without
 * them (FlexDesigner's getConfig has no timeout of its own)
 */
const CONFIG_WAIT_MS = 1_000;

/** The settings, or null when they fail or take longer than `ms`. */
function loadConfigBriefly(
  load: () => Promise<PluginConfig | null | undefined>,
  ms: number
): Promise<PluginConfig | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    load().then(
      config => {
        clearTimeout(timer);
        resolve(config ?? null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export type NewSessionKeyDeps = {
  /** Runs a draw after every draw queued before it */
  enqueue: (task: () => Promise<void>) => Promise<void>;
  /** Sends a rendered image to a key; may reject */
  send: (serialNumber: string, key: Key, image: string) => Promise<void>;
  isOffline: (serialNumber: string) => boolean;
  keyWidth: (key: Key) => number;
  bgColor: (key: Key) => string | undefined;
  /** Global plugin settings, handed to the launcher with each press */
  loadConfig?: () => Promise<PluginConfig | null | undefined>;
  logger?: Logger | null;
  /** Whose sessions the keys open (default: Claude) */
  provider?: NewSessionKeyProvider;
  /** Opens a URL target (tests pass a stub; nothing else should) */
  launch?: Launcher;
  /** Starts a command target (tests pass a stub, too) */
  run?: CommandRunner;
  /** Opens a terminal target (default: built on `run`; tests pass a stub) */
  terminal?: TerminalOpener;
  /** Opens and verifies an App's new conversation page (tests inject a stub). */
  macAppNewSession?: MacAppNewSessionOpener;
  /** Platform targets are built for (default: this one) */
  platform?: NodeJS.Platform;
  /** Renders a key face (defaults to renderNewSessionKey) */
  render?: typeof renderNewSessionKey;
  now?: () => number;
  /** Home folder for `~` (defaults to the user's) */
  home?: string;
  timings?: Partial<NewSessionTimings>;
  /** Longest wait for the global settings on a press (default 1 s) */
  configWaitMs?: number;
};

type Feedback = {
  state: 'opening' | 'error';
  timer: NodeJS.Timeout;
  /** The launcher's own error title (ProviderError keyText), if any */
  title?: Localized;
};

/** The error-face title a launcher attached to its error, or undefined. */
function launchErrorTitle(error: unknown): Localized | undefined {
  if (!(error instanceof ProviderError)) return undefined;
  const text = error.extra.keyText;
  if (!text) return undefined;
  if ('title' in text) return { en: text.title, zh: text.title };
  return { en: text.en.title, zh: text.zh.title };
}

export class NewSessionKeys implements KeyGroup {
  readonly cid: string;
  private keys = new Map<string, Key[]>();
  /** Signature of the image each key shows, by `${serialNumber}#${uid}` */
  private drawn = new Map<string, string>();
  /** Keys with a draw waiting in the queue (it renders the latest view) */
  private queued = new Set<string>();
  private feedback = new Map<string, Feedback>();
  private lastPress = new Map<string, number>();
  /** Whether the launcher got the global settings (configure) yet */
  private configured = false;
  private readonly launch: Launcher;
  private readonly run: CommandRunner;
  private readonly terminal: TerminalOpener;
  private readonly macAppNewSession: MacAppNewSessionOpener;
  private readonly render: typeof renderNewSessionKey;
  private readonly now: () => number;
  private readonly timings: NewSessionTimings;
  private readonly provider: NewSessionKeyProvider;
  private readonly strings: NewSessionStrings;
  /** Brand look on the face; empty for Claude (keeps its look) */
  private readonly look: {
    accent?: string;
    mark?: ReturnType<typeof brandMark>;
  };

  constructor(private readonly deps: NewSessionKeyDeps) {
    this.provider = deps.provider ?? CLAUDE_NEW_SESSION_KEYS;
    this.cid = this.provider.cid;
    this.launch = deps.launch ?? openUrl;
    this.run = deps.run ?? runCommand;
    this.terminal =
      deps.terminal ??
      createTerminalOpener({ platform: deps.platform, run: this.run });
    this.macAppNewSession = deps.macAppNewSession ?? openMacAppNewSession;
    this.render = deps.render ?? renderNewSessionKey;
    this.now = deps.now ?? Date.now;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.strings = newSessionStrings(this.provider);
    const mark = brandMark(this.provider.brand);
    this.look = mark ? { accent: this.provider.brand.accent, mark } : {};
  }

  /** plugin.alive: the device's current plugin keys (any cid). */
  async alive(serialNumber: string, keys: Key[]): Promise<void> {
    const mine = keys.filter(key => key?.cid === this.cid);
    if (mine.length > 0) this.keys.set(serialNumber, mine);
    else this.keys.delete(serialNumber);
    // the page was (re)loaded: repaint everything on it
    this.forget(serialNumber, () => true, false);
    if (mine.length > 0) await this.configureLauncher();
    return this.redraw();
  }

  /**
   * Hands the global settings to a launcher that asks for them, once
   * before its first face (later changes come through configure).
   */
  private async configureLauncher() {
    const launcher = this.provider.launcher;
    const load = this.deps.loadConfig;
    if (this.configured || !launcher.configure || !launcher.needsConfig) {
      return;
    }
    if (!load) return;
    this.configured = true;
    const config = await loadConfigBriefly(
      load,
      this.deps.configWaitMs ?? CONFIG_WAIT_MS
    );
    if (!config) {
      this.configured = false;
      return;
    }
    try {
      launcher.configure(config);
    } catch {
      // the subtitle keeps its guess
    }
  }

  /** plugin.dead: keys that left the device page (all when none listed). */
  dead(serialNumber: string, keys: Key[]): Promise<void> {
    const dead = new Set(keys.map(key => key?.uid));
    const remaining =
      dead.size === 0
        ? []
        : (this.keys.get(serialNumber) ?? []).filter(k => !dead.has(k.uid));
    if (remaining.length > 0) this.keys.set(serialNumber, remaining);
    else this.keys.delete(serialNumber);
    const alive = new Set(remaining.map(key => `${serialNumber}#${key.uid}`));
    this.forget(serialNumber, id => !alive.has(id), true);
    return Promise.resolve();
  }

  /**
   * Global settings changed: launchers that use them (an 'auto' subtitle)
   * get them; no settings-page messages.
   */
  async configure(config?: PluginConfig) {
    const launcher = this.provider.launcher;
    if (!launcher.configure || !launcher.needsConfig) return;
    try {
      launcher.configure(config ?? {});
      this.configured = true;
    } catch {
      return;
    }
    await this.redraw();
  }

  async message(payload?: UiMessage): Promise<unknown> {
    if (
      payload?.data !== 'new-session-test' ||
      payload.cid !== this.cid ||
      !['kimi', 'antigravity'].some(id =>
        this.cid.endsWith(`.${id}_newsession`)
      )
    )
      return undefined;
    const key: Key = {
      uid: -1,
      cid: this.cid,
      width: 120,
      data:
        payload.settings && typeof payload.settings === 'object'
          ? (payload.settings as Record<string, unknown>)
          : {},
    };
    // The settings-page Test button uses the same press handler without
    // changing or sending a device key, its layout, or its display settings.
    const success = await this.press('UI-PREVIEW', key);
    const error = this.feedback.get('UI-PREVIEW#-1')?.title;
    return { success, ...(error ? { error } : {}) };
  }

  /**
   * Key press: opens a new session, unless the same key was pressed less
   * than a second ago. Resolves to whether it launched.
   */
  async press(serialNumber: string, pressed: Key): Promise<boolean> {
    const id = `${serialNumber}#${pressed?.uid}`;
    const keys = this.keys.get(serialNumber);
    const index = keys?.findIndex(key => key.uid === pressed?.uid) ?? -1;
    // the pressed copy carries the current width and settings
    if (keys && index >= 0) keys[index] = pressed;

    const now = this.now();
    const last = this.lastPress.get(id);
    if (last !== undefined && now - last < this.timings.debounceMs) {
      void this.redraw();
      return false;
    }
    this.lastPress.set(id, now);

    this.showFeedback(id, 'opening', this.timings.openingMs);
    const appName = this.provider.launcher.appName;
    try {
      // launchers look for programs under the home folder: always pass one
      const home = this.deps.home ?? os.homedir();
      const data = (pressed?.data ?? {}) as Record<string, unknown>;
      const settings = newSessionSettings(data, home);
      const load = this.deps.loadConfig;
      const config =
        this.provider.launcher.needsConfig && load
          ? await loadConfigBriefly(
              load,
              this.deps.configWaitMs ?? CONFIG_WAIT_MS
            )
          : null;
      const request: NewSessionRequest = {
        data,
        rawFolder: settings.folder,
        folder: resolveFolder(settings.folder, home),
        home,
        platform: this.deps.platform ?? process.platform,
        config: config ?? {},
      };
      // async, so a launcher that throws still shows "Opening…" first
      const target = await (async () =>
        this.provider.launcher.target(request))();
      this.deps.logger?.info?.(`New Session key: opening ${appName}`);
      await this.open(target);
      if (target.kind === 'mac-app-new-session') {
        this.deps.logger?.info?.(`New Session key: verified ${appName}`);
      }
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : `${error}`;
      this.deps.logger?.warn?.(
        `New Session key: could not open ${appName}: ${text.slice(0, 200)}`
      );
      this.showFeedback(
        id,
        'error',
        this.timings.errorMs,
        launchErrorTitle(error)
      );
      return false;
    }
  }

  /** Hands a target to the URL opener or the command runner (no shell). */
  private open(target: LaunchTarget): Promise<void> {
    switch (target.kind) {
      case 'url':
        return this.launch(target.url);
      case 'command':
        return this.run({
          file: target.file,
          args: target.args,
          ...(target.cwd ? { cwd: target.cwd } : {}),
        });
      case 'terminal':
        return this.terminal(target.command, target.cwd);
      case 'mac-app-new-session':
        return this.macAppNewSession(target.bundleId);
      default:
        throw new Error('Unknown launch target');
    }
  }

  /** Queues a draw for every key whose image would change. */
  redraw(): Promise<void> {
    const draws: Promise<void>[] = [];
    for (const [serialNumber, keys] of this.keys) {
      for (const key of keys) {
        const { id, signature } = this.viewFor(serialNumber, key);
        if (this.drawn.get(id) === signature || this.queued.has(id)) continue;
        this.queued.add(id);
        draws.push(
          this.deps.enqueue(async () => {
            this.queued.delete(id);
            await this.draw(serialNumber, key.uid);
          })
        );
      }
    }
    return Promise.all(draws).then(() => undefined);
  }

  private showFeedback(
    id: string,
    state: Feedback['state'],
    durationMs: number,
    title?: Localized
  ) {
    const previous = this.feedback.get(id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (this.feedback.get(id)?.timer !== timer) return;
      this.feedback.delete(id);
      void this.redraw();
    }, durationMs);
    timer.unref?.();
    this.feedback.set(id, { state, timer, ...(title ? { title } : {}) });
    void this.redraw();
  }

  /** Drops the state of a device's keys matching `match`. */
  private forget(
    serialNumber: string,
    match: (id: string) => boolean,
    all: boolean
  ) {
    const prefix = `${serialNumber}#`;
    for (const id of [...this.drawn.keys()]) {
      if (id.startsWith(prefix) && match(id)) this.drawn.delete(id);
    }
    if (!all) return;
    for (const [id, feedback] of [...this.feedback]) {
      if (!id.startsWith(prefix) || !match(id)) continue;
      clearTimeout(feedback.timer);
      this.feedback.delete(id);
    }
    for (const id of [...this.lastPress.keys()]) {
      if (id.startsWith(prefix) && match(id)) this.lastPress.delete(id);
    }
  }

  /** The image inputs for a key now; equal views give equal images. */
  private viewFor(serialNumber: string, key: Key) {
    const id = `${serialNumber}#${key.uid}`;
    const feedback = this.feedback.get(id);
    const state: NewSessionState = feedback?.state ?? 'ready';
    const settings = newSessionSettings(key?.data, this.deps.home);
    const view = buildNewSessionView(state, settings, this.strings);
    if (state === 'error' && feedback?.title) {
      view.title = pick(feedback.title, settings.lang);
    }
    const subtitle = this.provider.launcher.subtitle;
    if (subtitle && state !== 'error') {
      try {
        view.subtitle = subtitle(
          (key?.data ?? {}) as Record<string, unknown>,
          settings.folderName,
          settings.lang
        );
      } catch {
        // keep the folder name
      }
    }
    const width = this.deps.keyWidth(key);
    const options = { bgColor: this.deps.bgColor(key), ...this.look };
    return {
      id,
      view,
      width,
      options,
      signature: JSON.stringify([view, width, options]),
    };
  }

  private async draw(serialNumber: string, uid: unknown) {
    // look the key up again: it may have died or changed while queued
    const key = this.keys.get(serialNumber)?.find(k => k.uid === uid);
    if (!key || this.deps.isOffline(serialNumber)) return;
    const { id, view, width, options, signature } = this.viewFor(
      serialNumber,
      key
    );
    if (this.drawn.get(id) === signature) return;
    // recorded up front: a failed image is retried on the next change only
    this.drawn.set(id, signature);
    try {
      await this.deps.send(
        serialNumber,
        key,
        this.render(width, view, options)
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : `${error}`;
      this.deps.logger?.warn?.(
        `Could not draw new session key ${uid}: ${text.slice(0, 200)}`
      );
    }
  }
}
