/**
 * Gemini usage key: the two read-only Gemini Code Assist calls the CLI
 * itself uses for quota (`loadCodeAssist` for the tier and Google Cloud
 * project, `retrieveUserQuota` for the per-model buckets), and how a
 * loadCodeAssist answer maps to a project or a problem. Never onboards a
 * user or changes anything on the account.
 */
import { ProviderError } from '../kit';

import { retryAfterSeconds, timeoutSignal } from './usageCreds';
import { GeminiProblem, GeminiUsageError } from './usageText';

export const CODE_ASSIST_BASE =
  'https://cloudcode-pa.googleapis.com/v1internal';

export type CodeAssistMethod = 'loadCodeAssist' | 'retrieveUserQuota';

export type GeminiTier = {
  id?: string;
  name?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
};

export type IneligibleTier = {
  reasonCode?: string;
  tierId?: string;
  validationUrl?: string;
};

export type LoadCodeAssistResponse = {
  currentTier?: GeminiTier | null;
  allowedTiers?: GeminiTier[] | null;
  ineligibleTiers?: IneligibleTier[] | null;
  cloudaicompanionProject?: string | null;
  paidTier?: GeminiTier | null;
};

export type QuotaBucket = {
  modelId?: unknown;
  remainingFraction?: unknown;
  remainingAmount?: unknown;
  resetTime?: unknown;
  tokenType?: unknown;
};

export type RetrieveUserQuotaResponse = { buckets?: QuotaBucket[] | null };

/** The project quota is read for, and the tier it belongs to. */
export type GeminiSetup = {
  project: string;
  tierId: string | null;
  tierName: string | null;
};

/** The request body loadCodeAssist gets from the CLI. */
export function loadCodeAssistBody(project: string | null) {
  return {
    ...(project ? { cloudaicompanionProject: project } : {}),
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      ...(project ? { duetProject: project } : {}),
    },
  };
}

/** The User-Agent the CLI sends, with this plugin as the surface. */
export function userAgent(version: string | null): string {
  return `GeminiCLI/${version || '0.36.0'}/gemini-2.5-pro (${process.platform}; ${process.arch}; flexbar)`;
}

/** An enum-like code from a server answer, safe to log (e.g. UNSUPPORTED_CLIENT). */
function codeOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return code || null;
}

const REGION_CODES = new Set(['UNSUPPORTED_LOCATION', 'UNKNOWN_LOCATION']);
// tiers of Gemini Code Assist for individuals (personal Google accounts)
const PERSONAL_TIERS = new Set(['free-tier', 'legacy-tier']);
const PERSONAL_CODES = new Set(['UNSUPPORTED_CLIENT', 'INELIGIBLE_ACCOUNT']);

/** The problem an ineligible-tier list stands for. */
export function ineligibleProblem(tiers: IneligibleTier[]): GeminiProblem {
  const codes = tiers.map(t => codeOf(t.reasonCode) ?? 'UNKNOWN');
  if (codes.some(code => code === 'VALIDATION_REQUIRED'))
    return 'verify-account';
  if (codes.some(code => REGION_CODES.has(code))) return 'region';
  if (
    tiers.some(t => PERSONAL_TIERS.has(`${t.tierId ?? ''}`)) ||
    codes.some(code => PERSONAL_CODES.has(code))
  ) {
    return 'personal-unsupported';
  }
  return 'not-eligible';
}

function ineligibleError(tiers: IneligibleTier[]): GeminiUsageError {
  const problem = ineligibleProblem(tiers);
  const codes = [
    ...new Set(tiers.map(t => codeOf(t.reasonCode) ?? 'UNKNOWN')),
  ].join(', ');
  const why: Record<string, string> = {
    'verify-account':
      'Google asks to verify this account first: run gemini and follow its link',
    region: 'Gemini Code Assist is not available in this region',
    'personal-unsupported':
      'Google reports no Gemini CLI quota for this personal Google account (Code Assist for individuals, Google AI Pro/Ultra); only Gemini Code Assist Standard and Enterprise report quota',
    'not-eligible':
      'This Google account is not eligible for Gemini Code Assist',
  };
  return new GeminiUsageError(problem, `${why[problem]} (${codes})`);
}

