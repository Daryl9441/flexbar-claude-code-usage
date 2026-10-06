/**
 * Antigravity usage key: the loopback Connect-JSON client for a running
 * Antigravity language server (`exa.language_server_pb.LanguageServerService`).
 *
 * Requests go to http://127.0.0.1:<port> only, with the CSRF token in the
 * `x-codeium-csrf-token` header (never in a URL, a log line or an error),
 * a timeout and a cap on the answer's size. Answers are classified without
 * quoting them: a Connect error keeps only its code (its message may echo
 * request data) and whether it is about the CSRF token.
 */
import http from 'node:http';

const SERVICE = 'exa.language_server_pb.LanguageServerService';

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
  if (
    reply.status === 400 &&
    /http request to an https server/i.test(reply.text.slice(0, 400))
  ) {
    return { kind: 'wrong-port' };
  }
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

/** The real transport: node:http to 127.0.0.1, no proxy, no keep-alive. */
export const httpPost: RpcPost = request =>
  new Promise((resolve, reject) => {
    const { port, method } = request;
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      reject(new RpcTransportError('bad port'));
      return;
    }
    if (!/^[A-Za-z]{1,80}$/.test(method)) {
      reject(new RpcTransportError('bad method'));
      return;
    }
    const payload = Buffer.from(JSON.stringify(request.body ?? {}));
    let settled = false;
    // set once the request exists; finish() only runs after that
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/${SERVICE}/${method}`,
        agent: false,
        timeout: request.timeoutMs,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': request.token,
          'content-length': payload.length,
        },
      },
      res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > request.maxBytes) {
            req.destroy(new RpcTransportError('answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              text: Buffer.concat(chunks).toString('utf8'),
            })
          )
        );
        res.on('error', error =>
          finish(() => reject(new RpcTransportError(transportReason(error))))
        );
      }
    );
    // the socket timeout covers silence; this covers a slow trickle
    const deadline = setTimeout(
      () => req.destroy(new RpcTransportError('timeout')),
      request.timeoutMs
    );
    req.on('timeout', () => req.destroy(new RpcTransportError('timeout')));
    req.on('error', error =>
      finish(() => reject(new RpcTransportError(transportReason(error))))
    );
    req.end(payload);
  });
