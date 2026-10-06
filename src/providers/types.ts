/**
 * Contracts between the generic key groups (usage meter, session status and
 * new session keys: src/usageKey.ts, src/sessionKey.ts, src/newSessionKey.ts)
 * and the AI providers that feed them (src/providers/<id>/). A provider
 * supplies a usage source, a session provider and a new-session launcher;
 * the key groups own polling, drawing, presses and the redraw queue.
 *
 * Types only, plus nothing at runtime: helpers live in ./kit.ts.
 */
import type { SKRSContext2D } from '@napi-rs/canvas';

import type { RunningSession, SessionState, SessionStatus } from '../session';
import type { Lang } from '../sessionView';

export type { Lang, RunningSession, SessionState, SessionStatus };

export type ProviderId = 'claude' | 'kimi' | 'gemini';

/** The three key types every provider has. */
export type KeyKind = 'usage' | 'session' | 'newsession';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A key as FlexDesigner sends it: { uid, cid, width, style, data, … } */
export type Key = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A key's settings (key.data), as its settings page stores them. */
export type KeyData = Record<string, unknown>;

/**
 * Global plugin settings (ui/global_config.vue). Providers read their own
 * optional fields; unknown fields are passed through untouched.
 */
export type PluginConfig = {
  /** Claude Code credentials file override */
  credentialsPath?: string;
  /** Usage refresh interval in seconds (all providers) */
  pollInterval?: number;
  /** Claude Code config folder (default ~/.claude) */
  claudeDir?: string;
  /** Kimi Code home override (default $KIMI_CODE_HOME or ~/.kimi-code) */
  kimiDir?: string;
  /** Kimi desktop app data folder override (default: the app's userData) */
  kimiDesktopDir?: string;
  /** Let the Kimi usage key refresh an expired Kimi Code login (default on) */
  kimiRefreshLogin?: boolean;
  /** Gemini CLI home override (default $GEMINI_CLI_HOME/.gemini or ~/.gemini) */
  geminiDir?: string;
  /** Gemini CLI program (default: found on PATH and common install folders) */
  geminiPath?: string;
  /**
   * Google Cloud project for Gemini Code Assist Standard/Enterprise quota
   * (default: $GOOGLE_CLOUD_PROJECT or $GOOGLE_CLOUD_PROJECT_ID)
   */
  geminiCloudProject?: string;
  [key: string]: unknown;
};

export type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

/** A text in both key-face languages. */
export type Localized = { en: string; zh: string };

/** Title and message of a message key face (errors, loading, notices). */
export type KeyText = { title: string; message: string };

// --- provider identity ---------------------------------------------------------

/**
 * A provider mark drawn with canvas primitives into a square box whose top
 * left corner is (x, y). Must not change the context's state for the caller
 * (wrap in save()/restore()), and must not load images or fonts.
 */
export type KeyMark = {
  draw(ctx: SKRSContext2D, x: number, y: number, size: number): void;
};

export type Brand = {
  /** Short name, e.g. "Claude", "Kimi", "Gemini" */
  name: string;
  /** Product named on key faces, e.g. "Claude Code", "Kimi CLI" */
  productName: string;
  /** Accent colour: message-face titles and the New Session icon */
  accent: string;
  /**
   * 'clawd' (Claude only): the Clawd artwork, behind the key's `showClawd`
   * setting (off by default). A KeyMark is behind `showMark` (on by default).
   */
  mark: KeyMark | 'clawd';
};

// --- usage meter -------------------------------------------------------------

/** One usage limit, e.g. { id: 'session', label: 'Session', percent: 42 } */
export type UsageMetric = {
  /** Stable id stored in the key's `metric` setting */
  id: string;
  /** Chip text on the key face; keep it short ("Session", "Weekly") */
  label: string;
  /** 0–100, rounded */
  percent: number;
  /** ISO time the limit resets, or null */
  resetsAt: string | null;
  /**
   * Short chip text for keys too narrow for the label ("5h", "7d"); without
   * one, the label is shortened
   */
  tag?: string;
};

/** What UsageKeys passes to a source's own key face (UsageSource.face). */
export type UsageFaceRequest = {
  /** The metric the key shows: its `metric` setting or the default */
  metric: string;
  /** Every metric of the last successful fetch */
  metrics: UsageMetric[];
  /** Key width in pixels */
  width: number;
  /** The key's "Show time until reset" setting (on unless turned off) */
  showResetTime: boolean;
  /** The key's own background colour, if it has one */
  bgColor?: string;
  lang: Lang;
  /** The key's settings (key.data) */
  data: KeyData;
};

/**
 * A key face a source draws itself: an image (base64 PNG data URL), or a
 * message face drawn like "No data for this limit".
 */
export type UsageFace = { image: string } | { text: KeyText };