const NEEDS_PROJECT =
  'This Gemini Code Assist licence needs a Google Cloud project: set "Gemini Cloud project" in the plugin settings';

/**
 * The project and tier from a loadCodeAssist answer, as the CLI's setupUser
 * resolves them, without onboarding: a login the CLI never set up gets
 * "run gemini once" instead. Throws a GeminiUsageError for every problem.
 */
export function resolveSetup(
  answer: LoadCodeAssistResponse | null,
  configuredProject: string | null
): GeminiSetup {
  if (!answer || typeof answer !== 'object') {
    throw new ProviderError('parse', 'Gemini Code Assist sent no tier data');
  }
  const ineligible = Array.isArray(answer.ineligibleTiers)
    ? answer.ineligibleTiers.filter(t => t && typeof t === 'object')
    : [];
  const current = answer.currentTier;
  if (current && typeof current === 'object') {
    const tierId = codeOf(answer.paidTier?.id ?? current.id);
    const tierName =
      typeof (answer.paidTier?.name ?? current.name) === 'string'
        ? `${answer.paidTier?.name ?? current.name}`.slice(0, 80)
        : null;
    const project =
      typeof answer.cloudaicompanionProject === 'string' &&
      answer.cloudaicompanionProject
        ? answer.cloudaicompanionProject
        : configuredProject;
    if (project) return { project, tierId, tierName };
    if (ineligible.length > 0) throw ineligibleError(ineligible);
    throw new GeminiUsageError('needs-project', NEEDS_PROJECT);
  }

  if (ineligible.some(t => codeOf(t.reasonCode) === 'VALIDATION_REQUIRED')) {
    throw ineligibleError(ineligible);
  }
  // not onboarded: the CLI would onboard now (a write); this key only reads
  if (configuredProject) {
    throw new GeminiUsageError(
      'needs-setup',
      'Gemini CLI has not been set up with this login and project yet: run gemini once'
    );
  }
  if (ineligible.length > 0) throw ineligibleError(ineligible);
  const allowed = Array.isArray(answer.allowedTiers) ? answer.allowedTiers : [];
  const onboardTier = allowed.find(t => t?.isDefault);
  if (!onboardTier || onboardTier.userDefinedCloudaicompanionProject) {
    throw new GeminiUsageError('needs-project', NEEDS_PROJECT);
  }
  throw new GeminiUsageError(
    'needs-setup',
    'Gemini CLI has not been set up with this login yet: run gemini once'
  );
}

/** A Code Assist answer: the status, and the JSON body when it parsed. */
export type CodeAssistReply = { status: number; data: unknown };

/** POSTs one Code Assist method; maps transport failures to ProviderErrors. */
export async function postCodeAssist(
  fetchImpl: typeof fetch,
  method: CodeAssistMethod,
  body: unknown,
  token: string,
  version: string | null
): Promise<CodeAssistReply> {
  let response: Response;
  try {
    response = await fetchImpl(`${CODE_ASSIST_BASE}:${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent(version),
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    });
  } catch (error) {
    throw new ProviderError(
      'network',
      `Gemini ${method} failed: network error (${
        (error as Error)?.name ?? 'Error'
      })`
    );
  }
  if (response.status === 429) {
    throw new ProviderError(
      'rate-limited',
      `Gemini ${method} was rate limited`,
      { retryAfterSeconds: retryAfterSeconds(response) }
    );
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    if (response.ok) {
      throw new ProviderError(
        'parse',
        `Gemini ${method} answer was not valid JSON`
      );
    }
  }
  return { status: response.status, data };
}

/** "HTTP 403 PERMISSION_DENIED"-style text for a failed reply. */
export function describeFailure(reply: CodeAssistReply): string {
  const status = codeOf(
    (reply.data as { error?: { status?: unknown } } | null)?.error?.status
  );
  return `HTTP ${reply.status}${status ? ` ${status}` : ''}`;
}
