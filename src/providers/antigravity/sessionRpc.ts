/**
 * The session RPC to a running Antigravity language server: one read-only
 * Connect-JSON call, `LanguageServerService/GetAllCascadeTrajectories`
 * (every conversation's summary: status, waiting steps, title, workspace).
 *
 * Only ever to 127.0.0.1 (fixed in the transport shared with the usage key,
 * ./languageServer.ts, not configurable), only to ports that
 * lsof lists for the same process as the token (./sessionProcs.ts), plain
 * HTTP with a timeout; the CSRF token goes in the `x-codeium-csrf-token`
 * header and nowhere else. Each server listens on an HTTPS port and a plain
 * HTTP port (observed: the higher one); ports are tried from the highest
 * down and the one that answers is remembered. Error texts name the outcome
 * and the Connect error code only: never the token, the body or a message
 * from the server (it can quote request data).
 */
import http from 'node:http';

import {
  isTlsPortReply,
  postLoopback,
  rpcHeaders,
  rpcPath,
} from './languageServer';
import type { CsrfToken, LanguageServer } from './sessionProcs';

const TIMEOUT_MS = 5_000;
/** Larger answers are refused (thousands of conversations) */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** A raw HTTP answer, or the transport failure. */
export type PostResult =
  | { status: number; body: string }
  | { error: 'refused' | 'timeout' | 'too-large' | 'failed' };

/** Sends one POST to 127.0.0.1:<port><path>; never rejects. */
export type PostFn = (
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
) => Promise<PostResult>;

type RequestFn = typeof http.request;

/** The default POST over node:http (tests pass a fake `request`). */
export function createPost(request: RequestFn = http.request): PostFn {
  return async (port, path, headers, body) => {
    const result = await postLoopback(
      {
        port,
        path,
        headers,
        body,
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BODY_BYTES,
      },
      request
    );
    return 'error' in result
      ? { error: result.error }
      : { status: result.status, body: result.body };
  };
}

export type RpcOutcome =
  | {
      ok: true;
      /** The port that answered (remember it) */
      port: number;
      /** Conversation id → CascadeTrajectorySummary (JSON) */
      summaries: Record<string, unknown>;
    }
  | {
      ok: false;
      /**
       * rejected: 401/403 (CSRF token or sign-in); unreachable: no port
       * answered; error: another failure
       */
      reason: 'rejected' | 'unreachable' | 'error';
      /** Connect error code or HTTP status, for the log */
      detail: string;
    };

/** A Connect error's code (`{"code": "unauthenticated", …}`), or null. */
function connectCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const code =
      parsed && typeof parsed === 'object'
        ? (parsed as { code?: unknown }).code
        : null;
    return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

/**
 * GetAllCascadeTrajectories on one server: the remembered port first, then
 * the server's other loopback ports from the highest down.
 */
export async function fetchTrajectories(
  server: Pick<LanguageServer, 'ports'> & { token: CsrfToken },
  post: PostFn,
  preferredPort: number | null = null
): Promise<RpcOutcome> {
  const ports = server.ports ?? [];
  const order = [
    ...(preferredPort !== null && ports.includes(preferredPort)
      ? [preferredPort]
      : []),
    ...ports.filter(p => p !== preferredPort),
  ];
  if (order.length === 0) {
    return { ok: false, reason: 'unreachable', detail: 'no loopback port' };
  }
  const headers = rpcHeaders(server.token.reveal());
  let last: RpcOutcome = {
    ok: false,
    reason: 'unreachable',
    detail: 'no answer',
  };
  for (const port of order) {
    const result = await post(
      port,
      rpcPath('GetAllCascadeTrajectories'),
      headers,
      JSON.stringify({ excludeSubtrajectories: true })
    );
    if ('error' in result) {
      last = {
        ok: false,
        reason: result.error === 'too-large' ? 'error' : 'unreachable',
        detail: result.error,
      };
      if (result.error === 'too-large') return last;
      continue;
    }
    if (result.status === 200) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body);
      } catch {
        // not this server's RPC port (or a broken answer): try the next
        last = { ok: false, reason: 'error', detail: 'unreadable answer' };
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        last = { ok: false, reason: 'error', detail: 'unexpected answer' };
        continue;
      }
      const map = (parsed as { trajectorySummaries?: unknown })
        .trajectorySummaries;
      return {
        ok: true,
        port,
        summaries:
          map && typeof map === 'object' && !Array.isArray(map)
            ? (map as Record<string, unknown>)
            : {},
      };
    }
    if (isTlsPortReply(result.status, result.body)) continue;
    const code = connectCode(result.body);
    if (result.status === 401 || result.status === 403) {
      return {
        ok: false,
        reason: 'rejected',
        detail: code ?? `HTTP ${result.status}`,
      };
    }
    last = {
      ok: false,
      reason: 'error',
      detail: code ?? `HTTP ${result.status}`,
    };
    // 404 and the like: another port may be the RPC one
  }
  return last;
}
