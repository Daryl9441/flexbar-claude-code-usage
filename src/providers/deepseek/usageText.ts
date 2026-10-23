/**
 * Key-face texts for DeepSeek balance. The messages are fixed: they never
 * include the API key or the response body.
 */
import { ProviderError } from '../kit';
import { KeyText, Lang } from '../types';

export type DeepseekProblem =
  | 'no-key'
  | 'unauthorized'
  | 'rate-limited'
  | 'network'
  | 'http'
  | 'parse'
  | 'empty';

const TEXT: Record<DeepseekProblem, Record<Lang, KeyText>> = {
  'no-key': {
    en: { title: 'API key needed', message: 'Plugin settings' },
    zh: { title: '需要 API 密钥', message: '请填写插件设置' },
  },
  unauthorized: {
    en: { title: 'API key rejected', message: 'Check the key' },
    zh: { title: '密钥被拒绝', message: '请检查 API 密钥' },
  },
  'rate-limited': {
    en: { title: 'Rate limited', message: 'Retrying later' },
    zh: { title: '请求受限', message: '稍后自动重试' },
  },
  network: {
    en: { title: 'Network error', message: 'Check your connection' },
    zh: { title: '网络错误', message: '请检查网络连接' },
  },
  http: {
    en: { title: 'Balance error', message: 'Balance request failed' },
    zh: { title: '余额请求失败', message: '余额请求失败' },
  },
  parse: {
    en: { title: 'Unreadable data', message: 'Try again later' },
    zh: { title: '无法读取数据', message: '请稍后再试' },
  },
  empty: {
    en: { title: 'No balance', message: 'No currency reported' },
    zh: { title: '没有余额', message: '未返回币种' },
  },
};

const CODE = {
  'no-key': 'no-credentials',
  unauthorized: 'unauthorized',
  'rate-limited': 'rate-limited',
  network: 'network',
  http: 'http',
  parse: 'parse',
  empty: 'unsupported',
} as const;

export class DeepseekUsageError extends ProviderError {
  constructor(
    readonly problem: DeepseekProblem,
    message: string,
    extra: { retryAfterSeconds?: number } = {}
  ) {
    super(CODE[problem], message, {
      ...extra,
      keyText: TEXT[problem],
    });
    this.name = 'DeepseekUsageError';
  }
}

export function deepseekErrorText(error: unknown, lang: Lang): KeyText {
  if (error instanceof DeepseekUsageError) {
    const text = TEXT[error.problem][lang];
    if (error.problem === 'http') {
      const status = error.message.match(/HTTP \d+/)?.[0];
      return status ? { title: text.title, message: status } : text;
    }
    return text;
  }
  return TEXT.parse[lang];
}
