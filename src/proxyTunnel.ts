/**
 * One request through an HTTP proxy's CONNECT tunnel, with Node's own http,
 * https and tls modules (no dependency). openTunnel is the CONNECT phase:
 * until it resolves nothing has reached the target, so its TunnelError is
 * the only failure that may be retried without the proxy.
 * requestThroughTunnel then sends the request exactly once: TLS with Node's
 * default certificate checks and the target as server name for https
 * targets, plain HTTP for http targets (used by the tests). The answer is a
 * standard Response, its body read up to a size limit.
 */
import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { Socket, isIP } from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

import {
  ProxyEndpoint,
  formatHostPort,
  targetHost,
  targetPort,
} from './proxyConfig';
import { safeErrorMessage } from './redact';

/** The parts of fetch's RequestInit the Claude requests use. */
export type ProxyFetchInit = {
  method?: string;
  headers?: Record<string, string> | Headers | Array<[string, string]>;
  body?: string | Uint8Array | URLSearchParams | null;
  /** Ends a direct request; the tunnel has its own limits (timeoutMs) */
  signal?: AbortSignal;
};

export type TunnelLimits = { timeoutMs: number; maxBodyBytes: number };

/** The CONNECT phase failed: nothing was sent to the target. */
export class TunnelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelError';
  }
}

// statuses fetch's Response refuses a body for
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function proxyAuthorization(proxy: ProxyEndpoint): Record<string, string> {
  if (proxy.username === undefined) return {};
  const pair = `${proxy.username}:${proxy.password ?? ''}`;
  return {
    'Proxy-Authorization': `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`,
  };
}

/**
 * Asks the proxy for a tunnel to the target (CONNECT host:port) and resolves
 * with the tunnel's socket once the proxy answers 2xx. Rejects with a
 * TunnelError when the proxy cannot be reached, does not answer in time or
 * answers anything else.
 */
export function openTunnel(
  proxy: ProxyEndpoint,
  target: URL,
  timeoutMs: number
): Promise<Socket> {
  const authority = formatHostPort(targetHost(target), targetPort(target));
  return new Promise((resolve, reject) => {
    // agent: false, so no shared agent (or an environment proxy) is involved
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority, ...proxyAuthorization(proxy) },
      agent: false,
    });
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(new TunnelError(message));
    };
    const timer = setTimeout(
      () => fail(`no CONNECT answer within ${timeoutMs} ms`),
      timeoutMs
    );
    request.once('connect', (response, socket: Socket, head: Buffer) => {
      const status = response.statusCode ?? 0;
      if (settled || status < 200 || status >= 300) {
        socket.destroy();
        fail(`CONNECT answered HTTP ${status}`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (head.length > 0) socket.unshift(head);
      // the request sent over the tunnel reports its errors; until it
      // takes the socket over, an error must not go unhandled
      socket.on('error', () => undefined);
      resolve(socket);
    });
    request.on('error', error => fail(safeErrorMessage(error)));
    request.end();
  });
}

function headerEntries(
  headers: ProxyFetchInit['headers']
): Array<[string, string]> {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers))
    return headers.map(([name, value]) => [name, value]);
  return Object.entries(headers);
}

/** The body as bytes, and the Content-Type fetch would give it. */
function encodeBody(body: ProxyFetchInit['body']): {
  data?: Buffer;
  type?: string;
} {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') {
    return {
      data: Buffer.from(body, 'utf8'),
      type: 'text/plain;charset=UTF-8',
    };
  }
  if (body instanceof URLSearchParams) {
    return {
      data: Buffer.from(body.toString(), 'utf8'),
      type: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  return { data: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
}

/** Headers and body bytes as fetch would send them (uncompressed answer). */
export function encodeRequest(init: ProxyFetchInit): {
  headers: Record<string, string>;
  body?: Buffer;
} {
  const entries = headerEntries(init.headers);
  const has = (name: string) =>
    entries.some(([key]) => key.toLowerCase() === name);
  const { data, type } = encodeBody(init.body);
  const extra: Array<[string, string]> = [
    ...(has('accept-encoding')
      ? []
      : [['Accept-Encoding', 'identity'] as [string, string]]),
    ...(data && type && !has('content-type')
      ? [['Content-Type', type] as [string, string]]
      : []),
    ...(data && !has('content-length')
      ? [['Content-Length', String(data.length)] as [string, string]]
      : []),
  ];
  return { headers: Object.fromEntries([...entries, ...extra]), body: data };
}

function responseHeaders(raw: string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i], raw[i + 1]);
    } catch {
      // a header fetch itself would not accept
    }
  }
  return headers;
}

