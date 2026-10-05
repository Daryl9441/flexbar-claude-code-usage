/**
 * Where the Kimi usage meter sends its request and which stored login it
 * uses, resolved the way the Kimi Code CLI does (packages/oauth:
 * resolveKimiCodeRuntimeAuth, resolveKimiCodeOAuthKey, region.ts):
 *
 * - base URL: $KIMI_CODE_BASE_URL, else `base_url` of
 *   [providers."managed:kimi-code"] in config.toml, else the region default
 *   (mainland https://api.kimi.com/coding/v1, global https://api.kimi.ai/…);
 * - credential slot: `kimi-code` for the mainland defaults, else
 *   `kimi-code-env-<sha256({oauthHost, baseUrl})[:16]>`, or the slot that
 *   config.toml names when it matches;
 * - OAuth host for a refresh: the slot's `oauth_host`, else
 *   $KIMI_CODE_OAUTH_HOST / $KIMI_OAUTH_HOST, else https://auth.kimi.com.
 *
 * Pure apart from reading two small files; never logs their content.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MAINLAND = {
  baseUrl: 'https://api.kimi.com/coding/v1',
  oauthHost: 'https://auth.kimi.com',
};
export const GLOBAL = {
  baseUrl: 'https://api.kimi.ai/coding/v1',
  oauthHost: 'https://auth.kimi.ai',
};

const PROVIDER = 'managed:kimi-code';
const DEFAULT_OAUTH_KEY = 'oauth/kimi-code';
const SCOPED_KEY_PREFIX = 'oauth/kimi-code-env-';

/** Largest config.toml read (the real one is a few kB). */
const MAX_CONFIG_BYTES = 1024 * 1024;

export type KimiEndpoint = {
  /** Usage API base, no trailing slash */
  baseUrl: string;
  /** OAuth host for the refresh_token grant, no trailing slash */
  oauthHost: string;
  /** File name (without .json) under <home>/credentials */
  credentialName: string;
  /** True when config.toml has the managed Kimi Code provider */
  configured: boolean;
};

// --- a small TOML reader -------------------------------------------------------

/**
 * Reads the string values of a TOML document into a map keyed by their full
 * dotted path (segments joined with "\u0000"). Enough for config.toml's
 * provider tables: [a."b".c] headers, `key = "string"` / 'literal', dotted
 * keys and one level of inline tables; everything else (numbers, arrays,
 * multi-line values, arrays of tables) is skipped without being parsed.
 */
