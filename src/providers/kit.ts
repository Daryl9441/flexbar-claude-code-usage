/**
 * Runtime helpers shared by the key groups and the providers: key ids,
 * folder settings, the provider error type and its key-face texts, mark
 * settings, and builders for session statuses, running-list entries and
 * notices. Pure (no fs, no canvas, no network).
 */
import os from 'node:os';
import path from 'node:path';

import { safeErrorMessage } from '../redact';
import { RunningGroup, runningGroup } from '../session';
import { ViewTone } from '../sessionView';

import {
  Brand,
  KeyKind,
  KeyMark,
  KeyText,
  Lang,
  Localized,
  ProviderId,
  RunningSession,
  SessionNotice,
  SessionPick,
  SessionSource,
  SessionSourceOptions,
  SessionState,
  SessionStatus,
} from './types';

export const PLUGIN_UUID = 'dev.sese.flexbar_claude_code_usage';

/**
 * The cid of a provider's key. Claude keeps the original ids (`….usage`,
 * `….session`, `….newsession`); others are `….<provider>_<kind>`.
 */
export function keyCid(provider: ProviderId, kind: KeyKind): string {
  return provider === 'claude'
    ? `${PLUGIN_UUID}.${kind}`
    : `${PLUGIN_UUID}.${provider}_${kind}`;
}

export function pick(text: Localized | string, lang: Lang): string {
  return typeof text === 'string' ? text : text[lang];
}

// --- folders -------------------------------------------------------------------

