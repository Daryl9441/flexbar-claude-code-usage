/**
 * Where an outgoing Claude request goes: straight to its host or through an
 * HTTP proxy. Pure parsing of the three sources src/proxy.ts asks in this
 * order: the claudeProxy setting, the HTTPS_PROXY / HTTP_PROXY / NO_PROXY
 * environment, and the macOS system proxy (`scutil --proxy` output). Only
 * plain http:// proxies are used (CONNECT tunnels); SOCKS, https:// proxies
 * and automatic configuration (PAC) are reported, never used. No I/O here.
 * Problem texts never repeat a proxy URL, which may hold a password.
 */
import { isIP } from 'node:net';

export type ProxyEndpoint = {
  /** Host name or address; IPv6 without brackets */
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export type ProxySource = 'setting' | 'env' | 'system';

/** Why a request goes direct: forced, excluded, or nothing configured */
export type DirectReason = 'setting' | 'no-proxy' | 'exception' | 'none';

export type ProxyRoute =
  | { kind: 'direct'; reason: DirectReason }
  | { kind: 'proxy'; source: ProxySource; proxy: ProxyEndpoint };

/** One source's answer: a route, or null to ask the next source. */
export type ProxyLookup = { route: ProxyRoute | null; warning?: string };

export type ProxySetting =
  | { mode: 'auto' }
  | { mode: 'direct' }
  | { mode: 'proxy'; proxy: ProxyEndpoint }
  | { mode: 'invalid'; problem: string };

export type ParsedProxyUrl =
  { ok: true; proxy: ProxyEndpoint } | { ok: false; problem: string };

/** The enabled manual proxies and exceptions of `scutil --proxy`. */
export type SystemProxyConfig = {
  https: ProxyEndpoint | null;
  http: ProxyEndpoint | null;
  exceptions: string[];
  excludeSimpleHostnames: boolean;
  /** A PAC file or proxy auto-discovery is turned on */
  autoConfig: boolean;
  socks: boolean;
};

const DIRECT_WORDS = new Set(['direct', 'none', 'off']);
const DEFAULT_PROXY_PORT = 80;

export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** The target's host name, without the brackets of an IPv6 address. */
export function targetHost(target: URL): string {
  return target.hostname.replace(/^\[(.*)\]$/, '$1');
}

export function targetPort(target: URL): number {
  if (target.port) return Number(target.port);
  return target.protocol === 'https:' ? 443 : 80;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function decodeUserInfo(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A short scheme name for a problem text, never anything a user typed after it. */
function schemeName(text: string): string {
  const scheme = text.slice(0, text.indexOf('://')).toLowerCase();
  return /^[a-z][a-z0-9+.-]{0,9}$/.test(scheme) ? scheme : 'this kind of';
}

/**
 * An HTTP proxy URL: http://[user:pass@]host[:port][/]. Without a scheme it
 * is taken as http:// (like curl); without a port, 80.
 */
export function parseProxyUrl(text: string): ParsedProxyUrl {
  const trimmed = text.trim();
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  if (!/^http:\/\//i.test(withScheme)) {
    return {
      ok: false,
      problem: `${schemeName(withScheme)} proxies are not supported, only http://`,
    };
  }
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, problem: 'not a valid proxy URL' };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, problem: 'a proxy URL has no path or query' };
  }
  const host = targetHost(url);
  const port = url.port ? Number(url.port) : DEFAULT_PROXY_PORT;
  if (!host || !validPort(port)) {
    return { ok: false, problem: 'not a valid proxy URL' };
  }
  const credentials =
    url.username || url.password
      ? {
          username: decodeUserInfo(url.username),
          password: decodeUserInfo(url.password),
        }
      : {};
  return { ok: true, proxy: { host, port, ...credentials } };
}

/** The claudeProxy setting: empty or auto, direct/none/off, or a proxy URL. */
export function parseProxySetting(value: unknown): ProxySetting {
  if (typeof value !== 'string') return { mode: 'auto' };
  const text = value.trim();
  const word = text.toLowerCase();
  if (!text || word === 'auto') return { mode: 'auto' };
  if (DIRECT_WORDS.has(word)) return { mode: 'direct' };
  const parsed = parseProxyUrl(text);
  return parsed.ok
    ? { mode: 'proxy', proxy: parsed.proxy }
    : { mode: 'invalid', problem: parsed.problem };
}

