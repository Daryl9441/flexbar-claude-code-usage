/**
 * Usage meter keys of one provider: polls the provider's usage source while
 * its keys are on a device page (never faster than the source's minimum gap,
 * and not at all during a rate-limit lockout) and draws every key from the
 * last result. Provider specifics come from a UsageSource
 * (src/providers/types.ts); drawing hooks come from plugin.ts.
 */
import {
  ProviderError,
  brandMark,
  errorKeyText,
  keyCid,
  lockoutSeconds,
  markOptions,
} from './providers/kit';
import {
  Brand,
  Key,
  KeyData,
  KeyGroup,
  KeyHost,
  KeyText,
  Lang,
  PluginConfig,
  UiMessage,
  UsageDescription,
  UsageFace,
  UsageFaceRequest,
  UsageMetric,
  UsageSource,
} from './providers/types';
import { safeErrorMessage } from './redact';
import { MessageOptions, renderMessageKey, renderUsageKey } from './render';
import { TONE_COLORS, langOf } from './sessionView';
import { RESET_NOW_ZH, formatTimeUntilReset } from './usage';

// Minimum gap between any two usage requests, so key presses and page
// switches cannot burst against a rate-limited endpoint
const DEFAULT_MIN_FETCH_GAP_MS = 30_000;
// Keeps the lockout countdown on the keys fresh
const LOCK_TICK_MS = 15_000;

const TEXT = {
  en: {
    loading: 'Loading…',
    noData: 'No data for this limit',
    rateLimited: 'Rate limited',
    resumes: (time: string) => `Resumes in ${time}`,
    retry: (time: string) => `Rate limited, retry in ${time}`,
  },
  zh: {
    loading: '加载中…',
    noData: '此项暂无数据',
    rateLimited: '请求受限',
    resumes: (time: string) =>
      time === RESET_NOW_ZH ? '即将恢复' : `${time}后恢复`,
    retry: (time: string) => `请求受限，${time} 后重试`,
  },
};

/** ProviderError codes the user can act on (or wait out): amber, not red */
const ACTIONABLE = new Set([
  'not-installed',
  'not-configured',
  'unsupported',
  'no-credentials',
  'unauthorized',
  'rate-limited',
]);

/**
 * Title colour of an error face: amber for what the user can act on (log
 * in, install, wait), red for failures, like the session keys' states.
 */
function errorColor(error: unknown): string {
  return error instanceof ProviderError && ACTIONABLE.has(error.code)
    ? TONE_COLORS.attention
    : TONE_COLORS.error;
}

export type UsageKeyProvider = {
  cid: string;
  brand: Brand;
  source: UsageSource;
};

export type UsageKeyDeps = KeyHost & {
  provider: UsageKeyProvider;
  /** Poll interval in ms (global setting) */
  pollIntervalMs: () => number;
};

