/**
 * Key-face and settings-page texts for Cursor usage. The included-plan
 * percentage is the number the dashboard leads with; these say why a meter
 * is missing.
 */
import { ProviderError } from '../kit';
import { KeyText, Lang } from '../types';

export type CursorProblem =
  | 'not-installed'
  | 'not-signed-in'
  | 'login-expired'
  | 'keychain-blocked'
  | 'login-unreadable'
  | 'state-unreadable'
  | 'pooled'
  | 'no-allowance'
  | 'parse'
  | 'network'
  | 'http'
  | 'rate-limited';

const TEXT: Record<CursorProblem, Record<Lang, KeyText>> = {
  'not-installed': {
    en: { title: 'Not installed', message: 'Install Cursor' },
    zh: { title: '未安装', message: '请先安装 Cursor' },
  },
  'not-signed-in': {
    en: { title: 'Not logged in', message: 'Sign in to Cursor' },
    zh: { title: '未登录', message: '请登录 Cursor' },
  },
  'login-expired': {
    en: { title: 'Login expired', message: 'Sign in to Cursor' },
    zh: { title: '登录已过期', message: '请重新登录 Cursor' },
  },
  'keychain-blocked': {
    en: { title: 'Keychain blocked', message: 'Allow Cursor login' },
    zh: { title: '钥匙串未允许', message: '请允许 Cursor 登录' },
  },
  'login-unreadable': {
    en: { title: 'Login unreadable', message: 'Open Cursor and sign in' },
    zh: { title: '登录无法读取', message: '请打开 Cursor 登录' },
  },
  'state-unreadable': {
    en: { title: 'Cannot read login', message: 'Cursor state unreadable' },
    zh: { title: '无法读取登录', message: '读不到 Cursor 状态' },
  },
  pooled: {
    en: { title: 'Pooled plan', message: 'No per-account percent' },
    zh: { title: '共享额度', message: '没有个人百分比' },
  },
  'no-allowance': {
    en: { title: 'No allowance', message: 'No included usage' },
    zh: { title: '没有额度', message: '没有包含用量' },
  },
  parse: {
    en: { title: 'Unreadable data', message: 'Update Cursor?' },
    zh: { title: '无法读取数据', message: '请更新 Cursor' },
  },
  network: {
    en: { title: 'Network error', message: 'Check your connection' },
    zh: { title: '网络错误', message: '请检查网络连接' },
  },
  http: {
    en: { title: 'Usage error', message: 'Usage request failed' },
    zh: { title: '用量请求失败', message: '用量请求失败' },
  },
  'rate-limited': {
    en: { title: 'Rate limited', message: 'Retrying later' },
    zh: { title: '请求受限', message: '稍后自动重试' },
  },
};

export class CursorUsageError extends ProviderError {
  constructor(
    readonly problem: CursorProblem,
    message: string,
    extra: { retryAfterSeconds?: number } = {}
  ) {
    const code =
      problem === 'not-installed'
        ? 'not-installed'
        : problem === 'not-signed-in'
          ? 'no-credentials'
          : problem === 'login-expired'
            ? 'unauthorized'
            : problem === 'keychain-blocked'
              ? 'not-configured'
              : problem === 'login-unreadable'
                ? 'unauthorized'
                : problem === 'state-unreadable'
                  ? 'not-configured'
                  : problem === 'pooled' || problem === 'no-allowance'
                    ? 'unsupported'
                    : problem === 'parse'
                      ? 'parse'
                      : problem === 'network'
                        ? 'network'
                        : problem === 'rate-limited'
                          ? 'rate-limited'
                          : 'http';
    super(code, message, {
      ...extra,
      keyText: TEXT[problem],
    });
    this.name = 'CursorUsageError';
  }
}

export function cursorErrorText(error: unknown, lang: Lang): KeyText {
  if (error instanceof CursorUsageError) {
    const text = TEXT[error.problem][lang];
    if (error.problem === 'http') {
      const status = error.message.match(/HTTP \d+/)?.[0];
      return status ? { title: text.title, message: status } : text;
    }
    return text;
  }
  if (error instanceof ProviderError && error.code === 'http') {
    return {
      title: TEXT.http[lang].title,
      message: error.message.match(/HTTP \d+/)?.[0] ?? TEXT.http[lang].message,
    };
  }
  return TEXT.parse[lang];
}