// --- NO_PROXY ------------------------------------------------------------------

type NoProxyEntry = { host: string; port?: number };

function stripWildcard(host: string): string {
  return host.replace(/^\*?\./, '');
}

function parseNoProxyEntry(raw: string): NoProxyEntry | null {
  const entry = raw.trim().toLowerCase();
  if (!entry) return null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) {
    return bracketed[2]
      ? { host: bracketed[1], port: Number(bracketed[2]) }
      : { host: bracketed[1] };
  }
  const parts = entry.split(':');
  // one colon: host:port; more: an IPv6 address without a port
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: stripWildcard(parts[0]), port: Number(parts[1]) };
  }
  return { host: stripWildcard(entry) };
}

function inDomain(host: string, domain: string): boolean {
  return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
}

/**
 * NO_PROXY matching: comma (or space) separated entries, `*` for every
 * host, a domain with or without a leading `.` or `*.` for itself and its
 * subdomains, an optional `:port`.
 */
export function matchesNoProxy(
  hostname: string,
  port: number,
  list: string
): boolean {
  const host = hostname.toLowerCase();
  return list.split(/[\s,]+/).some(raw => {
    if (raw.trim() === '*') return true;
    const entry = parseNoProxyEntry(raw);
    if (!entry) return false;
    if (entry.port !== undefined && entry.port !== port) return false;
    return inDomain(host, entry.host);
  });
}

function firstSet(
  env: NodeJS.ProcessEnv,
  names: string[]
): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

/**
 * The environment proxy for a target: https_proxy / HTTPS_PROXY for https,
 * http_proxy / HTTP_PROXY for http, minus no_proxy / NO_PROXY. NO_PROXY
 * alone changes nothing. A proxy this code cannot use is ignored with a
 * warning, and the system proxy is asked next.
 */
export function envProxyFor(target: URL, env: NodeJS.ProcessEnv): ProxyLookup {
  const names =
    target.protocol === 'https:'
      ? ['https_proxy', 'HTTPS_PROXY']
      : ['http_proxy', 'HTTP_PROXY'];
  const found = firstSet(env, names);
  if (!found) return { route: null };
  const parsed = parseProxyUrl(found.value);
  if (!parsed.ok) {
    return {
      route: null,
      warning: `Ignoring ${found.name}: ${parsed.problem}`,
    };
  }
  const noProxy = firstSet(env, ['no_proxy', 'NO_PROXY'])?.value ?? '';
  if (matchesNoProxy(targetHost(target), targetPort(target), noProxy)) {
    return { route: { kind: 'direct', reason: 'no-proxy' } };
  }
  return { route: { kind: 'proxy', source: 'env', proxy: parsed.proxy } };
}

// --- scutil --proxy --------------------------------------------------------------

type ScutilEntries = {
  values: Map<string, string>;
  arrays: Map<string, string[]>;
};

/**
 * The top-level `Key : value` lines and arrays of `scutil --proxy` output.
 * Nested dictionaries (`__SCOPED__`, per interface) are skipped.
 */
