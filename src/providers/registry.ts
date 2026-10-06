/**
 * The providers this plugin knows, in key-library order, and the key groups
 * plugin.ts routes FlexDesigner events to: one usage, one session and one
 * new-session group per provider, each owning one cid.
 *
 * Adding a provider: create src/providers/<id>/ with brand.ts, usage.ts
 * (export `usageSource`), session.ts (`sessionProvider`), newSession.ts
 * (`newSessionLauncher`) and index.ts (a ProviderDef), list it here, and
 * add its three keys, UI files and strings to the manifest.
 */
import { NewSessionKeys } from '../newSessionKey';
import { SessionKeys } from '../sessionKey';
import { UsageKeys } from '../usageKey';

import { ANTIGRAVITY } from './antigravity';
import { CLAUDE } from './claude';
import { GEMINI } from './gemini';
import { KIMI } from './kimi';
import { keyCid } from './kit';
import { KeyGroup, KeyHost, KeyKind, ProviderDef, ProviderId } from './types';

export const PROVIDERS: readonly ProviderDef[] = [
  CLAUDE,
  KIMI,
  GEMINI,
  ANTIGRAVITY,
];

export type KeyRoute = { provider: ProviderDef; kind: KeyKind; cid: string };

const KINDS: KeyKind[] = ['usage', 'session', 'newsession'];

/** Every key cid, Claude's first. */
export const ROUTES: readonly KeyRoute[] = PROVIDERS.flatMap(provider =>
  KINDS.map(kind => ({ provider, kind, cid: keyCid(provider.id, kind) }))
);

export function routeOf(cid: unknown): KeyRoute | null {
  return ROUTES.find(route => route.cid === cid) ?? null;
}

export function providerById(id: ProviderId): ProviderDef | null {
  return PROVIDERS.find(provider => provider.id === id) ?? null;
}

/**
 * The cid a settings-page message is about. Messages carry `cid`; the
 * original Claude pages send none ('test-connection' from the global page,
 * 'session-status' from the Session Status key).
 */
export function messageCid(payload: {
  cid?: unknown;
  data?: unknown;
}): string | null {
  if (typeof payload.cid === 'string' && payload.cid) return payload.cid;
  if (payload.data === 'test-connection') return keyCid('claude', 'usage');
  if (payload.data === 'session-status') return keyCid('claude', 'session');
  return null;
}

export type KeyGroupHost = KeyHost & {
  /** Usage poll interval in ms (global setting) */
  pollIntervalMs: () => number;
};

/** One key group per route, in ROUTES order. */
export function createKeyGroups(host: KeyGroupHost): KeyGroup[] {
  return ROUTES.map(({ provider, kind, cid }) => {
    const brand = provider.brand;
    switch (kind) {
      case 'usage':
        return new UsageKeys({
          ...host,
          provider: { cid, brand, source: provider.usage },
        });
      case 'session':
        return new SessionKeys({
          ...host,
          provider: { cid, brand, sessions: provider.session },
        });
      case 'newsession':
        return new NewSessionKeys({
          ...host,
          provider: { cid, brand, launcher: provider.newSession },
        });
    }
  });
}
