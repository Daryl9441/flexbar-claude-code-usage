/**
 * Usage meter keys of one provider: polls the provider's usage source while
 * its keys are on a device page (never faster than the source's minimum gap,
 * and not at all during a rate-limit lockout) and draws every key from the
 * last result. Provider specifics come from a UsageSource
 * (src/providers/types.ts); drawing hooks come from plugin.ts.
 */
import { createHash } from 'node:crypto';

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
  UsagePressPage,
  UsageSource,
} from './providers/types';
import { safeErrorMessage } from './redact';
import { MessageOptions, renderMessageKey, renderUsageKey } from './render';
import { LIST_TIMEOUT_MS, ListPager, TONE_COLORS, langOf } from './sessionView';
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

/** Hash of the settings a fetch used. Not a copy of any secret. */
function configFingerprint(config: PluginConfig): string {
  const keys = Object.keys(config).sort();
  const body = JSON.stringify(keys.map(key => [key, config[key]]));
  return createHash('sha256').update(body).digest('hex');
}

/** Shortens SDK errors, whose messages can embed the whole base64 image. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : `${error}`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * A metric id fit for one log line: ids are short words ('5h', 'weekly'),
 * but a key's setting is whatever its settings page stored.
 */
function logId(metric: string): string {
  const id = metric.replace(/[^\w.:-]/g, '?');
  return id.length > 40 ? `${id.slice(0, 40)}…` : id;
}

