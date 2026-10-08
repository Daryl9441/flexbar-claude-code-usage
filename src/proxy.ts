/**
 * Outgoing Claude requests (usage endpoint, token refresh) through the proxy
 * the user relies on. FlexDesigner runs plugins in its Electron helper, whose
 * fetch() reads neither HTTPS_PROXY (unless NODE_USE_ENV_PROXY is set) nor
 * the macOS system proxy; where Anthropic refuses direct connections (HTTP
 * 403 "forbidden" before any authentication) the keys then fail although
 * Claude Code itself works.
 *
 * resolveProxy picks the route: the claudeProxy setting, else the
 * environment, else the system proxy (src/proxyConfig.ts); automatic answers
 * are cached per host for a minute. proxiedFetch sends the request: fetch()
 * when direct, else through a CONNECT tunnel (src/proxyTunnel.ts). Only a
 * failed CONNECT phase falls back to one direct request (nothing was sent
 * yet); any later error is final and a RequestSentError, so callers with a
 * fallback endpoint (the token refresh) never send the request twice.
 * A route change is logged once per host, never with proxy credentials.
 */
import { execFile } from 'node:child_process';
import { Socket } from 'node:net';

import {
  ProxyLookup,
  ProxyRoute,
  envProxyFor,
  formatHostPort,
  parseProxySetting,
  parseScutilProxy,
  systemProxyFor,
  targetHost,
} from './proxyConfig';
import {
  ProxyFetchInit,
  TunnelError,
  openTunnel,
  requestThroughTunnel,
} from './proxyTunnel';
import { safeErrorMessage } from './redact';

export type { ProxyFetchInit, ProxyRoute };

/**
 * proxiedFetch failed after the request went into the proxy's tunnel: it may
 * have reached the target, so the caller must not send it again, neither to
 * the same URL nor to another endpoint (a token refresh rotates the token).
 * Every other proxiedFetch failure happened before anything was sent through
 * the proxy (a direct fetch() error is passed on as it is). Its name stays
 * "Error", so safeErrorMessage shows only the message, as before.
 */
export class RequestSentError extends Error {}

