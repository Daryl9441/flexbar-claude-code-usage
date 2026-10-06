/**
 * Antigravity usage key: the short key-face texts (en/zh) for every problem
 * the usage source reports, the ProviderError for each, and log-safe error
 * text.
 */
import { redactSecrets, safeErrorMessage } from '../../redact';
import { ProviderError, ProviderErrorCode } from '../kit';
import { KeyText, Lang } from '../types';

/** Why the Antigravity usage key cannot show a meter. */
export type AntigravityProblem =
  /** No data folder, app, IDE or agy on this computer */
  | 'not-installed'
  /** Only the agy CLI: its quota is not readable from outside */
  | 'cli-only'
  /** The app or IDE is installed but not running */
  | 'not-running'
  /** The language server reports no signed-in account */
  | 'signed-out'
  /** Signed in, but the server reported no quota */
  | 'no-quota'
  /** The server's quota method is missing (an old version) */
  | 'old-version'
  /** A server is running but does not answer */
  | 'unreachable'
  /** No process lookup on this system (Windows) */
  | 'unsupported-os';

type Texts = Record<Lang, KeyText>;

const TEXTS: Record<AntigravityProblem, Texts> = {
  'not-installed': {
    en: { title: 'Not installed', message: 'Install Antigravity' },
    zh: { title: '未安装', message: '请先安装 Antigravity' },
  },
  'cli-only': {
    en: { title: 'Needs the app', message: 'Open Antigravity or its IDE' },
    zh: { title: '需要桌面应用', message: '请打开 Antigravity 或 IDE' },
  },
  'not-running': {
    en: { title: 'Not running', message: 'Open Antigravity' },
    zh: { title: '未运行', message: '请打开 Antigravity' },
  },
  'signed-out': {
    en: { title: 'Not signed in', message: 'Sign in to Antigravity' },
    zh: { title: '未登录', message: '请登录 Antigravity' },
  },
  'no-quota': {
    en: { title: 'No quota data', message: 'None reported yet' },
    zh: { title: '无配额数据', message: '暂未返回配额' },
  },
  'old-version': {
    en: { title: 'Update needed', message: 'Update Antigravity' },
    zh: { title: '需要更新', message: '请更新 Antigravity' },
  },
  unreachable: {
    en: { title: 'No answer', message: 'Antigravity not responding' },
    zh: { title: '无响应', message: 'Antigravity 未响应' },
  },
  'unsupported-os': {
    en: { title: 'Not supported', message: 'macOS and Linux only' },
    zh: { title: '不支持', message: '仅支持 macOS 和 Linux' },
  },
};

const CODES: Record<AntigravityProblem, ProviderErrorCode> = {
  'not-installed': 'not-installed',
  'cli-only': 'unsupported',
  'not-running': 'not-configured',
  'signed-out': 'no-credentials',
  'no-quota': 'unsupported',
  'old-version': 'unsupported',
  unreachable: 'network',
  'unsupported-os': 'unsupported',
};

/** Key-face texts of a problem, in both languages. */
export function problemText(problem: AntigravityProblem): Texts {
  return TEXTS[problem];
}

/** Every problem (tests, settings page). */
export const PROBLEMS = Object.keys(TEXTS) as AntigravityProblem[];

/** A ProviderError for a problem; `message` goes to the log and settings UI. */
export class AntigravityUsageError extends ProviderError {
  constructor(
    readonly problem: AntigravityProblem,
    message: string
  ) {
    super(CODES[problem], message, { keyText: TEXTS[problem] });
    this.name = 'AntigravityUsageError';
  }
}

// a token that slipped into some text: CSRF flags and header values
const LOCAL_SECRETS: RegExp[] = [
  /(--(?:extension_server_)?csrf_token[= ]+)\S+/gi,
  /(--host_bridge_token[= ]+)\S+/gi,
  /(x-codeium-csrf-token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/** Masks CSRF tokens (flags, header values) in a text. */
export function redactLocal(text: string): string {
  let out = text;
  for (const pattern of LOCAL_SECRETS)
    out = out.replace(pattern, '$1[redacted]');
  return out;
}

/**
 * Credential-free error text for the log and the settings UI: our own
 * messages as they are, anything else through safeErrorMessage, CSRF tokens
 * masked, cut to `max` characters.
 */
export function antigravityErrorText(error: unknown, max = 240): string {
  const text =
    error instanceof ProviderError
      ? redactSecrets(error.message)
      : safeErrorMessage(error, 100_000);
  const safe = redactLocal(text);
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}
