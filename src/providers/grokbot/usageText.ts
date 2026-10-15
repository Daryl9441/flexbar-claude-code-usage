/**
 * Key-face and settings-page texts for Grok Bot usage. The weekly percentage
 * is the only number the account reports; these say why a meter is missing.
 */
import { ProviderError } from '../kit';
import { KeyText, Lang } from '../types';

export type GrokbotProblem =
  | 'not-installed'
  | 'not-signed-in'
  | 'login-expired'
  | 'state-unreadable'
  | 'pooled'
  | 'no-allowance'
  | 'parse'
  | 'network'
  | 'http'
  | 'rate-limited';

const TEXT: Record<GrokbotProblem, Record<Lang, KeyText>> = {
  'not-installed': {
    en: { title: 'Not installed', message: 'Install Grok Bot' },
    zh: { title: '未安装', message: '请先安装 Grok Bot' },
  },
  'not-signed-in': {
    en: { title: 'Not logged in', message: 'Sign in to Cursor' },
    zh: { title: '未登录', message: '请登录 Cursor' },
  },
  'login-expired': {
    en: { title: 'Login expired', message: 'Sign in to Cursor' },
    zh: { title: '登录已过期', message: '请重新登录 Cursor' },
  },
  'state-unreadable': {
    en: { title: 'Cannot read login', message: 'Cursor state unreadable' },
    zh: { title: '无法读取登录', message: '读不到 Cursor 状态' },
  },
  pooled: {
    en: { title: 'Pooled plan', message: 'No per-account quota' },
    zh: { title: '共享额度', message: '没有个人额度' },
  },
  'no-allowance': {
    en: { title: 'No allowance', message: 'No Grok Bot quota' },
    zh: { title: '没有额度', message: '此账号无 Grok Bot 额度' },
  },
  parse: {
    en: { title: 'Unreadable data', message: 'Update Grok Bot?' },
    zh: { title: '无法读取数据', message: '请更新 Grok Bot' },
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

export class GrokbotUsageError extends ProviderError {
  constructor(
    readonly problem: GrokbotProblem,
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
    this.name = 'GrokbotUsageError';
  }
}

export function grokbotErrorText(error: unknown, lang: Lang): KeyText {
  if (error instanceof GrokbotUsageError) {
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