export type ProxyLogger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type ProxyDeps = {
  /** Environment with HTTPS_PROXY / NO_PROXY (default process.env) */
  env?: NodeJS.ProcessEnv;
  /** Platform; the system proxy is only read on 'darwin' */
  platform?: NodeJS.Platform;
  /** `scutil --proxy` output (default: readScutilProxy) */
  readSystemProxy?: () => Promise<string>;
  /** The direct request (default: the global fetch at call time) */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

export type ProxyFetchOptions = {
  /** The claudeProxy setting: empty or auto, direct/none/off, http://host:port */
  proxy?: unknown;
  logger?: ProxyLogger;
  /** Names the requests in route log lines (default "Requests") */
  label?: string;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
};

export type ProxyRouter = {
  resolve(
    target: string | URL,
    setting?: unknown,
    logger?: ProxyLogger
  ): Promise<ProxyRoute>;
  fetch(
    url: string,
    init?: ProxyFetchInit,
    options?: ProxyFetchOptions
  ): Promise<Response>;
  /** Forgets the cached automatic route of a target's host (all without one) */
  invalidate(target?: string | URL): void;
};

const CACHE_MS = 60_000;
const SCUTIL = '/usr/sbin/scutil';
const SCUTIL_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DIRECT: ProxyRoute = { kind: 'direct', reason: 'none' };

const SOURCE_TEXT = {
  setting: 'proxy setting',
  env: 'environment proxy',
  system: 'system proxy',
} as const;

const DIRECT_TEXT = {
  none: 'direct',
  setting: 'direct (proxy setting)',
  'no-proxy': 'direct (NO_PROXY)',
  exception: 'direct (system proxy exception)',
} as const;

/** A route for log lines: never the proxy's credentials. */
export function describeRoute(route: ProxyRoute): string {
  if (route.kind === 'direct') return DIRECT_TEXT[route.reason];
  const { host, port } = route.proxy;
  return `via ${SOURCE_TEXT[route.source]} ${formatHostPort(host, port)}`;
}

/** `scutil --proxy`: the macOS system proxy settings (no shell). */
export function readScutilProxy(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      SCUTIL,
      ['--proxy'],
      {
        encoding: 'utf8',
        timeout: SCUTIL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

function toUrl(target: string | URL): URL {
  return typeof target === 'string' ? new URL(target) : target;
}

/** Cache and log key: scheme, host and port of a target. */
function hostKey(target: URL): string {
  return `${target.protocol}//${target.host}`;
}

export function createProxyRouter(deps: ProxyDeps = {}): ProxyRouter {
  const cache = new Map<
    string,
    { expires: number; route: Promise<ProxyRoute> }
  >();
  const warned = new Set<string>();
  const routeLog = new Map<string, string>();
  const now = deps.now ?? Date.now;

  const warnOnce = (logger: ProxyLogger | undefined, message: string) => {
    if (!logger?.warn || warned.has(message)) return;
    warned.add(message);
    logger.warn(message);
  };

  async function systemLookup(target: URL): Promise<ProxyLookup> {
    if ((deps.platform ?? process.platform) !== 'darwin') {
      return { route: null };
    }
    let output: string;
    try {
      output = await (deps.readSystemProxy ?? readScutilProxy)();
    } catch (error) {
      return {
        route: null,
        warning: `Could not read the system proxy: ${safeErrorMessage(error)}`,
      };
    }
    const config = parseScutilProxy(output);
    if (!config) {
      return {
        route: null,
        warning: 'Could not read the system proxy: unexpected scutil output',
      };
    }
    return systemProxyFor(target, config);
  }

  async function automaticRoute(
    target: URL,
    logger?: ProxyLogger
  ): Promise<ProxyRoute> {
    const fromEnv = envProxyFor(target, deps.env ?? process.env);
    if (fromEnv.warning) warnOnce(logger, fromEnv.warning);
    if (fromEnv.route) return fromEnv.route;
    const fromSystem = await systemLookup(target);
    if (fromSystem.warning) warnOnce(logger, fromSystem.warning);
    return fromSystem.route ?? DIRECT;
  }

  function cachedAutomatic(target: URL, logger?: ProxyLogger) {
    const key = hostKey(target);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.route;
    const route = automaticRoute(target, logger).catch(() => DIRECT);
    cache.set(key, { expires: now() + CACHE_MS, route });
    return route;
  }

  async function resolve(
    target: string | URL,
    setting?: unknown,
    logger?: ProxyLogger
  ): Promise<ProxyRoute> {
    const parsed = parseProxySetting(setting);
    if (parsed.mode === 'direct') return { kind: 'direct', reason: 'setting' };
    if (parsed.mode === 'proxy') {
      return { kind: 'proxy', source: 'setting', proxy: parsed.proxy };
    }
    if (parsed.mode === 'invalid') {
      warnOnce(
        logger,
        `Ignoring the proxy setting (${parsed.problem}); using the automatic proxy`
      );
    }
    return cachedAutomatic(toUrl(target), logger);
  }

  function invalidate(target?: string | URL) {
    if (target === undefined) cache.clear();
    else cache.delete(hostKey(toUrl(target)));
  }

  /** Logs `text` when the host's route state differs from the last one. */
  function noteRoute(
    target: URL,
    options: ProxyFetchOptions,
    text: string,
    state: string = text
  ) {
    const host = targetHost(target);
    if (routeLog.get(host) === state) return;
    routeLog.set(host, state);
    const line = `${options.label ?? 'Requests'} to ${host}: ${text}`;
    if (state === text) options.logger?.info?.(line);
    else options.logger?.warn?.(line);
  }

  function direct(url: string, init: ProxyFetchInit): Promise<Response> {
    const send = deps.fetch ?? globalThis.fetch;
    return send(url, init as RequestInit);
  }

  /** The tunnel, or the TunnelError that makes a direct request safe. */
  async function tunnel(
    route: Extract<ProxyRoute, { kind: 'proxy' }>,
    target: URL,
    options: ProxyFetchOptions
  ): Promise<Socket | TunnelError> {
    try {
      return await openTunnel(
        route.proxy,
        target,
        options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
      );
    } catch (error) {
      if (error instanceof TunnelError) return error;
      throw error;
    }
  }

  async function proxiedFetch(
    url: string,
    init: ProxyFetchInit = {},
    options: ProxyFetchOptions = {}
  ): Promise<Response> {
    const target = new URL(url);
    const route = await resolve(target, options.proxy, options.logger);
    if (route.kind === 'direct') {
      noteRoute(target, options, describeRoute(route));
      return direct(url, init);
    }
    const via = describeRoute(route);
    const socket = await tunnel(route, target, options);
    if (socket instanceof TunnelError) {
      invalidate(target);
      noteRoute(
        target,
        options,
        `direct (${via.replace(/^via /, '')} failed: ${socket.message})`,
        `fallback ${via}`
      );
      return direct(url, init);
    }
    noteRoute(target, options, via);
    try {
      return await requestThroughTunnel(socket, target, init, {
        timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
      });
    } catch (error) {
      throw new RequestSentError(
        `Request ${via} failed: ${safeErrorMessage(error)}`
      );
    }
  }

  return { resolve, fetch: proxiedFetch, invalidate };
}

const defaultRouter = createProxyRouter();

/** The route for a target under the claudeProxy setting (see createProxyRouter). */
export function resolveProxy(
  target: string | URL,
  setting?: unknown,
  logger?: ProxyLogger
): Promise<ProxyRoute> {
  return defaultRouter.resolve(target, setting, logger);
}

/** fetch() through the route resolveProxy picks; a standard Response. */
export function proxiedFetch(
  url: string,
  init?: ProxyFetchInit,
  options?: ProxyFetchOptions
): Promise<Response> {
  return defaultRouter.fetch(url, init, options);
}
