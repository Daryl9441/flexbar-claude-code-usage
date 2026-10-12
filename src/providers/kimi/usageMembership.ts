/**
 * The Kimi app's membership total, requested with its current web session.
 * The Code API's own monthly total takes precedence (the caller decides).
 * No web credential is refreshed, persisted, included in a metric or logged.
 */
import { UsageMetric } from '../types';

import { percentFromTotalRatio } from './usageApi';
import { readDesktopAccessToken } from './usageDesktopToken';

export const MEMBERSHIP_STATS_URL =
  'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Only the subscription's shared pool counts; Code rate limits do not. */
export function parseMembershipPayload(payload: unknown): UsageMetric | null {
  if (!record(payload) || !record(payload.subscriptionBalance)) return null;
  const balance = payload.subscriptionBalance;
  if (balance.type !== 'SUBSCRIPTION' || balance.feature !== 'FEATURE_OMNI') {
    return null;
  }
  const raw = balance.amountUsedRatio;
  const ratio =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(ratio) || ratio < 0) return null;
  const reset =
    typeof balance.expireTime === 'string'
      ? Date.parse(balance.expireTime)
      : NaN;
  return {
    id: 'monthly',
    label: 'Month',
    percent: percentFromTotalRatio(ratio),
    resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
  };
}

export type MembershipDeps = {
  fetch: typeof fetch;
  now: () => number;
  readToken?: typeof readDesktopAccessToken;
};

/** Optional enrichment: a failure never erases successfully fetched Code data. */
export async function fetchDesktopMembership(
  desktopDir: string,
  deps: MembershipDeps
): Promise<UsageMetric | null> {
  try {
    const session = await (deps.readToken ?? readDesktopAccessToken)(
      desktopDir,
      {
        now: deps.now(),
      }
    );
    if (session.kind !== 'valid') return null;
    const response = await deps.fetch(MEMBERSHIP_STATS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
        'connect-protocol-version': '1',
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    // Let the official app renew a stale session; never post its refresh token.
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 1024 * 1024) return null;
    return parseMembershipPayload(JSON.parse(text));
  } catch {
    // Transport/JSON errors may quote a credential or private server payload.
    return null;
  }
}