/** The body without its content encoding, never larger than `max` bytes. */
function decodeBody(
  encoding: string | null,
  body: Buffer,
  max: number
): Buffer {
  const options = { maxOutputLength: max };
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return body;
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(body, options);
    case 'deflate':
      return zlib.inflateSync(body, options);
    case 'br':
      return zlib.brotliDecompressSync(body, options);
    default:
      throw new Error('unsupported content encoding');
  }
}

function toResponse(
  message: IncomingMessage,
  body: Buffer,
  maxBodyBytes: number
): Response {
  const status = message.statusCode ?? 0;
  if (status < 200 || status > 599) {
    throw new Error(`unexpected HTTP status ${status}`);
  }
  const headers = responseHeaders(message.rawHeaders);
  const encoding = headers.get('content-encoding');
  const decoded = decodeBody(encoding, body, maxBodyBytes);
  if (decoded !== body) {
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  // a plain Uint8Array: what every BodyInit typing accepts
  const content = NULL_BODY_STATUSES.has(status)
    ? null
    : new Uint8Array(decoded);
  try {
    return new Response(content, {
      status,
      statusText: message.statusMessage ?? '',
      headers,
    });
  } catch {
    // a status text fetch's Response refuses
    return new Response(content, { status, headers });
  }
}

/**
 * Sends the request over an open tunnel and resolves with the answer.
 * Every failure rejects: the request may have reached the target, so the
 * caller must not repeat it.
 */
export function requestThroughTunnel(
  socket: Socket,
  target: URL,
  init: ProxyFetchInit,
  limits: TunnelLimits
): Promise<Response> {
  const host = targetHost(target);
  const secure = target.protocol === 'https:';
  // host: the name the certificate is checked against (the socket's own
  // host is the proxy's); servername: SNI, only for names
  const connection: Socket = secure
    ? tls.connect({
        socket,
        host,
        servername: isIP(host) ? undefined : host,
        ALPNProtocols: ['http/1.1'],
      })
    : socket;
  const { headers, body } = encodeRequest(init);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { response: Response } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      socket.destroy();
      if ('response' in outcome) resolve(outcome.response);
      else reject(new Error(safeErrorMessage(outcome.error)));
    };
    // no agent: createConnection hands over the tunnel (with an agent,
    // even agent: false, Node would open its own connection to the target)
    const request = (secure ? https : http).request({
      host,
      port: targetPort(target),
      method: init.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers,
      createConnection: () => connection,
    });
    const timer = setTimeout(
      () =>
        request.destroy(new Error(`timed out after ${limits.timeoutMs} ms`)),
      limits.timeoutMs
    );
    request.on('error', error => finish({ error }));
    request.on('response', message => {
      const chunks: Buffer[] = [];
      let size = 0;
      message.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.maxBodyBytes) {
          message.destroy(
            new Error(`response larger than ${limits.maxBodyBytes} bytes`)
          );
          return;
        }
        chunks.push(chunk);
      });
      message.on('error', error => finish({ error }));
      message.on('end', () => {
        try {
          const response = toResponse(
            message,
            Buffer.concat(chunks),
            limits.maxBodyBytes
          );
          finish({ response });
        } catch (error) {
          finish({ error });
        }
      });
      message.on('close', () => {
        if (!message.complete) {
          finish({
            error: new Error('connection closed before the response ended'),
          });
        }
      });
    });
    request.end(body);
  });
}