/** The `metric` setting of a key for the log, 'default' when empty. */
function metricSetting(key: Key): string {
  const metric: unknown = key?.data?.metric;
  return typeof metric === 'string' && metric ? logId(metric) : 'default';
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
  /**
   * Settings from the latest plugin.config.updated, used by the next fetch
   * instead of loadConfig. Null once that fetch has taken them.
   */
  private pendingConfig: PluginConfig | null = null;
  /**
   * Hash of the settings the last fetch used. A save whose settings differ
   * fetches immediately; the hash is not the key and is never logged.
   */
  private appliedFingerprint = '';
  /** The next fetch may ignore the minimum gap (a settings save). */
  private bypassGap = false;
  /**
   * Press rotation (providers with pressPages). Same pager and timeout as
   * the session list: a press advances, the page after the last returns to
   * the resting meter, and so does LIST_TIMEOUT_MS without a press.
   */
  private pager = new ListPager();
  private cycleTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Keys drawing another metric than their setting (substituteMetric), by
   * serial number and uid, so each change is logged once, not every redraw.
   */
  private substituted = new Map<string, Map<unknown, string>>();

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

  /** How log lines name these keys: "Usage" (Claude), "Kimi usage", … */
  private get logName(): string {
    return this.isClaude ? 'Usage' : `${this.brand.name} usage`;
  }

  /**
   * plugin.alive: keys loaded onto a device page (page switch, profile
   * upload, reconnect), with FlexDesigner's current uid and width for each.
   */
  async alive(serialNumber: string, keys: Key[]) {
    const mine = keys.filter(key => key?.cid === this.cid);
    if (mine.length === 0) {
      // none of these keys left on the page: forget them like dead() does
      this.keys.delete(serialNumber);
      this.substituted.delete(serialNumber);
      this.forgetCycles(id => id.startsWith(`${serialNumber}#`));
      return;
    }
    this.keys.set(serialNumber, mine);
    const alive = new Set(mine.map(key => `${serialNumber}#${key.uid}`));
    this.forgetCycles(
      id => id.startsWith(`${serialNumber}#`) && !alive.has(id)
    );
    this.pruneSubstituted(serialNumber);
    this.deps.logger?.info?.(
      `${this.logName} keys alive on ${serialNumber}: ` +
        mine
          .map(
            key =>
              `uid=${key.uid} width=${this.deps.keyWidth(key)} ` +
              `metric=${metricSetting(key)}`
          )
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
    const keep = new Set(remaining.map(key => `${serialNumber}#${key.uid}`));
    this.forgetCycles(id => id.startsWith(`${serialNumber}#`) && !keep.has(id));
    this.pruneSubstituted(serialNumber);
  }

  /**
   * Key press. Providers without pressPages only refresh. A source that
   * publishes pages rotates one page per press (plan, credits, each limit)
   * and still refreshes; a press inside the fetch gap redraws the new page.
   * A source that prepares but has no pages (Grok Bot's keychain prompt)
   * prepares first and refreshes past the gap, so the press reads the
   * login it just unblocked. The payload carries the key as FlexDesigner
   * currently knows it, so keep that copy (its width may have changed).
   */
  async press(serialNumber: string, pressed: Key) {
    const keys = this.keys.get(serialNumber);
    const index = keys?.findIndex(key => key.uid === pressed?.uid) ?? -1;
    if (keys && index >= 0) keys[index] = pressed;
    const rotates = Boolean(this.source.pressPages || this.source.preparePress);
    const prepare = async () => {
      if (!this.source.preparePress) return;
      const config =
        this.pendingConfig ??
        (await this.deps.loadConfig().catch(() => null)) ??
        {};
      try {
        await this.source.preparePress(config);
      } catch {
        // plan and credits are optional; the quota pages still rotate
      }
    };
    if (this.source.preparePress && !this.source.pressPages) {
      await prepare();
      this.bypassGap = true;
    }
    await this.refresh();
    if (!rotates) return;
    if (this.source.pressPages) await prepare();
    this.rotatePress(serialNumber, pressed);
    await this.drawAll();
  }

  /**
   * Global config changed: new poll interval, maybe new credentials.
   * A change fetches now, inside the usual gap, so a key saved in the
   * settings page shows up without waiting for the next poll.
   */
  async configure(next?: PluginConfig) {
    if (next) {
      if (configFingerprint(next) !== this.appliedFingerprint) {
        this.bypassGap = true;
      }
      this.pendingConfig = next;
    }
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
    this.forgetCycles(() => true);
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

  /**
   * The metric the source draws instead of one the last fetch did not
   * return, or null. Only an id among `metrics` counts.
   */
  private substitute(
    metric: string,
    metrics: UsageMetric[]
  ): UsageMetric | null {
    if (!this.source.substituteMetric) return null;
    try {
      const id = this.source.substituteMetric(metric, metrics);
      return (id && metrics.find(m => m.id === id)) || null;
    } catch {
      return null;
    }
  }

  /**
   * Remembers which metric a key draws in place of its setting (null: its
   * own) and logs each new substitution once.
   */
  private noteSubstitute(
    serialNumber: string,
    uid: unknown,
    metric: string,
    shown: string | null
  ) {
    const keys = this.substituted.get(serialNumber);
    if (shown === null) {
      keys?.delete(uid);
      if (keys?.size === 0) this.substituted.delete(serialNumber);
      return;
    }
    const entry = `${metric}\u0000${shown}`;
    if (keys?.get(uid) === entry) return;
    if (keys) keys.set(uid, entry);
    else this.substituted.set(serialNumber, new Map([[uid, entry]]));
    this.deps.logger?.info?.(
      `${this.logName} key uid=${uid}: limit '${logId(metric)}' is not ` +
        `reported; showing ${logId(shown)}`
    );
  }

  /** Forgets substitutions of keys no longer alive on a device. */
  private pruneSubstituted(serialNumber: string) {
    const keys = this.substituted.get(serialNumber);
    if (!keys) return;
    const alive = new Set((this.keys.get(serialNumber) ?? []).map(k => k.uid));
    for (const uid of [...keys.keys()]) if (!alive.has(uid)) keys.delete(uid);
    if (keys.size === 0) this.substituted.delete(serialNumber);
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
      this.deps.logger?.warn?.(
        `${this.logName} key face failed: ${this.logText(error)}`
      );
      return null;
    }
  }

  private clearCycleTimer(id: string) {
    const timer = this.cycleTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.cycleTimers.delete(id);
  }

  /** Drops press-rotation pages whose id passes the test, timers included. */
  private forgetCycles(test: (id: string) => boolean) {
    for (const id of [...this.cycleTimers.keys()]) {
      if (test(id)) this.clearCycleTimer(id);
    }
    this.pager.close(test);
  }

  /** The open press page, or null for the resting meter. */
  private cyclePage(serialNumber: string, key: Key): UsagePressPage | null {
    if (!this.source.pressPages || !this.metrics) return null;
    const id = `${serialNumber}#${key?.uid}`;
    const index = this.pager.pageOf(id, Date.now());
    if (index === null) return null;
    let pages: UsagePressPage[] | null;
    try {
      pages = this.source.pressPages(this.metrics, langOf(key?.data?.lang));
    } catch {
      return null;
    }
    if (!pages || pages.length === 0) return null;
    return pages[Math.min(index, pages.length - 1)] ?? null;
  }

  /**
   * Advances the press rotation and arms the return-to-resting timer.
   * No pages: the key stays on its resting meter.
   */
  private rotatePress(serialNumber: string, key: Key) {
    if (!this.source.pressPages || !this.metrics) return;
    const lang = langOf(key?.data?.lang);
    let pages: UsagePressPage[] | null;
    try {
      pages = this.source.pressPages(this.metrics, lang);
    } catch {
      return;
    }
    if (!pages || pages.length === 0) return;
    const id = `${serialNumber}#${key?.uid}`;
    const page = this.pager.press(id, Date.now(), pages.length);
    this.clearCycleTimer(id);
    if (page === null) return;
    const timer = setTimeout(() => {
      this.cycleTimers.delete(id);
      void this.drawAll();
    }, LIST_TIMEOUT_MS + 50);
    if (timer.unref) timer.unref();
    this.cycleTimers.set(id, timer);
  }

  /** The open press page, drawn as a message or as one remaining limit. */
  private async renderCycle(
    serialNumber: string,
    key: Key,
    width: number,
    message: MessageOptions
  ): Promise<string | null> {
    const page = this.cyclePage(serialNumber, key);
    if (!page || !this.metrics) return null;
    const data = key?.data ?? {};
    const lang = langOf(data.lang);
    if (page.text) {
      const text = lang === 'zh' ? page.text.zh : page.text.en;
      return renderMessageKey(width, text.title, text.message, message);
    }
    if (!page.metricId) return null;
    const snapshot = this.metrics.find(metric => metric.id === page.metricId);
    if (!snapshot) {
      const missing = this.missingText(page.metricId, lang);
      const text = TEXT[lang];
      return missing
        ? renderMessageKey(width, missing.title, missing.message, message)
        : renderMessageKey(width, this.brand.productName, text.noData, message);
    }
    if (this.source.pressFace && (page.group || page.window)) {
      try {
        const image = await this.source.pressFace({
          page,
          width,
          snapshot,
          showResetTime: data.showResetTime !== false,
          bgColor: this.deps.bgColor(key),
          lang,
          data,
        });
        if (image) return image;
      } catch (error) {
        this.deps.logger?.warn?.(
          `${this.logName} press face failed: ${this.logText(error)}`
        );
      }
    }
    const label = page.label
      ? lang === 'zh'
        ? page.label.zh
        : page.label.en
      : this.metricLabel(snapshot, lang);
    const marks = markOptions(this.brand, data);
    return renderUsageKey(
      width,
      { ...snapshot, label },
      {
        showResetTime: data.showResetTime !== false,
        shown: page.shown === 'remaining' ? 'remaining' : 'used',
        ...marks,
        bgColor: this.deps.bgColor(key),
        ...(lang === 'zh' ? { lang } : {}),
        // A group name such as "Gemini 4 Argon" must keep its version.
        // dropVersion would turn it into "Argon".
        ...(page.group || this.brand.mark === 'clawd'
          ? {}
          : { dropVersion: true }),
      }
    );
  }

  private async renderKey(serialNumber: string, key: Key): Promise<string> {
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
      const cycle = await this.renderCycle(serialNumber, key, width, message);
      if (cycle) return cycle;
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
        this.noteSubstitute(serialNumber, key?.uid, metric, null);
        return 'image' in face
          ? face.image
          : renderMessageKey(
              width,
              face.text.title,
              face.text.message,
              message
            );
      }
      // the meter of one metric, with that metric's own chip text
      const meter = (snapshot: UsageMetric) =>
        renderUsageKey(
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
      const snapshot = this.metrics.find(m => m.id === metric);
      // a limit the plan does not have: the source may name one to show
      const stand = snapshot ? null : this.substitute(metric, this.metrics);
      this.noteSubstitute(serialNumber, key?.uid, metric, stand?.id ?? null);
      const shown = snapshot ?? stand;
      if (shown) return meter(shown);
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
      await this.deps.send(
        serialNumber,
        key,
        await this.renderKey(serialNumber, key)
      );
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

  /**
   * Fetches (at most one request at a time) and redraws. A settings save
   * that arrives while a fetch is already using the previous settings
   * waits for that fetch and then runs another.
   */
  refresh(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
      });
      return this.inFlight;
    }
    if (!this.bypassGap) return this.inFlight;
    return this.inFlight.then(() => {
      if (!this.bypassGap) return undefined;
      return this.refresh();
    });
  }

  private async doRefresh() {
    const forced = this.bypassGap;
    this.bypassGap = false;
    const now = Date.now();
    if (this.lockedUntil && now < this.lockedUntil) {
      await this.drawAll();
      return;
    }
    if (!forced && now - this.lastFetchAt < this.minFetchGapMs()) return;
    if (!this.hasKeys()) return;
    this.lastFetchAt = now;

    const pending = this.pendingConfig;
    if (pending) this.pendingConfig = null;
    const config =
      pending ?? (await this.deps.loadConfig().catch(() => null)) ?? {};
    this.appliedFingerprint = configFingerprint(config);
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