/** Reply to the settings UI ('usage-status', 'test-connection'). */
export type UsageDescription = {
  success: boolean;
  /** Log-safe error text (never credentials) */
  error?: string;
  metrics?: UsageMetric[];
  [key: string]: unknown;
};

export interface UsageSource {
  /**
   * Fetches every limit the provider reports. Throws on failure, preferably
   * a ProviderError (./kit.ts) so the key shows a fitting short text. Must
   * never log or throw credentials.
   */
  fetch(config: PluginConfig): Promise<UsageMetric[]>;
  /**
   * Metric id a key shows while its `metric` setting is empty; '' shows the
   * first metric fetch() returned.
   */
  defaultMetric: string;
  /** Key-face text for an error from fetch() (default: errorKeyText) */
  errorText?(error: unknown, lang: Lang): KeyText;
  /**
   * Key-face text for a key whose metric the last fetch did not return, or
   * null for the generic "No data for this limit".
   */
  missingText?(metricId: string, lang: Lang): KeyText | null;
  /** Error text for the log and the settings UI (default: safeErrorMessage) */
  logText?(error: unknown): string;
  /** Chip text of a metric in a key language (default: metric.label) */
  metricLabel?(metric: UsageMetric, lang: Lang): string;
  /**
   * The key face for a `metric` setting that is a view of several metrics
   * rather than one (Claude's 'dual': what is left of the 5-hour and weekly
   * limits on one key), or null to draw the single meter as usual. Only
   * called while there are metrics from the last fetch; errors, loading and
   * rate-limit faces stay generic. A face that throws is logged and treated
   * as null.
   */
  face?(
    request: UsageFaceRequest
  ): UsageFace | null | Promise<UsageFace | null>;
  /**
   * Seconds to stop fetching after this error (a rate limit), or null to
   * retry at the next poll (default: ProviderError 'rate-limited' → its
   * retryAfterSeconds or 300).
   */
  lockoutSeconds?(error: unknown): number | null;
  /** Shortest gap between two fetches in ms (default 30 000) */
  minFetchGapMs?: number;
  /**
   * True to keep showing the last metrics after this error (e.g. a network
   * blip) instead of the error face (default: false, like Claude).
   */
  keepLastOnError?(error: unknown): boolean;
  /**
   * Settings UI reply (default: fetch and list the metrics). `data` is the
   * key's settings when its page sends them (`settings` in the message).
   */
  describe?(config: PluginConfig, data?: KeyData): Promise<UsageDescription>;
}

// --- session status ------------------------------------------------------------

/** What a key with a filter shows: the chosen session and how many others are active. */
export type SessionPick = {
  status: SessionStatus | null;
  /** Other sessions (same filter) that are working or need the user */
  others: number;
};

/**
 * Shown on the key instead of "No sessions" when the provider is unavailable.
 * `tone` colours the label and edge (default 'idle', grey).
 */
export type SessionNotice = {
  label: Localized;
  text: Localized;
  tone?: 'idle' | 'error';
};

export type SessionSourceOptions = {
  /** provider.location(config), resolved once per source */
  location: string;
  config: PluginConfig;
  /**
   * Call after every refresh (at least once after start(), also when
   * nothing was found): keys show "Loading…" until the first call.
   */
  onChange: () => void;
  logger?: Logger | null;
};

/**
 * A running watch over one provider's sessions (one per provider, shared by
 * all its keys). Read-only: never write to the provider's files.
 */
export interface SessionSource {
  /** Starts timers/watchers; the first scan must end with onChange(). */
  start(): void;
  /** Stops every timer and watcher; no onChange() afterwards. */
  stop(): void;
  /** Scans now (key press); resolves when done. */
  rescan(): Promise<void>;
  /** Project filters of the alive keys ('' = all projects). */
  setFilters(filters: string[]): void;
  /** Largest idle threshold of the alive keys, in ms (running-list window). */
  setRunningWindow(ms: number): void;
  /**
   * The session a key with this filter shows at `now`. `data` is the key's
   * settings (key.data) for provider-specific options; Claude ignores it.
   */
  getStatus(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): SessionPick;
  /**
   * Running sessions for the press list, ordered (sortRunning). Only
   * status.title / status.project, group and at are used; build entries
   * with runningItem() (./kit.ts) when there is no full status.
   */
  listRunning(
    filter: string,
    now: number,
    idleMs: number,
    data?: KeyData
  ): RunningSession[];
  /**
   * Why there is nothing to show (not installed, not set up), or null.
   * `data` is the settings of the key asking (key.data).
   */
  notice?(data?: KeyData): SessionNotice | null;
  /**
   * The product a key with these settings follows, named on its "Loading…"
   * and "No sessions · Start …" faces (default: the brand's productName).
   */
  productName?(data?: KeyData): string;
}

/** Reply to the settings UI ('session-status'). */
export type SessionDescription = {
  success: boolean;
  /** Where sessions are read from, for the "none found in …" hint */
  projectsDir: string | null;
  state: SessionState | null;
  project: string | null;
  title: string | null;
  others: number;
  notice?: SessionNotice | null;
};

