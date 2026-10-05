/**
 * The New Session key: a press opens the Claude desktop app's "new Claude
 * Code session" page through its claude:// deep link. Self-contained apart
 * from a few drawing hooks supplied by plugin.ts. The face only changes on
 * plugin.alive, on a press (new width or settings) and for the brief press
 * feedback; there are no periodic redraws.
 */
import {
  NewSessionState,
  buildNewSessionUrl,
  buildNewSessionView,
  newSessionSettings,
} from './newSession';
import { renderNewSessionKey } from './newSessionRender';
import { Launcher, openUrl } from './openUrl';

export const NEW_SESSION_CID = 'dev.sese.flexbar_claude_code_usage.newsession';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Key = any;

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

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

export type NewSessionKeyDeps = {
  /** Runs a draw after every draw queued before it */
  enqueue: (task: () => Promise<void>) => Promise<void>;
  /** Sends a rendered image to a key; may reject */
  send: (serialNumber: string, key: Key, image: string) => Promise<void>;
  isOffline: (serialNumber: string) => boolean;
  keyWidth: (key: Key) => number;
  bgColor: (key: Key) => string | undefined;
  logger?: Logger | null;
  /** Opens the deep link (tests pass a stub; nothing else should) */
  launch?: Launcher;
  /** Renders a key face (defaults to renderNewSessionKey) */
  render?: typeof renderNewSessionKey;
  now?: () => number;
  /** Home folder for `~` (defaults to the user's) */
  home?: string;
  timings?: Partial<NewSessionTimings>;
};

type Feedback = { state: 'opening' | 'error'; timer: NodeJS.Timeout };

export class NewSessionKeys {
  private keys = new Map<string, Key[]>();
  /** Signature of the image each key shows, by `${serialNumber}#${uid}` */
  private drawn = new Map<string, string>();
  /** Keys with a draw waiting in the queue (it renders the latest view) */
  private queued = new Set<string>();
  private feedback = new Map<string, Feedback>();
  private lastPress = new Map<string, number>();
  private readonly launch: Launcher;
  private readonly render: typeof renderNewSessionKey;
  private readonly now: () => number;
  private readonly timings: NewSessionTimings;

  constructor(private readonly deps: NewSessionKeyDeps) {
    this.launch = deps.launch ?? openUrl;
    this.render = deps.render ?? renderNewSessionKey;
    this.now = deps.now ?? Date.now;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  /** plugin.alive: the device's current plugin keys (any cid). */
  alive(serialNumber: string, keys: Key[]): Promise<void> {
    const mine = keys.filter(key => key?.cid === NEW_SESSION_CID);
    if (mine.length > 0) this.keys.set(serialNumber, mine);
    else this.keys.delete(serialNumber);
    // the page was (re)loaded: repaint everything on it
    this.forget(serialNumber, () => true, false);
    return this.redraw();
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
   * Key press: opens a new Claude Code session, unless the same key was
   * pressed less than a second ago. Resolves to whether it launched.
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
    try {
      const settings = newSessionSettings(pressed?.data, this.deps.home);
      const url = buildNewSessionUrl(settings.folder, this.deps.home);
      this.deps.logger?.info?.('New Session key: opening the Claude app');
      await this.launch(url);
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : `${error}`;
      this.deps.logger?.warn?.(
        `New Session key: could not open the Claude app: ${text.slice(0, 200)}`
      );
      this.showFeedback(id, 'error', this.timings.errorMs);
      return false;
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
    durationMs: number
  ) {
    const previous = this.feedback.get(id);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (this.feedback.get(id)?.timer !== timer) return;
      this.feedback.delete(id);
      void this.redraw();
    }, durationMs);
    timer.unref?.();
    this.feedback.set(id, { state, timer });
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
    const state: NewSessionState = this.feedback.get(id)?.state ?? 'ready';
    const view = buildNewSessionView(
      state,
      newSessionSettings(key?.data, this.deps.home)
    );
    const width = this.deps.keyWidth(key);
    const options = { bgColor: this.deps.bgColor(key) };
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
