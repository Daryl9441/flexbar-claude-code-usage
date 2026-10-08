// Tests for Claude Code's login state and the token refresh around it
// (src/credentials.ts, src/credentialStore.ts, src/cliLock.ts, src/api.ts):
// a login Claude Code signed out of, refresh tokens rejected with
// invalid_grant, the fields a refresh answer updates, Claude Code's own
// refresh lock, deadlines, and writing the refreshed pair back only to the
// login it came from.
// Run against the tsc output of `npm run test:claude-login`
// (.test-build-claude-login/). Rules: synthetic fixtures only (see CLAUDE.md),
// no network (fetch is stubbed), no programs (child_process is stubbed: never
// the real Keychain), HOME points at an empty temp folder, token-shaped
// strings are built at runtime.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-test-')));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
process.env.USER = 'you';
for (const name of [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CREDENTIALS_PATH',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
]) {
  delete process.env[name];
}
after(() => {
  fs.chmodSync(empty, 0o700);
  fs.rmSync(empty, { recursive: true, force: true });
});

// --- network: fetch is a stub that records its calls ----------------------------
const fetched = [];
let fetchReply = null;
globalThis.fetch = async (url, init = {}) => {
  fetched.push({ url: String(url), init });
  if (!fetchReply) throw new Error('network is disabled in tests');
  return fetchReply(String(url), init);
};

// --- programs: child_process is stubbed before any module under test loads ------
const proc = { execFile: null, spawn: null, calls: [] };
function execFileStub(file, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  proc.calls.push({ kind: 'execFile', file, args: [...args], options });
  if (!proc.execFile) throw new Error('execFile is disabled in tests');
  const result = proc.execFile(file, args);
  setImmediate(() =>
    result.error ? cb(result.error, '', result.stderr ?? '') : cb(null, result.stdout ?? '', result.stderr ?? '')
  );
  return new EventEmitter();
}
execFileStub[promisify.custom] = (file, args, options) =>
  new Promise((resolve, reject) =>
    execFileStub(file, args, options ?? {}, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr })
    )
  );
childProcess.execFile = execFileStub;
childProcess.spawn = (file, args, options) => {
  proc.calls.push({ kind: 'spawn', file, args: [...args] });
  if (!proc.spawn) throw new Error('spawn is disabled in tests');
  return proc.spawn(file, args, options);
};
for (const name of ['exec', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
  childProcess[name] = () => {
    throw new Error(`${name} is disabled in tests`);
  };
}

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build = process.env.CLAUDE_LOGIN_TEST_BUILD ?? path.join(here, '..', '.test-build-claude-login');
// the usage client loads the FlexDesigner SDK; the real one connects to the
// app on load, so a stand-in is cached
const sdk = require.resolve('@eniac/flexdesigner', { paths: [build] });
require.cache[sdk] = { id: sdk, filename: sdk, loaded: true, exports: { logger: undefined, plugin: undefined } };
const req = p => require(path.join(build, p));
const Lock = req('cliLock.js');
const Api = req('api.js');
const Creds = req('credentials.js');
const ClaudeUsage = req('providers/claude/usage.js');

// --- synthetic values (built at runtime, never real) ------------------------------
const fakeToken = (kind, n) => ['sk', 'ant', kind, 'FAKE', String(n).padStart(24, '0')].join('-');
const ACCESS = fakeToken('oat01', 1);
const ACCESS_NEW = fakeToken('oat01', 2);
const REFRESH_NEW = fakeToken('ort01', 2);
const HOUR = 3_600_000;
const TOKEN_URLS = ['https://platform.claude.com/v1/oauth/token', 'https://console.anthropic.com/v1/oauth/token'];
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const usageJson = { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 34, resets_at: null } };

