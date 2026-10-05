/**
 * Gemini usage key: the short key-face texts (en/zh) for every problem the
 * usage source reports, the ProviderError for each, and log-safe error text
 * that also masks Google's token formats.
 */
import { redactSecrets, safeErrorMessage } from '../../redact';
import { ProviderError, ProviderErrorCode } from '../kit';
import { KeyText, Lang } from '../types';

/** Why the Gemini usage key cannot show a meter. */
export type GeminiProblem =
  /** No Gemini CLI found (and nothing to read without it) */
  | 'cli-missing'
  /** No oauth_creds.json: never logged in with Google */
  | 'logged-out'
  /** oauth_creds.json could not be read or parsed */
  | 'creds-unreadable'
  /** Refresh rejected (invalid_grant) or 401 after a forced refresh */
  | 'login-expired'
  /** Personal Google account: Code Assist for individuals ended 2026-06-18 */
  | 'personal-unsupported'
  /** Any other ineligible tier reason */
  | 'not-eligible'
  /** UNSUPPORTED_LOCATION / UNKNOWN_LOCATION */
  | 'region'
  /** VALIDATION_REQUIRED: the CLI asks the user to verify the account */
  | 'verify-account'
  /** Gemini API key login: the API has no quota endpoint */
  | 'api-key'
  /** Vertex AI login: no quota endpoint */
  | 'vertex'
  /** Cloud Shell, ADC, gateway or an unknown login type */
  | 'other-auth'
  /** Standard/Enterprise tier that needs a Google Cloud project */
  | 'needs-project'
  /** The project was refused (HTTP 403/404) */
  | 'project-denied'
  /** Not onboarded yet: the CLI has never been run with this login */
  | 'needs-setup'
  /** The quota answer listed no model */
  | 'no-quota';

type Texts = Record<Lang, KeyText>;

const TEXTS: Record<GeminiProblem, Texts> = {
  'cli-missing': {
    en: { title: 'Not installed', message: 'Gemini CLI not found' },
    zh: { title: '未安装', message: '未找到 Gemini CLI' },
  },
  'logged-out': {
    en: { title: 'Not logged in', message: 'Run gemini to log in' },
    zh: { title: '未登录', message: '请先登录 gemini' },
  },
  'creds-unreadable': {
    en: { title: 'Login unreadable', message: 'Run gemini to log in' },
    zh: { title: '无法读取登录', message: '请运行 gemini 重新登录' },
  },
  'login-expired': {
    en: { title: 'Login expired', message: 'Run gemini to log in' },
    zh: { title: '登录已过期', message: '请运行 gemini 重新登录' },
  },
  'personal-unsupported': {
    en: { title: 'Not supported', message: 'Personal login unsupported' },
    zh: { title: '不支持', message: '个人账号已不支持' },
  },
  'not-eligible': {
    en: { title: 'Not supported', message: 'Account not eligible' },
    zh: { title: '不支持', message: '账号不符合条件' },
  },
  region: {
    en: { title: 'Not supported', message: 'Region not supported' },
    zh: { title: '不支持', message: '所在地区不支持' },
  },
  'verify-account': {
    en: { title: 'Verify account', message: 'Run gemini to verify' },
    zh: { title: '需要验证账号', message: '请运行 gemini 验证' },
  },
  'api-key': {
    en: { title: 'No quota', message: 'API key login' },
    zh: { title: '无配额信息', message: 'API Key 登录' },
  },
  vertex: {
    en: { title: 'No quota', message: 'Vertex AI login' },
    zh: { title: '无配额信息', message: 'Vertex AI 登录' },
  },
  'other-auth': {
    en: { title: 'Not supported', message: 'Use Login with Google' },
    zh: { title: '不支持', message: '请使用 Google 登录' },
  },
  'needs-project': {
    en: { title: 'No project', message: 'Set Cloud project in settings' },
    zh: { title: '缺少项目', message: '请在插件设置中填写 Cloud 项目' },
  },
  'project-denied': {
    en: { title: 'No access', message: 'Check Cloud project' },
    zh: { title: '无权访问', message: '请检查 Cloud 项目' },
  },
  'needs-setup': {
    en: { title: 'Not set up', message: 'Run gemini once' },
    zh: { title: '未设置', message: '请先运行一次 gemini' },
  },
  'no-quota': {
    en: { title: 'No quota data', message: 'None reported yet' },
    zh: { title: '无配额数据', message: '暂未返回配额' },
  },
};

const CODES: Record<GeminiProblem, ProviderErrorCode> = {
  'cli-missing': 'not-installed',
  'logged-out': 'no-credentials',
  'creds-unreadable': 'parse',
  'login-expired': 'unauthorized',
  'personal-unsupported': 'unsupported',
  'not-eligible': 'unsupported',
  region: 'unsupported',
  'verify-account': 'not-configured',
  'api-key': 'unsupported',
  vertex: 'unsupported',
  'other-auth': 'unsupported',
  'needs-project': 'not-configured',
  'project-denied': 'not-configured',
  'needs-setup': 'not-configured',
  'no-quota': 'unsupported',
};

/** Key-face texts of a problem, in both languages. */
export function problemText(problem: GeminiProblem): Texts {
  return TEXTS[problem];
}

/** A ProviderError for a problem; `message` goes to the log and settings UI. */
export class GeminiUsageError extends ProviderError {
  constructor(
    readonly problem: GeminiProblem,
    message: string
  ) {
    super(CODES[problem], message, { keyText: TEXTS[problem] });
    this.name = 'GeminiUsageError';
  }
}

// Google credential formats safeErrorMessage does not know: OAuth access
// tokens, refresh tokens, installed-app client secrets and client ids
const GOOGLE_SECRETS: RegExp[] = [
  /\bya29\.[\w.-]+/g,
  /(?<![\w/])1\/\/[\w.-]+/g,
  /\bGOCSPX-[\w-]+/g,
  /\b\d+-[a-z0-9]+\.apps\.googleusercontent\.com\b/g,
];

/** Masks Google tokens, client secrets and client ids in a text. */
export function redactGoogle(text: string): string {
  let out = text;
  for (const pattern of GOOGLE_SECRETS)
    out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * Credential-free error text for the log and the settings UI: our own
 * messages as they are, anything else through safeErrorMessage, then with
 * Google's token formats masked and cut to `max` characters.
 */
export function geminiErrorText(error: unknown, max = 240): string {
  const text =
    error instanceof ProviderError
      ? redactSecrets(error.message)
      : safeErrorMessage(error, 100_000);
  const safe = redactGoogle(text);
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
}
