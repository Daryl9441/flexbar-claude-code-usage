/**
 * Antigravity usage key: the loopback Connect-JSON client for a running
 * Antigravity language server (`exa.language_server_pb.LanguageServerService`).
 *
 * Requests go to http://127.0.0.1:<port> only (the transport is shared with
 * the session key: ./languageServer.ts), with the CSRF token in the
 * `x-codeium-csrf-token` header (never in a URL, a log line or an error),
 * a timeout and a cap on the answer's size. Answers are classified without
 * quoting them: a Connect error keeps only its code (its message may echo
 * request data) and whether it is about the CSRF token.
 */
import {
  LoopbackResult,
  isTlsPortReply,
  postLoopback,
  rpcHeaders,
  rpcPath,
} from './languageServer';

export type RpcRequest = {
  port: number;
  /** Method name, e.g. RetrieveUserQuotaSummary */
  method: string;
  body: unknown;
  /** CSRF token (credential): header only */
  token: string;
  timeoutMs: number;
  /** Largest answer accepted, in bytes */
  maxBytes: number;
};

/** An HTTP answer as received (status, content type, body text). */
export type RawReply = { status: number; contentType: string; text: string };

/**
 * Sends one request; resolves with any HTTP answer, rejects on transport
 * failures (refused, reset, timeout, too large).
 */
export type RpcPost = (request: RpcRequest) => Promise<RawReply>;

/** What an answer means for the caller. */
export type RpcResult =
  | { kind: 'ok'; json: unknown }
  /** Not a Connect port (e.g. the server's HTTPS port answering plain HTTP) */
  | { kind: 'wrong-port' }
  /** A Connect error: its code, and whether the CSRF token was refused */
  | { kind: 'connect'; status: number; code: string; csrf: boolean }
  /** Any other HTTP status */
  | { kind: 'http'; status: number }
  /** HTTP 200 with a body that is not JSON */
  | { kind: 'parse' };

/** Transport failure with a short, credential-free reason. */
export class RpcTransportError extends Error {
  constructor(readonly reason: string) {
    super(`Antigravity language server: ${reason}`);
    this.name = 'RpcTransportError';
  }
}

/** JSON.parse that never throws (its error text would quote the input). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Classifies a raw answer; never quotes the body. */
export function classifyReply(reply: RawReply): RpcResult {
  if (reply.status === 200) {
    const json = parseJson(reply.text);
    return json !== undefined && json !== null && typeof json === 'object'
      ? { kind: 'ok', json }
      : { kind: 'parse' };
  }
  if (isTlsPortReply(reply.status, reply.text)) return { kind: 'wrong-port' };
  const json = parseJson(reply.text) as
    { code?: unknown; message?: unknown } | undefined;
  if (json && typeof json === 'object' && typeof json.code === 'string') {
    const code = json.code
      .replace(/[^a-z_]/gi, '')
      .slice(0, 40)
      .toLowerCase();
    const message = typeof json.message === 'string' ? json.message : '';
    return {
      kind: 'connect',
      status: reply.status,
      code: code || 'unknown',
      csrf: /csrf/i.test(message.slice(0, 400)),
    };
  }
  return { kind: 'http', status: reply.status };
}

function transportReason(error: unknown): string {
  if (error instanceof RpcTransportError) return error.reason;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]{2,30}$/.test(code)
    ? code
    : 'request failed';
}

/** A credential-free reason for a rejected post (the error's code only). */
export function describeTransport(error: unknown): string {
  return transportReason(error);
}

/** Why a post failed, as RpcTransportError reasons (credential-free). */
function failureReason(result: Extract<LoopbackResult, { error: string }>) {
  switch (result.error) {
    case 'refused':
      return 'ECONNREFUSED';
    case 'timeout':
      return 'timeout';
    case 'too-large':
      return 'answer too large';
    default:
      return result.code === 'EBADPORT'
        ? 'bad port'
        : (result.code ?? 'request failed');
  }
}

/** The real transport: node:http to 127.0.0.1, no proxy, no keep-alive. */
export const httpPost: RpcPost = async request => {
  const { port, method } = request;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new RpcTransportError('bad port');
  }
  if (!/^[A-Za-z]{1,80}$/.test(method)) {
    throw new RpcTransportError('bad method');
  }
  const result = await postLoopback({
    port,
    path: rpcPath(method),
    headers: rpcHeaders(request.token),
    body: JSON.stringify(request.body ?? {}),
    timeoutMs: request.timeoutMs,
    maxBytes: request.maxBytes,
  });
  if ('error' in result) throw new RpcTransportError(failureReason(result));
  return {
    status: result.status,
    contentType: result.contentType,
    text: result.body,
  };
};