export function readTomlStrings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let table: string[] = [];
  let skipUntil: RegExp | null = null;
  let depth = 0;

  for (const raw of lines) {
    if (skipUntil) {
      if (skipUntil.test(raw)) skipUntil = null;
      continue;
    }
    if (depth > 0) {
      depth += bracketBalance(raw);
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const arrayTable = line.startsWith('[[');
      const inner = arrayTable
        ? line.slice(2, line.indexOf(']]'))
        : line.slice(1, closingBracket(line));
      const keys = parseKeyPath(inner);
      // an array-of-tables entry never matches a lookup path
      table = keys && !arrayTable ? keys : ['\u0001'];
      continue;
    }

    const eq = findTopLevel(line, '=');
    if (eq < 0) continue;
    const keys = parseKeyPath(line.slice(0, eq));
    // values inside an array of tables are never looked up
    const store = table[0] !== '\u0001';
    if (!keys) continue;
    const value = line.slice(eq + 1).trim();

    if (value.startsWith('"""') || value.startsWith("'''")) {
      const quote = value.slice(0, 3);
      if (value.indexOf(quote, 3) < 0) {
        skipUntil = quote === '"""' ? /"""/ : /'''/;
      }
      continue;
    }
    if (value.startsWith('[')) {
      depth = bracketBalance(value);
      continue;
    }
    if (!store) continue;
    if (value.startsWith('{')) {
      readInlineTable(value, [...table, ...keys], out);
      continue;
    }
    const str = readString(value);
    if (str !== null) out.set([...table, ...keys].join('\u0000'), str.value);
  }
  return out;
}

/** Brackets opened minus closed on a line, ignoring strings and comments. */
function bracketBalance(text: string): number {
  let balance = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') break;
    else if (c === '[' || c === '{') balance++;
    else if (c === ']' || c === '}') balance--;
  }
  return balance;
}

function closingBracket(line: string): number {
  const at = findTopLevel(line, ']');
  return at < 0 ? line.length : at;
}

/** Index of `char` outside quoted strings, or -1. */
function findTopLevel(text: string, char: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === char) return i;
  }
  return -1;
}

/** `a."b.c".d` → ['a', 'b.c', 'd']; null when malformed. */
function parseKeyPath(text: string): string[] | null {
  const keys: string[] = [];
  let rest = text.trim();
  while (rest) {
    let key: string;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const str = readString(rest);
      if (!str) return null;
      key = str.value;
      rest = rest.slice(str.length).trim();
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!match) return null;
      key = match[0];
      rest = rest.slice(key.length).trim();
    }
    keys.push(key);
    if (!rest) break;
    if (!rest.startsWith('.')) return null;
    rest = rest.slice(1).trim();
  }
  return keys.length > 0 ? keys : null;
}

const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/** A basic or literal string at the start of `text`, with its length. */
function readString(text: string): { value: string; length: number } | null {
  const quote = text[0];
  if (quote === "'") {
    const end = text.indexOf("'", 1);
    return end < 0 ? null : { value: text.slice(1, end), length: end + 1 };
  }
  if (quote !== '"') return null;
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value, length: i + 1 };
    if (c !== '\\') {
      value += c;
      continue;
    }
    const next = text[++i];
    if (next === 'u' || next === 'U') {
      const size = next === 'u' ? 4 : 8;
      const code = Number.parseInt(text.slice(i + 1, i + 1 + size), 16);
      if (!Number.isFinite(code)) return null;
      try {
        value += String.fromCodePoint(code);
      } catch {
        return null;
      }
      i += size;
    } else if (next in ESCAPES) {
      value += ESCAPES[next];
    } else {
      return null;
    }
  }
  return null;
}

/** `{ a = "x", b.c = 'y', d = 1 }` → string values under `prefix`. */
function readInlineTable(
  text: string,
  prefix: string[],
  out: Map<string, string>
): void {
  let rest = text.slice(1);
  while (rest) {
    rest = rest.replace(/^[\s,]+/, '');
    if (!rest || rest.startsWith('}')) return;
    const eq = findTopLevel(rest, '=');
    if (eq < 0) return;
    const keys = parseKeyPath(rest.slice(0, eq));
    if (!keys) return;
    rest = rest.slice(eq + 1).trim();
    const str = readString(rest);
    if (str) {
      out.set([...prefix, ...keys].join('\u0000'), str.value);
      rest = rest.slice(str.length);
    } else {
      // a non-string value: skip to the next comma at this level
      const comma = findTopLevel(rest, ',');
      if (comma < 0) return;
      rest = rest.slice(comma + 1);
    }
  }
}

// --- endpoint resolution -------------------------------------------------------

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The CLI's credential key for an (oauthHost, baseUrl) environment. */
export function oauthKeyFor(oauthHost: string, baseUrl: string): string {
  const host = normalize(oauthHost);
  const base = normalize(baseUrl);
  if (host === MAINLAND.oauthHost && base === MAINLAND.baseUrl) {
    return DEFAULT_OAUTH_KEY;
  }
  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost: host, baseUrl: base }))
    .digest('hex')
    .slice(0, 16);
  return `${SCOPED_KEY_PREFIX}${digest}`;
}

/** 'oauth/kimi-code' → 'kimi-code'; null for a key that is not a safe name. */
export function credentialNameOf(key: string): string | null {
  const name = key.startsWith('oauth/') ? key.slice('oauth/'.length) : key;
  if (!name || name.startsWith('.') || /[/\\]/.test(name)) return null;
  return name;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() ? value.trim() : undefined;
}

export type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  /** config.toml text (null when missing) */
  configText?: string | null;
  /** The region marker file's text (null when missing) */
  regionText?: string | null;
};

/**
 * Resolves the usage endpoint and credential slot from config.toml text,
 * the region marker and the environment (see the module comment).
 */
export function resolveEndpoint(options: ResolveOptions = {}): KimiEndpoint {
  const env = options.env ?? process.env;
  const toml = readTomlStrings(options.configText ?? '');
  const get = (...keys: string[]) =>
    nonEmpty(toml.get(['providers', PROVIDER, ...keys].join('\u0000')));
  const configuredBase = get('base_url');
  const configuredKey = get('oauth', 'key');
  const configuredHost = get('oauth', 'oauth_host');
  const configured =
    configuredBase !== undefined || configuredKey !== undefined;

  const envBase = nonEmpty(env.KIMI_CODE_BASE_URL);
  const envHost = nonEmpty(env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST);
  const envOverride = envBase !== undefined || envHost !== undefined;

  // before the first login, the installer's region marker picks the defaults
  const region =
    !configured && !envOverride && options.regionText?.trim() === 'global'
      ? GLOBAL
      : MAINLAND;

  const baseUrl = normalize(envBase ?? configuredBase ?? region.baseUrl);
  // the environment overrides both hosts together, like the CLI's
  const oauthHost = normalize(
    (envOverride ? envHost : configuredHost) ?? region.oauthHost
  );
  // The CLI keeps the configured slot only when it equals the slot derived
  // from these hosts, so the derived one is always the one it reads
  const key = oauthKeyFor(oauthHost, baseUrl);

  return {
    baseUrl,
    oauthHost,
    credentialName: credentialNameOf(key) ?? 'kimi-code',
    configured,
  };
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf-8');
    return text.length > MAX_CONFIG_BYTES ? null : text;
  } catch {
    return null;
  }
}

/** resolveEndpoint() for the Kimi Code home folder `home`. */
export async function loadEndpoint(
  home: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<KimiEndpoint> {
  const [configText, regionText] = await Promise.all([
    readSmall(path.join(home, 'config.toml')),
    readSmall(path.join(home, 'region')),
  ]);
  return resolveEndpoint({ env, configText, regionText });
}

/**
 * Bearer tokens only go to https URLs (plain http only on this computer).
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return (
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}