export interface SessionProvider {
  /**
   * Where sessions are read from under this config (e.g. a folder). Keys
   * restart the source when it changes after a config update.
   */
  location(config: PluginConfig): string;
  /** A new source; nothing may run before start(). */
  create(options: SessionSourceOptions): SessionSource;
  /** What the log names as watched for a location (default: the location) */
  watched?(location: string): string;
  /**
   * What a key with this filter would show now (one-off scan). `data` is
   * the key's settings when its page sends them (`settings` in the message).
   */
  describe(
    filter: string,
    config: PluginConfig,
    data?: KeyData
  ): Promise<SessionDescription>;
}

// --- new session -------------------------------------------------------------

/** ready: the normal face; opening / error: brief feedback after a press. */
export type NewSessionState = 'ready' | 'opening' | 'error';

/**
 * What a press opens. 'url' goes to the system URL opener, 'command' runs a
 * program directly, 'terminal' opens a terminal window running `command` in
 * `cwd`. All of them go through execFile, never through a shell.
 */
export type LaunchTarget =
  | { kind: 'url'; url: string }
  | { kind: 'command'; file: string; args: string[]; cwd?: string }
  | { kind: 'terminal'; command: string[]; cwd: string | null };

export type NewSessionRequest = {
  /** The key's settings as stored (key.data) */
  data: Record<string, unknown>;
  /** The folder setting as typed ('' when not set) */
  rawFolder: string;
  /** The folder setting resolved to an absolute path (~ expanded), or null */
  folder: string | null;
  /** Home folder used for ~ (tests pass a fake one) */
  home: string | undefined;
  platform: NodeJS.Platform;
  /** The global plugin settings ({} when they could not be loaded) */
  config?: PluginConfig;
};

export interface NewSessionLauncher {
  /** Named in log lines, e.g. "the Claude app" */
  appName: string;
  /**
   * Key-face titles per state; missing ones default to "New Session",
   * "Opening…" and "<name> not available".
   */
  strings?: Partial<Record<NewSessionState, Localized>>;
  /**
   * True when target() reads request.config: a press then loads the global
   * settings first (briefly; {} when they do not come). Claude's launcher
   * needs none, so its press never waits for them.
   */
  needsConfig?: boolean;
  /**
   * The line under the title (ready and opening faces) for a key with these
   * settings; default: the folder setting's last segment. Return null for
   * none, e.g. for a target that takes no folder.
   */
  subtitle?(
    data: Record<string, unknown>,
    folderName: string | null,
    lang: Lang
  ): string | null;
  /**
   * The target for a press; throw when it cannot open. A ProviderError with
   * `extra.keyText` shows that title on the error face instead of the
   * generic one.
   */
  target(request: NewSessionRequest): LaunchTarget | Promise<LaunchTarget>;
}

// --- registry ----------------------------------------------------------------

/** Everything a provider plugs in; see src/providers/<id>/index.ts. */
export type ProviderDef = {
  id: ProviderId;
  brand: Brand;
  usage: UsageSource;
  session: SessionProvider;
  newSession: NewSessionLauncher;
};

/** A message from a key's or the global settings page (sendToBackend). */
export type UiMessage = {
  /** Message type: 'usage-status', 'test-connection', 'session-status' */
  data?: unknown;
  /** Key the message is about; legacy Claude messages have none */
  cid?: unknown;
  /** The key's settings (modelValue.data), sent by the provider pages */
  settings?: unknown;
  [key: string]: unknown;
};

/** Drawing hooks plugin.ts gives every key group. */
export type KeyHost = {
  /** Runs a draw after every draw queued before it */
  enqueue: (task: () => Promise<void>) => Promise<void>;
  /** Sends a rendered image to a key; may reject */
  send: (serialNumber: string, key: Key, image: string) => Promise<void>;
  isOffline: (serialNumber: string) => boolean;
  keyWidth: (key: Key) => number;
  bgColor: (key: Key) => string | undefined;
  loadConfig: () => Promise<PluginConfig | null | undefined>;
  logger?: Logger | null;
};

/** The keys of one cid; plugin.ts routes FlexDesigner events to it. */
export interface KeyGroup {
  readonly cid: string;
  /** plugin.alive: the device's current plugin keys (any cid). */
  alive(serialNumber: string, keys: Key[]): Promise<void>;
  /** plugin.dead: keys that left the device page (all when none listed). */
  dead(serialNumber: string, keys: Key[]): Promise<void>;
  /** plugin.data: a press on one of this group's keys. */
  press(serialNumber: string, key: Key): Promise<unknown>;
  /** ui.message for this cid; undefined when not handled. */
  message(payload: UiMessage): Promise<unknown>;
  /** plugin.config.updated */
  configure(config: PluginConfig): Promise<void>;
}
