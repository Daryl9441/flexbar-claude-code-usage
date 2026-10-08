import { logger } from '@eniac/flexdesigner';

import {
  CLAUDE_REQUESTS,
  ClaudeLoginExpiredError,
  RefreshOptions,
  getAccessToken,
} from './credentials';
import { readTextPrefix } from './httpText';
import { proxiedFetch } from './proxy';
import { safeErrorMessage } from './redact';
import { UsageData } from './types';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// The usage endpoint sits behind the Claude Code OAuth beta; requests without
// a claude-code user agent land in an aggressively rate-limited bucket.
const HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
  'Content-Type': 'application/json',
  'User-Agent': 'claude-code/2.1.5',
};

// Anthropic's JSON error bodies are tiny; a 403 body is never read further
const ERROR_BODY_MAX = 16 * 1024;

export type UsageErrorCode =
  | 'no-credentials'
  | 'unauthorized'
  | 'rate-limited'
  /** HTTP 403 "forbidden": requests from this network or region are refused */
  | 'forbidden'
  | 'http'
  | 'network';

export class UsageError extends Error {
  constructor(
    message: string,
    public readonly code: UsageErrorCode,
    /** Seconds until the rate limit lifts, from the Retry-After header. */
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

export type FetchUsageOptions = {
  /** Claude Code credentials file override (the credentialsPath setting) */
  credentialsPath?: string;
  /** The claudeProxy setting (src/proxy.ts): empty or auto, direct, or a URL */
  proxy?: string;
};

async function requestUsage(token: string, proxy?: string): Promise<Response> {
  try {
    return await proxiedFetch(
      USAGE_URL,
      { headers: { ...HEADERS, Authorization: `Bearer ${token}` } },
      { proxy, logger: logger ?? undefined, label: CLAUDE_REQUESTS }
    );
  } catch (error) {
    throw new UsageError(
      `Network error: ${safeErrorMessage(error)}`,
      'network'
    );
  }
}

/** `error.type` of an Anthropic JSON error body, or null. */
async function errorType(response: Response): Promise<string | null> {
  const text = await readTextPrefix(response, ERROR_BODY_MAX);
  try {
    const parsed = JSON.parse(text) as { error?: { type?: unknown } } | null;
    const type = parsed?.error?.type;
    return typeof type === 'string' ? type : null;
  } catch {
    return null;
  }
}

/**
 * getAccessToken, with a login Claude Code can no longer refresh (signed out,
 * refresh token rejected) reported as an expired login ('unauthorized').
 */
async function accessToken(
  credentialsPath: string | undefined,
  options: RefreshOptions
): Promise<string | null> {
  try {
    return await getAccessToken(credentialsPath, options);
  } catch (error) {
    if (error instanceof ClaudeLoginExpiredError) {
      throw new UsageError(error.message, 'unauthorized');
    }
    throw error;
  }
}

export async function fetchUsage({
  credentialsPath,
  proxy,
}: FetchUsageOptions = {}): Promise<UsageData> {
  const token = await accessToken(credentialsPath, {
    logger: logger ?? undefined,
    proxy,
  });
  if (!token) {
    throw new UsageError(
      'No Claude Code credentials found. Log in with Claude Code first.',
      'no-credentials'
    );
  }

  let response = await requestUsage(token, proxy);

  // Expired/revoked token despite a plausible stored expiry: force one
  // refresh through the stored refresh token and retry once
  if (response.status === 401) {
    const refreshed = await accessToken(credentialsPath, {
      force: true,
      rejectedToken: token,
      logger: logger ?? undefined,
      proxy,
    });
    if (refreshed && refreshed !== token) {
      response = await requestUsage(refreshed, proxy);
    }
  }

  if (response.status === 401) {
    throw new UsageError(
      'Claude Code login expired — run any claude command in a terminal to log in again.',
      'unauthorized'
    );
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new UsageError(
      'Rate limited by the usage endpoint.',
      'rate-limited',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    );
  }
  // Anthropic's edge refuses some networks and regions before it looks at
  // the token: {"error":{"type":"forbidden","message":"Request not allowed"}}
  if (response.status === 403 && (await errorType(response)) === 'forbidden') {
    throw new UsageError(
      'Usage request refused (HTTP 403 forbidden): Anthropic does not accept requests from this network or region. Check the Claude proxy setting or your system proxy.',
      'forbidden'
    );
  }
  if (!response.ok) {
    throw new UsageError(
      `Usage request failed with HTTP ${response.status}`,
      'http'
    );
  }

  return (await response.json()) as UsageData;
}