// Claude Code takes two proper-lockfile locks before it refreshes: the
// directory <config>/.oauth_refresh.lock, then the legacy <realpath(config)>.lock
const claudeDir = path.join(empty, '.claude');
fs.mkdirSync(claudeDir, { recursive: true });
const NEW_LOCK = path.join(claudeDir, '.oauth_refresh.lock');
const LEGACY_LOCK = `${claudeDir}.lock`;
const FAST_LOCK = { retries: 40, delayMs: 10, staleMs: 60_000, updateMs: 1_000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let refreshCount = 100;
const nextRefresh = () => fakeToken('ort01', ++refreshCount);

function logs() {
  const lines = [];
  const push = level => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

let fileCount = 0;
/** A credentials file Claude Code style; `name` defaults to a unique one. */
function credentialsFile(fields, { dir = empty, name } = {}) {
  const file = path.join(dir, name ?? `credentials-${++fileCount}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: ACCESS,
        refreshToken: nextRefresh(),
        expiresAt: Date.now() - HOUR,
        scopes: ['user:inference'],
        ...fields,
      },
      mcpOAuth: { example: { note: 'kept as is' } },
    }),
    { mode: 0o600 }
  );
  return file;
}
const stored = file => JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
function storeTokens(file, fields) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...data, claudeAiOauth: { ...data.claudeAiOauth, ...fields } }));
}

const tokenReply = extra =>
  new Response(JSON.stringify({ access_token: ACCESS_NEW, refresh_token: REFRESH_NEW, expires_in: 3600, ...extra }), {
    status: 200,
  });
const invalidGrant = (status = 400) =>
  new Response('{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}', { status });
const isExpired = error => error instanceof Creds.ClaudeLoginExpiredError;
const opts = extra => ({ proxy: 'direct', lock: FAST_LOCK, ...extra });
const tokenPosts = () => fetched.filter(f => TOKEN_URLS.includes(f.url));

beforeEach(() => {
  fetched.length = 0;
  fetchReply = null;
  proc.execFile = null;
  proc.spawn = null;
  proc.calls.length = 0;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const dir of [NEW_LOCK, LEGACY_LOCK]) fs.rmSync(dir, { recursive: true, force: true });
});

// --- the login state ------------------------------------------------------------

describe('signed out, expired or missing', () => {
  test('a store Claude Code signed out of is "Login expired", read-only', async () => {
    const file = credentialsFile({ accessToken: '', refreshToken: '', expiresAt: 0 });
    const before = fs.readFileSync(file, 'utf8');
    let caught;
    await assert.rejects(Api.fetchUsage({ credentialsPath: file, proxy: 'direct' }), error => {
      caught = error;
      return error instanceof Api.UsageError && error.code === 'unauthorized';
    });
    assert.equal(fetched.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!proc.calls.some(c => c.args.includes('add-generic-password') || c.kind === 'spawn'));
    assert.match(caught.message, /log in again/);
    assert.deepEqual(ClaudeUsage.claudeErrorText(caught), { title: 'Login expired', message: 'Run claude to log in' });
  });

  test('no credentials anywhere is still "Not logged in"', async () => {
    await assert.rejects(
      Api.fetchUsage({ credentialsPath: path.join(empty, 'missing.json'), proxy: 'direct' }),
      error => error instanceof Api.UsageError && error.code === 'no-credentials'
    );
  });

  test('not signed out: an access token alone, a refresh token alone, an env token', async () => {
    // a long-lived token without a refresh token (e.g. claude setup-token)
    const only = path.join(empty, `credentials-${++fileCount}.json`);
    fs.writeFileSync(only, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS } }));
    assert.equal(await Creds.getAccessToken(only, opts()), ACCESS);
    // a refresh token without an access token is refreshed
    fetchReply = async () => tokenReply();
    const refreshOnly = credentialsFile({ accessToken: '', expiresAt: 0 });
    assert.equal(await Creds.getAccessToken(refreshOnly, opts()), ACCESS_NEW);
    assert.equal(tokenPosts().length, 1);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = ACCESS;
    assert.equal(await Creds.getAccessToken(undefined, opts()), ACCESS);
  });

  test('Claude Code signing out while the plugin waits for its lock: "Login expired"', async () => {
    const file = credentialsFile();
    fs.mkdirSync(NEW_LOCK);
    setTimeout(() => {
      storeTokens(file, { accessToken: '', refreshToken: '', expiresAt: 0 });
      fs.rmdirSync(NEW_LOCK);
    }, 40);
    fetchReply = async () => tokenReply();
    await assert.rejects(Creds.getAccessToken(file, opts()), isExpired);
    assert.equal(fetched.length, 0);
  });
});

describe('invalid_grant', () => {
  test('from every endpoint: the login expired, and that refresh token is never posted again', async () => {
    const file = credentialsFile();
    const { refreshToken } = stored(file);
    const before = fs.readFileSync(file, 'utf8');
    fetchReply = async () => invalidGrant();
    const { lines, logger } = logs();
    await assert.rejects(Creds.getAccessToken(file, opts({ logger })), isExpired);
    assert.deepEqual(fetched.map(f => f.url), TOKEN_URLS);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(lines.some(l => /invalid_grant/.test(l)), lines.join('\n'));
    fetched.length = 0;
    await assert.rejects(Creds.getAccessToken(file, opts({ logger })), isExpired);
    await assert.rejects(
      Api.fetchUsage({ credentialsPath: file, proxy: 'direct' }),
      error => error instanceof Api.UsageError && error.code === 'unauthorized'
    );
    assert.equal(fetched.length, 0);
    assert.ok(lines.every(l => !l.includes(refreshToken)));
  });

  test('a dead refresh token is refused before taking the lock', async () => {
    const file = credentialsFile();
    fetchReply = async () => invalidGrant();
    await assert.rejects(Creds.getAccessToken(file, opts()), isExpired);
    fs.mkdirSync(NEW_LOCK); // would make a lock-first check wait for minutes
    const started = Date.now();
    await assert.rejects(Creds.getAccessToken(file, opts({ lock: { ...FAST_LOCK, delayMs: 1_000 } })), isExpired);
    assert.ok(Date.now() - started < 500);
  });

  test('a dead refresh token that lands in the store while waiting for the lock is not posted', async () => {
    const deadFile = credentialsFile();
    const dead = stored(deadFile).refreshToken;
    fetchReply = async () => invalidGrant();
    await assert.rejects(Creds.getAccessToken(deadFile, opts()), isExpired);
    const file = credentialsFile();
    fs.mkdirSync(NEW_LOCK);
    setTimeout(() => {
      storeTokens(file, { refreshToken: dead });
      fs.rmdirSync(NEW_LOCK);
    }, 40);
    fetched.length = 0;
    await assert.rejects(Creds.getAccessToken(file, opts()), isExpired);
    assert.equal(fetched.length, 0);
  });

  test('a new login (another refresh token) is refreshed again', async () => {
    fetchReply = async () => invalidGrant();
    await assert.rejects(Creds.getAccessToken(credentialsFile(), opts()), isExpired);
    const file = credentialsFile();
    fetched.length = 0;
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS_NEW);
  });

  test('only one endpoint saying invalid_grant does not kill the token', async () => {
    const file = credentialsFile();
    const replies = [async () => invalidGrant(), async () => {
      throw new TypeError('fetch failed');
    }];
    fetchReply = async () => replies.shift()();
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS);
    fetched.length = 0;
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS_NEW);
  });

  test('invalid_grant in a non-4xx answer is not a rejection', async () => {
    const file = credentialsFile();
    fetchReply = async () => invalidGrant(500);
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS);
    fetched.length = 0;
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS_NEW);
  });

  test('a pair Claude Code stored while ours was rejected is used, not "expired"', async () => {
    const file = credentialsFile();
    fetchReply = async () => {
      storeTokens(file, { accessToken: ACCESS_NEW, refreshToken: nextRefresh(), expiresAt: Date.now() + HOUR });
      return invalidGrant();
    };
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS_NEW);
  });
});

describe('what a refresh stores', () => {
  test('refresh_token_expires_in and scope update the stored fields, as Claude Code does', async () => {
    const file = credentialsFile({ refreshTokenExpiresAt: 1 });
    fetchReply = async () => tokenReply({ refresh_token_expires_in: 2_592_000, scope: 'user:inference user:profile' });
    const t0 = Date.now();
    await Creds.getAccessToken(file, opts());
    const t1 = Date.now();
    const saved = stored(file);
    assert.ok(saved.refreshTokenExpiresAt >= t0 + 2_592_000_000 && saved.refreshTokenExpiresAt <= t1 + 2_592_000_000);
    assert.deepEqual(saved.scopes, ['user:inference', 'user:profile']);
    assert.equal(saved.refreshToken, REFRESH_NEW);
  });

  test('an answer without them keeps the stored values, and keeps the refresh token it lacks', async () => {
    const until = Date.now() + 240 * HOUR;
    const file = credentialsFile({ refreshTokenExpiresAt: until });
    const { refreshToken } = stored(file);
    fetchReply = async () =>
      new Response(JSON.stringify({ access_token: ACCESS_NEW, expires_in: 3600 }), { status: 200 });
    await Creds.getAccessToken(file, opts());
    const saved = stored(file);
    assert.equal(saved.refreshTokenExpiresAt, until);
    assert.deepEqual(saved.scopes, ['user:inference']);
    assert.equal(saved.refreshToken, refreshToken);
    assert.equal(saved.accessToken, ACCESS_NEW);
  });

  test('the file is replaced atomically, private, with no temp file left', async () => {
    const dir = fs.mkdtempSync(path.join(empty, 'store-'));
    const file = credentialsFile({}, { dir });
    fetchReply = async () => tokenReply();
    await Creds.getAccessToken(file, opts());
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('a login that changed during the request is not overwritten', async () => {
    const file = credentialsFile();
    const other = nextRefresh();
    fetchReply = async () => {
      // Claude Code logs in again meanwhile
      storeTokens(file, { accessToken: ACCESS, refreshToken: other, expiresAt: Date.now() + HOUR });
      return tokenReply();
    };
    const { lines, logger } = logs();
    assert.equal(await Creds.getAccessToken(file, opts({ logger })), ACCESS_NEW);
    assert.equal(stored(file).refreshToken, other);
    assert.ok(lines.some(l => /changed/.test(l)), lines.join('\n'));
  });

  test('a sign-out during the request stays signed out', async () => {
    const file = credentialsFile();
    fetchReply = async () => {
      storeTokens(file, { accessToken: '', refreshToken: '', expiresAt: 0 });
      return tokenReply();
    };
    await Creds.getAccessToken(file, opts());
    assert.equal(stored(file).accessToken, '');
    assert.equal(stored(file).refreshToken, '');
  });

  test('a store the plugin cannot write is not refreshed at all', async () => {
    const dir = fs.mkdtempSync(path.join(empty, 'readonly-'));
    const file = credentialsFile({}, { dir });
    fs.chmodSync(dir, 0o500);
    try {
      fetchReply = async () => tokenReply();
      const { lines, logger } = logs();
      assert.equal(await Creds.getAccessToken(file, opts({ logger })), ACCESS);
      assert.equal(tokenPosts().length, 0);
      assert.ok(lines.some(l => /cannot write|not writable/i.test(l)), lines.join('\n'));
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('after a 401', () => {
  test('a token Claude Code stored after the rejected one is used without refreshing', async () => {
    const file = credentialsFile({ expiresAt: Date.now() + HOUR });
    let usageCalls = 0;
    fetchReply = async url => {
      if (url !== USAGE_URL) return tokenReply();
      usageCalls++;
      if (usageCalls === 1) {
        storeTokens(file, { accessToken: ACCESS_NEW, refreshToken: nextRefresh(), expiresAt: Date.now() + HOUR });
        return new Response('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 });
      }
      return new Response(JSON.stringify(usageJson), { status: 200 });
    };
    assert.deepEqual(await Api.fetchUsage({ credentialsPath: file, proxy: 'direct' }), usageJson);
    assert.equal(tokenPosts().length, 0);
    assert.equal(fetched[1].init.headers.Authorization, `Bearer ${ACCESS_NEW}`);
  });

  test('forced, and Claude Code stores a new token while the plugin waits for its lock: adopted, not refreshed', async () => {
    const file = credentialsFile({ expiresAt: Date.now() + HOUR });
    fs.mkdirSync(NEW_LOCK);
    setTimeout(() => {
      storeTokens(file, { accessToken: ACCESS_NEW, refreshToken: nextRefresh(), expiresAt: Date.now() + HOUR });
      fs.rmdirSync(NEW_LOCK);
    }, 40);
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(file, opts({ force: true, rejectedToken: ACCESS })), ACCESS_NEW);
    assert.equal(tokenPosts().length, 0);
  });

  test('forced, with a newer token already stored: used at once, without waiting for the lock', async () => {
    const file = credentialsFile({ accessToken: ACCESS_NEW, expiresAt: Date.now() + HOUR });
    fs.mkdirSync(NEW_LOCK);
    const started = Date.now();
    const token = await Creds.getAccessToken(
      file,
      opts({ force: true, rejectedToken: ACCESS, lock: { ...FAST_LOCK, retries: 1, delayMs: 1_000 } })
    );
    assert.equal(token, ACCESS_NEW);
    assert.ok(Date.now() - started < 500);
  });

  test('forced with the rejected token: an unchanged store is refreshed', async () => {
    const file = credentialsFile({ expiresAt: Date.now() + HOUR });
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(file, opts({ force: true, rejectedToken: ACCESS })), ACCESS_NEW);
    assert.equal(tokenPosts().length, 1);
  });
});

describe("Claude Code's refresh lock", () => {
  test('the refresh runs while holding both locks, new one first; both are released', async () => {
    let held = null;
    fetchReply = async () => {
      held = [fs.existsSync(NEW_LOCK), fs.existsSync(LEGACY_LOCK)];
      return tokenReply();
    };
    assert.equal(await Creds.getAccessToken(credentialsFile(), opts()), ACCESS_NEW);
    assert.deepEqual(held, [true, true]);
    assert.ok(!fs.existsSync(NEW_LOCK) && !fs.existsSync(LEGACY_LOCK));
  });

  test("the lock folder is the credentials file's folder when it is Claude Code's .credentials.json", async () => {
    const dir = fs.mkdtempSync(path.join(empty, 'config-'));
    const file = credentialsFile({}, { dir, name: '.credentials.json' });
    let held = null;
    fetchReply = async () => {
      held = [fs.existsSync(path.join(dir, '.oauth_refresh.lock')), fs.existsSync(`${dir}.lock`), fs.existsSync(NEW_LOCK)];
      return tokenReply();
    };
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS_NEW);
    assert.deepEqual(held, [true, true, false]);
  });

  test('without a Claude Code folder nothing is locked and no folder is created', async () => {
    const missing = path.join(empty, 'no-such-config');
    process.env.CLAUDE_CONFIG_DIR = missing;
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(credentialsFile(), opts()), ACCESS_NEW);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.existsSync(`${missing}.lock`), false);
  });

  test('while Claude Code holds the lock the plugin waits, then uses the token Claude Code stored', async () => {
    const file = credentialsFile();
    fs.mkdirSync(NEW_LOCK);
    setTimeout(() => {
      storeTokens(file, { accessToken: ACCESS_NEW, refreshToken: nextRefresh(), expiresAt: Date.now() + HOUR });
      fs.rmdirSync(NEW_LOCK);
    }, 60);
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(file, opts()), ACCESS_NEW);
    assert.equal(fetched.length, 0);
  });

  test('a lock that stays held: no refresh this time', async () => {
    fs.mkdirSync(NEW_LOCK);
    fetchReply = async () => tokenReply();
    const { lines, logger } = logs();
    assert.equal(await Creds.getAccessToken(credentialsFile(), opts({ logger, lock: { ...FAST_LOCK, retries: 3 } })), ACCESS);
    assert.equal(fetched.length, 0);
    assert.ok(lines.some(l => /Claude Code is refreshing/.test(l)), lines.join('\n'));
  });

  test('only the legacy lock held: no refresh, and the new lock is released again', async () => {
    fs.mkdirSync(LEGACY_LOCK);
    fetchReply = async () => tokenReply();
    await Creds.getAccessToken(credentialsFile(), opts({ lock: { ...FAST_LOCK, retries: 3 } }));
    assert.equal(fetched.length, 0);
    assert.equal(fs.existsSync(NEW_LOCK), false);
  });

  test('an abandoned lock (untouched for longer than stale) is taken over', async () => {
    fs.mkdirSync(NEW_LOCK);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(NEW_LOCK, old, old);
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(credentialsFile(), opts()), ACCESS_NEW);
    assert.equal(fs.existsSync(NEW_LOCK), false);
  });

  test('a lock that cannot be taken: no refresh, nothing left behind, no paths in the log', async () => {
    const parent = fs.mkdtempSync(path.join(empty, 'locked-'));
    const config = path.join(parent, 'cfg');
    fs.mkdirSync(config);
    process.env.CLAUDE_CONFIG_DIR = config;
    fs.chmodSync(parent, 0o500); // the legacy lock <config>.lock cannot be created
    try {
      fetchReply = async () => tokenReply();
      const { lines, logger } = logs();
      assert.equal(await Creds.getAccessToken(credentialsFile(), opts({ logger })), ACCESS);
      assert.equal(fetched.length, 0);
      assert.equal(fs.existsSync(path.join(config, '.oauth_refresh.lock')), false);
      const warning = lines.find(l => /refresh lock/.test(l));
      assert.ok(warning, lines.join('\n'));
      assert.ok(!warning.includes(empty), warning);
      // and with the new lock held as well, it waits for Claude Code instead
      fs.mkdirSync(path.join(config, '.oauth_refresh.lock'));
      lines.length = 0;
      await Creds.getAccessToken(credentialsFile(), opts({ logger, lock: { ...FAST_LOCK, retries: 2 } }));
      assert.ok(lines.some(l => /Claude Code is refreshing/.test(l)), lines.join('\n'));
      fs.rmdirSync(path.join(config, '.oauth_refresh.lock'));
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });

  test('two keys refreshing at once send one request', async () => {
    const file = credentialsFile();
    fetchReply = async () => {
      await sleep(20);
      return tokenReply();
    };
    const [a, b] = await Promise.all([Creds.getAccessToken(file, opts()), Creds.getAccessToken(file, opts())]);
    assert.deepEqual([a, b], [ACCESS_NEW, ACCESS_NEW]);
    assert.equal(tokenPosts().length, 1);
  });
});

describe('deadlines', () => {
  test('a refresh request that never answers is abandoned, not retried elsewhere, and the locks are released', async () => {
    fetchReply = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason));
      });
    const { lines, logger } = logs();
    const started = Date.now();
    // AbortSignal.timeout's timer does not hold the event loop open (in
    // FlexDesigner the plugin's connection does); keep the test runner alive
    const keepAlive = setInterval(() => undefined, 20);
    let token;
    try {
      token = await Creds.getAccessToken(credentialsFile(), opts({ logger, requestTimeoutMs: 80 }));
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(token, ACCESS);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(tokenPosts().length, 1);
    assert.ok(!fs.existsSync(NEW_LOCK) && !fs.existsSync(LEGACY_LOCK));
    assert.ok(lines.some(l => /timed out|not sent again/.test(l)), lines.join('\n'));
  });
});

describe('cliLock', () => {
  const target = () => path.join(fs.mkdtempSync(path.join(empty, 'lock-')), 'thing');

  test('the holder keeps the lock fresh', async () => {
    const t = target();
    const release = await Lock.acquireCliLock(t, { ...FAST_LOCK, updateMs: 15 }, sleep);
    const old = new Date(Date.now() - 50_000);
    fs.utimesSync(`${t}.lock`, old, old);
    await sleep(60);
    assert.ok(Date.now() - fs.statSync(`${t}.lock`).mtimeMs < 1_000);
    await release();
    assert.equal(fs.existsSync(`${t}.lock`), false);
  });

  test('a holder stops refreshing after maxHoldMs, so a wedged holder goes stale', async () => {
    const t = target();
    const release = await Lock.acquireCliLock(t, { ...FAST_LOCK, updateMs: 10, maxHoldMs: 40 }, sleep);
    await sleep(80);
    const before = fs.statSync(`${t}.lock`).mtimeMs;
    await sleep(60);
    assert.equal(fs.statSync(`${t}.lock`).mtimeMs, before);
    await release();
  });

  test('a released holder never removes a lock someone else took over', async () => {
    const t = target();
    const releaseA = await Lock.acquireCliLock(t, { ...FAST_LOCK, updateMs: 60_000 }, sleep);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(`${t}.lock`, old, old);
    const releaseB = await Lock.acquireCliLock(t, FAST_LOCK, sleep);
    assert.ok(releaseB);
    await releaseA();
    assert.equal(fs.existsSync(`${t}.lock`), true);
    await releaseB();
    assert.equal(fs.existsSync(`${t}.lock`), false);
  });

  test('the lock directory is private', async () => {
    const t = target();
    const release = await Lock.acquireCliLock(t, FAST_LOCK, sleep);
    assert.equal(fs.statSync(`${t}.lock`).mode & 0o777, 0o700);
    await release();
  });
});

// --- the Keychain store (macOS) ---------------------------------------------------

/** A fake child_process.spawn for `security -i`: records stdin, then exits with `code`. */
function fakeSpawn(codes = [0]) {
  const calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    const call = { file, args: [...args], stdin: '' };
    calls.push(call);
    const code = codes[Math.min(calls.length - 1, codes.length - 1)];
    child.stdout = null;
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        call.stdin += chunk.toString('utf8');
        cb();
      },
      final(cb) {
        cb();
        setImmediate(() => {
          if (code !== 0) child.stderr.write('add-generic-password: returned -25308\n');
          child.stderr.end();
          setTimeout(() => child.emit('close', code, null), 5);
        });
      },
    });
    return child;
  };
  return { spawn, calls };
}

describe('Keychain store', { skip: process.platform !== 'darwin' && 'the Keychain is macOS only' }, () => {
  const item = () =>
    JSON.stringify({
      claudeAiOauth: { accessToken: ACCESS, refreshToken: nextRefresh(), expiresAt: Date.now() - HOUR },
      mcpOAuth: { example: { note: 'kept as is' } },
    });
  /** security: -w prints the secret, without it the attributes (account `acct`). */
  const keychain = (secret, acct = 'someone-else') => (file, args) => {
    assert.equal(file, '/usr/bin/security');
    if (args[0] !== 'find-generic-password') return { error: new Error('unexpected') };
    return args.includes('-w')
      ? { stdout: `${secret()}\n` }
      : { stdout: `keychain: "/Users/you/Library/Keychains/login.keychain-db"\nattributes:\n    "acct"<blob>="${acct}"\n    "svce"<blob>="Claude Code-credentials"\n` };
  };

  test("the write reuses the item's own account, and every read has a timeout", async () => {
    let secret = item();
    proc.execFile = keychain(() => secret);
    const child = fakeSpawn();
    proc.spawn = child.spawn;
    fetchReply = async () => tokenReply();
    assert.equal(await Creds.getAccessToken(undefined, opts()), ACCESS_NEW);
    assert.equal(child.calls.length, 1);
    assert.match(child.calls[0].stdin, /^add-generic-password -U -a "someone-else" -s "Claude Code-credentials" -X [0-9a-f]+\n$/);
    for (const call of proc.calls.filter(c => c.kind === 'execFile')) {
      assert.ok(call.options?.timeout > 0, JSON.stringify(call.args));
    }
  });

  test('a pair whose write failed is written on the next poll, not refreshed again', async () => {
    let secret = item();
    proc.execFile = keychain(() => secret);
    const child = fakeSpawn([1, 0]);
    proc.spawn = child.spawn;
    fetchReply = async () => tokenReply();
    const { lines, logger } = logs();
    assert.equal(await Creds.getAccessToken(undefined, opts({ logger })), ACCESS_NEW);
    assert.equal(tokenPosts().length, 1);
    // the store still holds the old, rotated-away pair
    assert.equal(await Creds.getAccessToken(undefined, opts({ logger })), ACCESS_NEW);
    assert.equal(tokenPosts().length, 1);
    assert.equal(child.calls.length, 2);
    const written = JSON.parse(Buffer.from(child.calls[1].stdin.match(/-X ([0-9a-f]+)/)[1], 'hex').toString('utf8'));
    assert.equal(written.claudeAiOauth.refreshToken, REFRESH_NEW);
    assert.ok(lines.every(l => !l.includes(ACCESS_NEW) && !l.includes(REFRESH_NEW)));
  });
});