/** `~` expansion for user-entered paths (quotes around a pasted path dropped). */
export function expandHome(input: string, home: string = os.homedir()): string {
  let p = input.trim();
  if (/^(["']).+\1$/.test(p)) p = p.slice(1, -1).trim();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\'))
    return path.join(home, p.slice(2));
  return p;
}

/**
 * A folder setting: the user's override (absolute, ~ expanded), else the
 * environment variable's value, else the fallback. Empty strings count as
 * not set.
 */
export function resolveDir(
  override: unknown,
  envValue: string | undefined,
  fallback: string,
  home: string = os.homedir()
): string {
  for (const value of [override, envValue]) {
    if (typeof value === 'string' && value.trim()) {
      return path.resolve(home, expandHome(value, home));
    }
  }
  return fallback;
}

// --- errors ------------------------------------------------------------------

export type ProviderErrorCode =
  /** The provider's CLI/app/data folder is not on this computer */
  | 'not-installed'
  /** Installed, but not usable yet (no login, feature not available) */
  | 'not-configured'
  /** This account or login type has no such data (e.g. no quota endpoint) */
  | 'unsupported'
  /** No credentials found */
  | 'no-credentials'
  /** Credentials rejected or expired */
  | 'unauthorized'
  /** Too many requests; see retryAfterSeconds */
  | 'rate-limited'
  /** Unexpected HTTP status; put "HTTP <code>" in the message */
  | 'http'
  | 'network'
  /** A response or file that could not be understood */
  | 'parse';

/**
 * A provider failure with a code the key faces understand. The message goes
 * to the log and the settings UI: never put credentials or file contents in
 * it (paths are fine in the log, not on the key).
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly extra: {
      /** Seconds until a rate limit lifts */
      retryAfterSeconds?: number;
      /** Custom key-face text instead of the default for the code */
      keyText?: KeyText | Record<Lang, KeyText>;
    } = {}
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryAfterSeconds(): number | undefined {
    return this.extra.retryAfterSeconds;
  }
}

type KeyTexts = Record<
  Exclude<ProviderErrorCode, 'http'>,
  (product: string) => KeyText
>;

const ERROR_TEXT: Record<Lang, KeyTexts> = {
  en: {
    'not-installed': p => ({ title: 'Not installed', message: `Install ${p}` }),
    'not-configured': p => ({
      title: 'Not set up',
      message: `${p} is not set up`,
    }),
    'no-credentials': p => ({
      title: 'Not logged in',
      message: `Log in to ${p}`,
    }),
    unauthorized: p => ({ title: 'Login expired', message: `Log in to ${p}` }),
    'rate-limited': () => ({
      title: 'Rate limited',
      message: 'Retrying later',
    }),
    network: () => ({
      title: 'Network error',
      message: 'Check your connection',
    }),
    parse: p => ({ title: 'Unreadable data', message: `Update ${p}?` }),
    unsupported: p => ({
      title: 'Not supported',
      message: `No usage data from ${p}`,
    }),
  },
  zh: {
    'not-installed': p => ({ title: '未安装', message: `请先安装 ${p}` }),
    'not-configured': p => ({ title: '未设置', message: `${p} 尚未设置` }),
    'no-credentials': p => ({ title: '未登录', message: `请登录 ${p}` }),
    unauthorized: p => ({ title: '登录已过期', message: `请重新登录 ${p}` }),
    'rate-limited': () => ({ title: '请求受限', message: '稍后自动重试' }),
    network: () => ({ title: '网络错误', message: '请检查网络连接' }),
    parse: p => ({ title: '无法读取数据', message: `请更新 ${p}` }),
    unsupported: p => ({ title: '不支持', message: `${p} 不提供用量数据` }),
  },
};

/**
 * Default short key-face text for a usage error: by ProviderError code, or
 * the product name and a credential-free error message.
 */
export function errorKeyText(
  error: unknown,
  brand: Pick<Brand, 'productName'>,
  lang: Lang = 'en'
): KeyText {
  if (error instanceof ProviderError) {
    const custom = error.extra.keyText;
    if (custom) return 'title' in custom ? custom : custom[lang];
    if (error.code === 'http') {
      return {
        title: lang === 'zh' ? '用量请求失败' : 'Usage error',
        message: error.message.match(/HTTP \d+/)?.[0] ?? error.message,
      };
    }
    return ERROR_TEXT[lang][error.code](brand.productName);
  }
  return { title: brand.productName, message: safeErrorMessage(error) };
}

/** Fallback lockout when a rate limit comes without a retry time */
export const DEFAULT_LOCKOUT_SECONDS = 300;

/** Default UsageSource.lockoutSeconds: ProviderError 'rate-limited' only. */
export function lockoutSeconds(error: unknown): number | null {
  if (error instanceof ProviderError && error.code === 'rate-limited') {
    return error.retryAfterSeconds ?? DEFAULT_LOCKOUT_SECONDS;
  }
  return null;
}

// --- identity ----------------------------------------------------------------

/**
 * The render options for a key's provider mark: Clawd behind `showClawd`
 * (off unless true), any other mark behind `showMark` (on unless false).
 */
export function markOptions(
  brand: Brand,
  data: Record<string, unknown> | null | undefined
): { showClawd: boolean; mark?: KeyMark } {
  if (brand.mark === 'clawd') return { showClawd: data?.showClawd === true };
  return data?.showMark === false
    ? { showClawd: false }
    : { showClawd: false, mark: brand.mark };
}

/** The mark on message faces: none for Claude (keeps its look). */
export function brandMark(brand: Brand): KeyMark | undefined {
  return brand.mark === 'clawd' ? undefined : brand.mark;
}

// --- sessions ----------------------------------------------------------------

/** A SessionStatus with every field not given set to "unknown". */
export function makeStatus(
  fields: Partial<SessionStatus> & { state: SessionState }
): SessionStatus {
  return {
    confident: true,
    hasQuestion: false,
    question: null,
    options: [],
    detail: null,
    tool: null,
    progress: null,
    title: null,
    project: null,
    branch: null,
    sessionId: null,
    lastActivity: null,
    turnStartedAt: null,
    since: null,
    background: false,
    live: false,
    ...fields,
  };
}

const TONE_GROUP: Record<ViewTone, RunningGroup> = {
  attention: 'attention',
  working: 'working',
  error: 'stopped',
  done: 'done',
  idle: 'done',
};

const GROUP_STATE: Record<RunningGroup, SessionState> = {
  attention: 'question',
  working: 'working',
  stopped: 'interrupted',
  done: 'done',
};

/**
 * A running-list entry from just a title and a dot colour, for providers
 * without a full SessionStatus per session. Pass a full `status` instead
 * when there is one; group then follows from it.
 */
export function runningItem(item: {
  title: string | null;
  tone?: ViewTone;
  status?: SessionStatus;
  project?: string | null;
  /** Most recent activity (ms), for ordering */
  at?: number;
  sessionId?: string | null;
}): RunningSession {
  if (item.status) {
    return {
      status: item.status,
      group: runningGroup(item.status),
      at: item.at ?? item.status.lastActivity ?? 0,
    };
  }
  const group = TONE_GROUP[item.tone ?? 'done'];
  return {
    status: makeStatus({
      state: GROUP_STATE[group],
      title: item.title,
      project: item.project ?? null,
      sessionId: item.sessionId ?? null,
      lastActivity: item.at ?? null,
    }),
    group,
    at: item.at ?? 0,
  };
}

const NOTICES: Record<
  'not-installed' | 'not-configured',
  (product: string) => SessionNotice
> = {
  'not-installed': p => ({
    label: { en: 'Not installed', zh: '未安装' },
    text: { en: `Install ${p}`, zh: `请先安装 ${p}` },
  }),
  'not-configured': p => ({
    label: { en: 'Not set up', zh: '未设置' },
    text: { en: `${p} is not set up`, zh: `${p} 尚未设置` },
  }),
};

export function unavailableNotice(
  code: 'not-installed' | 'not-configured',
  brand: Pick<Brand, 'productName'>
): SessionNotice {
  return NOTICES[code](brand.productName);
}

/**
 * A source that never finds a session, optionally with a notice: for
 * providers (or setups) without session data. Reports one change after
 * start() so keys leave "Loading…".
 */
export function staticSessionSource(
  options: Pick<SessionSourceOptions, 'onChange'>,
  notice: SessionNotice | null
): SessionSource {
  let stopped = true;
  const empty: SessionPick = { status: null, others: 0 };
  return {
    start() {
      stopped = false;
      setImmediate(() => {
        if (!stopped) options.onChange();
      });
    },
    stop() {
      stopped = true;
    },
    async rescan() {
      if (!stopped) options.onChange();
    },
    setFilters() {},
    setRunningWindow() {},
    getStatus: () => empty,
    listRunning: () => [],
    notice: () => notice,
  };
}