function topLevelEntries(output: string): ScutilEntries {
  const values = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  let depth = 0;
  let array: string[] | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '}') {
      depth = Math.max(0, depth - 1);
      if (depth < 2) array = null;
      continue;
    }
    if (/^<dictionary>\s*\{$/.test(line)) {
      depth++;
      continue;
    }
    const match = /^(\S+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (/^<(?:array|dictionary)>\s*\{$/.test(value)) {
      depth++;
      if (depth === 2 && value.startsWith('<array>')) {
        array = [];
        arrays.set(key, array);
      }
      continue;
    }
    if (depth === 1) values.set(key, value);
    else if (depth === 2 && array) array.push(value);
  }
  return { values, arrays };
}

function scutilEndpoint(
  values: Map<string, string>,
  prefix: 'HTTP' | 'HTTPS'
): ProxyEndpoint | null {
  if (values.get(`${prefix}Enable`) !== '1') return null;
  const host = values.get(`${prefix}Proxy`)?.trim();
  const portText = values.get(`${prefix}Port`) ?? String(DEFAULT_PROXY_PORT);
  const port = Number(portText);
  if (!host || !/^\d+$/.test(portText) || !validPort(port)) return null;
  return { host, port };
}

/** The proxy settings in `scutil --proxy` output, or null for anything else. */
export function parseScutilProxy(output: unknown): SystemProxyConfig | null {
  if (typeof output !== 'string' || !/^\s*<dictionary>\s*\{/.test(output)) {
    return null;
  }
  const { values, arrays } = topLevelEntries(output);
  const flag = (key: string) => values.get(key) === '1';
  return {
    https: scutilEndpoint(values, 'HTTPS'),
    http: scutilEndpoint(values, 'HTTP'),
    exceptions: arrays.get('ExceptionsList') ?? [],
    excludeSimpleHostnames: flag('ExcludeSimpleHostnames'),
    autoConfig:
      flag('ProxyAutoConfigEnable') || flag('ProxyAutoDiscoveryEnable'),
    socks: flag('SOCKSEnable'),
  };
}

function ipv4Number(address: string): number {
  return address
    .split('.')
    .reduce((sum, octet) => sum * 256 + Number(octet), 0);
}

/** `169.254/16`, `10.0.0.0/8`: missing octets are 0. */
function inIpv4Range(host: string, entry: string): boolean | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){0,3})\/(\d{1,2})$/.exec(entry);
  if (!match) return null;
  const bits = Number(match[2]);
  if (isIP(host) !== 4 || bits > 32) return false;
  const octets = match[1].split('.');
  const base = ipv4Number(
    [...octets, ...Array(4 - octets.length).fill('0')].join('.')
  );
  const size = 2 ** (32 - bits);
  return Math.floor(ipv4Number(host) / size) === Math.floor(base / size);
}

function globMatches(host: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(host);
}

function exceptionMatches(host: string, raw: string): boolean {
  const entry = raw.trim().toLowerCase();
  if (!entry) return false;
  const range = inIpv4Range(host, entry);
  if (range !== null) return range;
  if (entry.includes('*')) return globMatches(host, entry);
  return inDomain(host, entry.replace(/^\./, ''));
}

/**
 * macOS's "Bypass proxy settings for these hosts & domains" and "Exclude
 * simple hostnames": globs (`*.local`, `192.168.1.*`), IPv4 ranges
 * (`169.254/16`), domains (with their subdomains), host names without a dot.
 */
export function matchesProxyException(
  host: string,
  exceptions: readonly string[],
  excludeSimpleHostnames: boolean
): boolean {
  if (excludeSimpleHostnames && !host.includes('.') && isIP(host) === 0) {
    return true;
  }
  return exceptions.some(entry => exceptionMatches(host, entry));
}

/**
 * The system proxy for a target: the HTTPS proxy for https (else the HTTP
 * one), the HTTP proxy for http, unless an exception matches.
 */
export function systemProxyFor(
  target: URL,
  config: SystemProxyConfig
): ProxyLookup {
  const proxy =
    target.protocol === 'https:' ? (config.https ?? config.http) : config.http;
  const pac = config.autoConfig
    ? 'The system proxy uses automatic configuration (PAC), which is not supported; set the proxy in the plugin settings'
    : undefined;
  if (!proxy) {
    if (pac) return { route: null, warning: pac };
    if (config.socks) {
      return {
        route: null,
        warning:
          'The system proxy is a SOCKS proxy, which is not supported; set an HTTP proxy in the plugin settings',
      };
    }
    return { route: null };
  }
  const host = targetHost(target);
  if (
    matchesProxyException(
      host,
      config.exceptions,
      config.excludeSimpleHostnames
    )
  ) {
    return { route: { kind: 'direct', reason: 'exception' } };
  }
  const route: ProxyRoute = { kind: 'proxy', source: 'system', proxy };
  return pac ? { route, warning: pac } : { route };
}