/** Shortens SDK errors, whose messages can embed the whole base64 image. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : `${error}`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export class UsageKeys implements KeyGroup {
  readonly cid: string;
  private keys = new Map<string, Key[]>();
  private metrics: UsageMetric[] | null = null;
  /** The last fetch error, kept raw so each key words it in its language */
  private failure: { error: unknown } | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lockedUntil: number | null = null;
  private lockTicker: NodeJS.Timeout | null = null;
  private lastFetchAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: UsageKeyDeps) {
    this.cid = deps.provider.cid;
  }

  private get source(): UsageSource {
    return this.deps.provider.source;
  }

  private get brand(): Brand {
    return this.deps.provider.brand;
  }

  /** Claude's keys keep the log wording they always had. */
  private get isClaude(): boolean {
    return this.cid === keyCid('claude', 'usage');
  }

  /**
   * plugin.alive: keys loaded onto a device page (page switch, profile
   * upload, reconnect), with FlexDesigner's current uid and width for each.
   */
  async alive(serialNumber: string, keys: Key[]) {
    const mine = keys.filter(key => key?.cid === this.cid);
    if (mine.length === 0) {
      this.keys.delete(serialNumber);
      return;
    }
    this.keys.set(serialNumber, mine);
    const name = this.isClaude ? 'Usage' : `${this.brand.name} usage`;
    this.deps.logger?.info?.(
      `${name} keys alive on ${serialNumber}: ` +
        mine
          .map(key => `uid=${key.uid} width=${this.deps.keyWidth(key)}`)
          .join(', ')
    );

    this.ensurePolling();
    // Always paint right away (cached data, error or "Loading…"), so the key
    // never keeps showing whatever the device had before
    await this.drawAll();
    if (!this.metrics) await this.refresh();
  }

  /**
   * plugin.dead: keys that left the device page. Their uids are reassigned
   * by the next profile upload, so drawing to them must stop immediately.
   */
  async dead(serialNumber: string, keys: Key[]) {
    const dead = new Set(keys.map(key => key?.uid));
    const remaining =
      dead.size === 0
        ? []
        : (this.keys.get(serialNumber) ?? []).filter(key => !dead.has(key.uid));
    if (remaining.length > 0) this.keys.set(serialNumber, remaining);
    else this.keys.delete(serialNumber);
  }

  /**
   * Key press: refresh now. The payload carries the key as FlexDesigner
   * currently knows it, so keep that copy (its width may have changed).
   */
  async press(serialNumber: string, pressed: Key) {
    const keys = this.keys.get(serialNumber);
    const index = keys?.findIndex(key => key.uid === pressed?.uid) ?? -1;
    if (keys && index >= 0) keys[index] = pressed;
    await this.refresh();
  }

  /** Global config changed: new poll interval, maybe new credentials. */
  async configure() {
    if (this.pollTimer || this.hasKeys()) this.ensurePolling(true);
    await this.refresh();
  }

  /** Settings UI: 'usage-status' (key page) or 'test-connection' (global). */
  async message(payload: UiMessage): Promise<unknown> {
    if (payload.data !== 'usage-status' && payload.data !== 'test-connection') {
      return undefined;
    }
    if (this.lockedUntil && Date.now() < this.lockedUntil) {
      const lift = formatTimeUntilReset(
        new Date(this.lockedUntil).toISOString()
      );
      return { success: false, error: TEXT.en.retry(lift) };
    }
    const config =
      (payload.config as PluginConfig | undefined) ??
      (await this.deps.loadConfig().catch(() => null)) ??
      {};
    if (this.source.describe) {
      try {
        const settings = payload.settings;
        return await this.source.describe(
          config,
          settings && typeof settings === 'object'
            ? (settings as KeyData)
            : undefined
        );
      } catch (error) {
        return { success: false, error: this.logText(error) };
      }
    }
    // a key page opened right after a fetch needs no request of its own
    if (
      payload.data === 'usage-status' &&
      this.metrics &&
      Date.now() - this.lastFetchAt < this.minFetchGapMs()
    ) {
      return { success: true, metrics: this.metrics };
    }
    try {
      const metrics = await this.source.fetch(config);
      return { success: true, metrics } satisfies UsageDescription;
    } catch (error) {
      return { success: false, error: this.logText(error) };
    }
  }

  /** Stops the timers (tests; the plugin process never needs it). */
  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.clearLock();
  }

  private minFetchGapMs(): number {
    return this.source.minFetchGapMs ?? DEFAULT_MIN_FETCH_GAP_MS;
  }

  private hasKeys(): boolean {
    for (const keys of this.keys.values()) if (keys.length > 0) return true;
    return false;
  }

  private logText(error: unknown): string {
    try {
      return this.source.logText?.(error) ?? safeErrorMessage(error);
    } catch {
      return safeErrorMessage(error);
    }
  }

  private errorText(error: unknown, lang: Lang): KeyText {
    try {
      if (this.source.errorText) return this.source.errorText(error, lang);
    } catch {
      // fall back to the generic wording
    }
    return errorKeyText(error, this.brand, lang);
  }

  /** The source's text for a metric the last fetch did not return, or null. */
  private missingText(metric: string, lang: Lang): KeyText | null {
    try {
      return this.source.missingText?.(metric, lang) ?? null;
    } catch {
      return null;
    }
  }

  private lockout(error: unknown): number | null {
    try {
      return this.source.lockoutSeconds
        ? this.source.lockoutSeconds(error)
        : lockoutSeconds(error);
    } catch {
      return null;
    }
  }

  private keepLast(error: unknown): boolean {
    try {
      return this.source.keepLastOnError?.(error) === true;
    } catch {
      return false;
    }
  }

  /** The chip text of a metric in a key language. */
  private metricLabel(metric: UsageMetric, lang: Lang): string {
    try {
      return this.source.metricLabel?.(metric, lang) ?? metric.label;
    } catch {
      return metric.label;
    }
  }

  /**
   * The source's own face for a key, or null for the single meter. A face
   * that throws is logged and left out, so the key still gets the meter or
   * the "No data" face instead of keeping what it showed before.
   */
  private async face(request: UsageFaceRequest): Promise<UsageFace | null> {
    if (!this.source.face) return null;
    try {
      return (await this.source.face(request)) ?? null;
    } catch (error) {
      const name = this.isClaude ? 'Usage' : `${this.brand.name} usage`;
      this.deps.logger?.warn?.(
        `${name} key face failed: ${this.logText(error)}`
      );
      return null;
    }
  }

  private async renderKey(key: Key): Promise<string> {
    const width = this.deps.keyWidth(key);
    const data = key?.data ?? {};
    const lang = langOf(data.lang);
    const text = TEXT[lang];
    const marks = markOptions(this.brand, data);
    const mark = brandMark(this.brand);
    const message: MessageOptions = {
      accent: this.brand.accent,
      mark,
      ...(mark ? { markColor: this.brand.accent } : {}),
    };
    // Claude keeps its orange titles; other providers word errors in the
    // status colours (their accent stays on neutral faces and the mark)
    const alarm = (color: string): MessageOptions =>
      mark ? { ...message, accent: color } : message;

    if (this.lockedUntil && Date.now() < this.lockedUntil) {
      const lift = formatTimeUntilReset(
        new Date(this.lockedUntil).toISOString(),
        lang
      );
      return renderMessageKey(
        width,
        text.rateLimited,
        text.resumes(lift),
        alarm(TONE_COLORS.attention)
      );
    }

    if (this.metrics) {
      const metric: string =
        data.metric || this.source.defaultMetric || this.metrics[0]?.id || '';
      const showResetTime = data.showResetTime !== false;
      const bgColor = this.deps.bgColor(key);
      // a view of several metrics the source draws itself (Claude's 'dual')
      const face = await this.face({
        metric,
        metrics: this.metrics,
        width,
        showResetTime,
        bgColor,
        lang,
        data,
      });
      if (face) {
        return 'image' in face
          ? face.image
          : renderMessageKey(
              width,
              face.text.title,
              face.text.message,
              message
            );
      }
      const snapshot = this.metrics.find(m => m.id === metric);
      if (snapshot) {
        return renderUsageKey(
          width,
          { ...snapshot, label: this.metricLabel(snapshot, lang) },
          {
            showResetTime,
            ...marks,
            bgColor,
            ...(lang === 'zh' ? { lang } : {}),
            // model chips drop the version before they are cut; Claude's
            // keep it, as they always did
            ...(this.brand.mark === 'clawd' ? {} : { dropVersion: true }),
          }
        );
      }
      const missing = this.missingText(metric, lang);
      return missing
        ? renderMessageKey(width, missing.title, missing.message, message)
        : renderMessageKey(width, this.brand.productName, text.noData, message);
    }

    if (this.failure) {
      const { title, message: body } = this.errorText(this.failure.error, lang);
      return renderMessageKey(
        width,
        title,
        body,
        alarm(errorColor(this.failure.error))
      );
    }
    return renderMessageKey(
      width,
      this.brand.productName,
      text.loading,
      message
    );
  }

  /** The current copy of a key, or null once it is dead or its device gone. */
  private aliveKey(serialNumber: string, uid: unknown): Key | null {
    if (this.deps.isOffline(serialNumber)) return null;
    return this.keys.get(serialNumber)?.find(key => key.uid === uid) ?? null;
  }

  /**
   * Renders one key and waits for FlexDesigner's acknowledgement. A rejected
   * draw (device gone, key no longer alive) is logged, never thrown.
   */
  private async drawKey(serialNumber: string, uid: unknown) {
    const key = this.aliveKey(serialNumber, uid);
    if (!key) return;
    try {
      await this.deps.send(serialNumber, key, await this.renderKey(key));
    } catch (error) {
      this.deps.logger?.warn?.(
        `Could not draw key ${uid}: ${describeError(error)}`
      );
    }
  }

  /**
   * Redraws every alive key in one queued pass, so overlapping triggers
   * (poll, press, page load, lockout ticker) never interleave their draws;
   * each key is looked up again right before it is drawn.
   */
  drawAll(): Promise<void> {
    return this.deps.enqueue(async () => {
      const targets = [...this.keys].flatMap(([serialNumber, keys]) =>
        keys.map(key => [serialNumber, key.uid] as const)
      );
      for (const [serialNumber, uid] of targets) {
        await this.drawKey(serialNumber, uid);
      }
    });
  }

  private clearLock() {
    this.lockedUntil = null;
    if (this.lockTicker) {
      clearInterval(this.lockTicker);
      this.lockTicker = null;
    }
  }

  /**
   * Enters lockout: no requests until it expires (the window counts down
   * server-side regardless of further requests); a ticker keeps the
   * countdown on the keys fresh.
   */
  private setLock(seconds: number) {
    this.lockedUntil = Date.now() + seconds * 1000;
    this.deps.logger?.warn?.(
      this.isClaude
        ? `Usage endpoint rate limited, backing off for ${seconds}s`
        : `${this.brand.name} usage rate limited, backing off for ${seconds}s`
    );
    if (this.lockTicker) clearInterval(this.lockTicker);
    this.lockTicker = setInterval(async () => {
      if (this.lockedUntil && Date.now() >= this.lockedUntil) {
        this.clearLock();
        await this.refresh();
      } else {
        await this.drawAll();
      }
    }, LOCK_TICK_MS);
  }

  /** Fetches (at most one request at a time) and redraws. */
  refresh(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRefresh() {
    const now = Date.now();
    if (this.lockedUntil && now < this.lockedUntil) {
      await this.drawAll();
      return;
    }
    if (now - this.lastFetchAt < this.minFetchGapMs()) return;
    if (!this.hasKeys()) return;
    this.lastFetchAt = now;

    const config = (await this.deps.loadConfig().catch(() => null)) ?? {};
    try {
      this.metrics = await this.source.fetch(config);
      this.failure = null;
      this.clearLock();
    } catch (error) {
      this.failure = { error };
      this.deps.logger?.error?.(
        `Failed to fetch ${this.brand.name} usage: ${this.logText(error)}`
      );
      const lock = this.lockout(error);
      if (lock !== null) this.setLock(lock);
      else if (!this.keepLast(error)) this.metrics = null;
    }
    await this.drawAll();
  }

  private ensurePolling(restart = false) {
    if (this.pollTimer && !restart) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(
      () => void this.refresh(),
      this.deps.pollIntervalMs()
    );
  }
}
