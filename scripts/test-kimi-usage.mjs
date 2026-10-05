// Tests for the Kimi usage source (src/providers/kimi/usage*.ts), run against
// the tsc output of `npm run test:kimi-usage` (.test-build-kimi-usage/).
// Rules: synthetic fixtures only (see CLAUDE.md), no network (fetch is a
// stub everywhere), never read the real home folder (HOME points at an empty
// temp folder), token-shaped strings are built at runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
for (const name of [
  'KIMI_CODE_HOME',
  'KIMI_SHARE_DIR',
  'KIMI_CODE_BASE_URL',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_OAUTH_HOST',
  'KIMI_DISABLE_OAUTH_LOCK',
]) {
  delete process.env[name];
}
const offline = async () => {
  throw new Error('network is disabled in tests');
};
globalThis.fetch = offline;
after(() => fs.rmSync(empty, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.KIMI_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-kimi-usage');
const req = p => require(path.join(build, p));
const U = req('providers/kimi/usage.js');
const Api = req('providers/kimi/usageApi.js');
const Auth = req('providers/kimi/usageAuth.js');
const Cfg = req('providers/kimi/usageConfig.js');
const Ctx = req('providers/kimi/usageContext.js');
const Kit = req('providers/kit.js');
const { UsageKeys } = req('usageKey.js');
const { KIMI_BRAND } = req('providers/kimi/brand.js');

const FIXED = Date.parse('2026-10-05T12:00:00.000Z');
const HOUR = 3_600_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GLOBAL_SLOT = 'kimi-code-env-0e4f99c69cc27850';
const convKey = n =>
  `agent:main:main:conversation:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// token-shaped strings exist only at runtime
let serial = 0;
const secret = kind =>
  ['kimi', 'TEST', kind, String(++serial).padStart(4, '0'), 'q'.repeat(20)].join('-');

beforeEach(() => {
  U.resetUsageState();
  Auth.resetAuthState();
  globalThis.fetch = offline;
});

// --- fixtures ------------------------------------------------------------------

let caseNo = 0;
function tree() {
  const root = path.join(empty, `case-${++caseNo}`);
  fs.mkdirSync(root);
  const code = path.join(root, 'kimi-code');
  const desktop = path.join(root, 'kimi-desktop');
  return { root, code, desktop, config: { kimiDir: code, kimiDesktopDir: desktop } };
}

function writeLogin(code, fields, name = 'kimi-code') {
  const dir = path.join(code, 'credentials');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(fields, null, 2), { mode: 0o600 });
  return file;
}

function login(code, { expiresInMs = 2 * HOUR, name, extra = {}, base = FIXED } = {}) {
  const access = secret('access');
  const refresh = secret('refresh');
  const file = writeLogin(
    code,
    {
      access_token: access,
      refresh_token: refresh,
      expires_at: Math.floor((base + expiresInMs) / 1000),
      scope: '',
      token_type: 'Bearer',
      expires_in: 3600,
      ...extra,
    },
    name
  );
  return { access, refresh, file };
}

function writeDesktop(desktop, { usage, statuses, archive } = {}) {
  const dir = path.join(desktop, 'kimi-agent');
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, value) =>
    value !== undefined &&
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  put('conversation-context-usage.json', usage);
  put('conversation-statuses.json', statuses);
  put('conversation-archive.json', archive);
}

const ctxEntry = (contextUsage, updatedAt) => ({
  contextUsage,
  contextTokens: Math.round(contextUsage * 262144),
  maxContextTokens: 262144,
  remainingContextTokens: 0,
  model: 'k3-agent',
  updatedAt: new Date(updatedAt).toISOString(),
});

const CURRENT = {
  goods_version: 2,
  usages: {
    limit_5h: { used_ratio: 0.3, reset_time: '2026-10-05T15:12:00Z' },
    limit_7d: { used_ratio: '0.2', reset_time: '2026-10-11T00:00:00Z' },
    limit_month_total: { used_ratio: 0.4, reset_time: '2026-11-01T00:00:00Z' },
    limit_month_code: { used_ratio: 0.25, reset_time: '2026-11-01T00:00:00Z' },
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: '20000000000', amountLeft: '15000000000' },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { currency: 'CNY', priceInCents: '20000' },
    monthlyUsed: { currency: 'CNY', priceInCents: '5000' },
  },
};

const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A fetch stub: routes by URL substring; every call is recorded. */
function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    for (const [match, handler] of Object.entries(routes)) {
      if (call.url.includes(match)) return handler(call, calls);
    }
    throw new Error('unexpected request');
  };
  fn.calls = calls;
  fn.gets = () => calls.filter(c => c.url.endsWith('/usages'));
  fn.posts = () => calls.filter(c => c.url.endsWith('/api/oauth/token'));
  return fn;
}

function deps(fetch, overrides = {}) {
  return {
    fetch,
    now: () => FIXED,
    sleep: async () => {},
    platform: 'darwin',
    env: {},
    lock: { retries: 3, delayMs: 1, staleMs: 5_000, updateMs: 1_000 },
    ...overrides,
  };
}

const authOf = call => new Headers(call.init.headers).get('authorization');

/** Asserts a ProviderError with this code and that no secret leaks. */
function expectError(code, secrets = []) {
  return error => {
    assert.ok(error instanceof Kit.ProviderError, `${error?.stack ?? error}`);
    assert.equal(error.code, code, error.message);
    const texts = [error.message, U.usageSource.logText(error)];
    for (const lang of ['en', 'zh']) {
      const t = Kit.errorKeyText(error, KIMI_BRAND, lang);
      texts.push(t.title, t.message);
    }
    for (const s of secrets) {
      for (const text of texts) assert.ok(!text.includes(s), 'secret leaked');
    }
    return true;
  };
}

const keyText = (error, lang = 'en') => Kit.errorKeyText(error, KIMI_BRAND, lang);

// --- config.toml and endpoint ------------------------------------------------------

describe('config.toml and the usage endpoint', () => {
  test('reads string values of tables, sub-tables and inline tables', () => {
    const toml = [
      '﻿# Kimi Code config',
      'default_model = "kimi-code/k3"  # trailing comment',
      '',
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      "base_url = 'https://api.kimi.ai/coding/v1/'",
      'oauth = { storage = "file", key = "oauth/kimi-code-env-1", oauth_host = "https://auth.kimi.ai" }',
      '',
      '[models."kimi-code/k3"]',
      'capabilities = [',
      '  "thinking",',
      '  "[not.a.header]",',
      ']',
      'note = """',
      '[providers."managed:kimi-code"]',
      'base_url = "https://wrong.test"',
      '"""',
      'escaped = "a\\"b\\u00e9"',
      '[[services.list]]',
      'base_url = "https://ignored.test"',
    ].join('\n');
    const map = Cfg.readTomlStrings(toml);
    const get = (...keys) => map.get(keys.join('\u0000'));
    assert.equal(get('default_model'), 'kimi-code/k3');
    assert.equal(get('providers', 'managed:kimi-code', 'base_url'), 'https://api.kimi.ai/coding/v1/');
    assert.equal(get('providers', 'managed:kimi-code', 'oauth', 'key'), 'oauth/kimi-code-env-1');
    assert.equal(get('providers', 'managed:kimi-code', 'oauth', 'oauth_host'), 'https://auth.kimi.ai');
    assert.equal(get('models', 'kimi-code/k3', 'escaped'), 'a"bé');
    for (const value of map.values()) {
      assert.ok(!value.includes('wrong.test') && !value.includes('ignored.test'));
    }
  });

  test('sub-table form of the oauth reference', () => {
    const map = Cfg.readTomlStrings(
      '[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\n'
    );
    assert.equal(map.get(['providers', 'managed:kimi-code', 'oauth', 'key'].join('\u0000')), 'oauth/kimi-code');
  });

  test('defaults: mainland endpoint and the kimi-code slot', () => {
    assert.deepEqual(Cfg.resolveEndpoint({ env: {} }), {
      baseUrl: 'https://api.kimi.com/coding/v1',
      oauthHost: 'https://auth.kimi.com',
      credentialName: 'kimi-code',
      configured: false,
    });
  });

  test('a global login: api.kimi.ai, auth.kimi.ai and the scoped slot', () => {
    const configText = [
      '[providers."managed:kimi-code"]',
      'base_url = "https://api.kimi.ai/coding/v1"',
      `oauth = { storage = "file", key = "oauth/${GLOBAL_SLOT}", oauth_host = "https://auth.kimi.ai" }`,
    ].join('\n');
    assert.deepEqual(Cfg.resolveEndpoint({ env: {}, configText }), {
      baseUrl: 'https://api.kimi.ai/coding/v1',
      oauthHost: 'https://auth.kimi.ai',
      credentialName: GLOBAL_SLOT,
      configured: true,
    });
  });

  test('the region marker applies only before the first login', () => {
    const marker = Cfg.resolveEndpoint({ env: {}, regionText: 'global\n' });
    assert.equal(marker.baseUrl, 'https://api.kimi.ai/coding/v1');
    assert.equal(marker.credentialName, GLOBAL_SLOT);
    const configured = Cfg.resolveEndpoint({
      env: {},
      regionText: 'global',
      configText: '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.com/coding/v1"\n',
    });
    assert.equal(configured.baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(configured.credentialName, 'kimi-code');
  });

  test('environment overrides win over config.toml', () => {
    const configText = '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n';
    const env = { KIMI_CODE_BASE_URL: 'https://api.example.test/coding/v1///' };
    const out = Cfg.resolveEndpoint({ env, configText });
    assert.equal(out.baseUrl, 'https://api.example.test/coding/v1');
    assert.equal(out.oauthHost, 'https://auth.kimi.com');
    assert.equal(out.credentialName, Cfg.credentialNameOf(Cfg.oauthKeyFor('https://auth.kimi.com', out.baseUrl)));
    assert.match(out.credentialName, /^kimi-code-env-[0-9a-f]{16}$/);
    const host = Cfg.resolveEndpoint({ env: { KIMI_OAUTH_HOST: 'https://auth.example.test/' } });
    assert.equal(host.oauthHost, 'https://auth.example.test');
  });

  test('slot names never leave the credentials folder', () => {
    assert.equal(Cfg.credentialNameOf('oauth/kimi-code'), 'kimi-code');
    assert.equal(Cfg.credentialNameOf('oauth/../../x'), null);
    assert.equal(Cfg.credentialNameOf('oauth/.hidden'), null);
    assert.equal(Cfg.credentialNameOf('oauth/'), null);
  });

  test('bearer tokens only go to https (or this computer)', () => {
    assert.ok(Cfg.isSafeUrl('https://api.kimi.com/coding/v1/usages'));
    assert.ok(Cfg.isSafeUrl('http://localhost:8080/usages'));
    assert.ok(!Cfg.isSafeUrl('http://api.example.test/usages'));
    assert.ok(!Cfg.isSafeUrl('ftp://api.example.test/usages'));
    assert.ok(!Cfg.isSafeUrl('not a url'));
  });
});

// --- payloads ------------------------------------------------------------------

describe('usage payloads', () => {
  test('current shape: ratios, reset times and the booster wallet', () => {
    const metrics = Api.parseUsagePayload(CURRENT, FIXED);
    assert.deepEqual(metrics, [
      { id: '5h', label: '5h', percent: 30, resetsAt: '2026-10-05T15:12:00.000Z' },
      { id: 'weekly', label: 'Weekly', percent: 20, resetsAt: '2026-10-11T00:00:00.000Z' },
      { id: 'monthly', label: 'Month', percent: 40, resetsAt: '2026-11-01T00:00:00.000Z' },
      { id: 'monthly_code', label: 'Code', percent: 25, resetsAt: '2026-11-01T00:00:00.000Z' },
      { id: 'extra', label: 'Extra', percent: 25, resetsAt: null },
    ]);
  });

  test('percent: rounds up like the CLI, no float noise, clamped', () => {
    assert.equal(Api.percentFromRatio(0.3), 30);
    assert.equal(Api.percentFromRatio(0.07), 7);
    assert.equal(Api.percentFromRatio(0.001), 1);
    assert.equal(Api.percentFromRatio(0.421), 43);
    assert.equal(Api.percentFromRatio(0), 0);
    assert.equal(Api.percentFromRatio(-0.2), 0);
    assert.equal(Api.percentFromRatio(1.7), 100);
    assert.equal(Api.percentFromRatio(Number.NaN), 0);
  });

  test('missing, partial and odd entries are skipped', () => {
    const metrics = Api.parseUsagePayload(
      {
        usages: {
          limit_5h: { used_ratio: 'n/a' },
          limit_7d: { used_ratio: 0.5, reset_time: 'not a time' },
          limit_month_total: null,
        },
        boosterWallet: { balance: { type: 'OTHER', amount: '1', amountLeft: '0' } },
      },
      FIXED
    );
    assert.deepEqual(metrics, [{ id: 'weekly', label: 'Weekly', percent: 50, resetsAt: null }]);
    assert.deepEqual(Api.parseUsagePayload(null), []);
    assert.deepEqual(Api.parseUsagePayload([1, 2]), []);
    assert.deepEqual(Api.parseUsagePayload({ usages: 'x', limits: 'y' }), []);
  });

  test('legacy shape: weekly summary and windowed limits', () => {
    const metrics = Api.parseUsagePayload(
      {
        usage: { used: 120, limit: 1000, resetTime: '2026-10-11T00:00:00Z' },
        limits: [
          { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: 40, limit: 200, resetTime: '2026-10-05T17:00:00Z' } },
          { window: { duration: 1, timeUnit: 'TIME_UNIT_HOUR' }, detail: { remaining: 75, limit: 100, reset_in: 1800 } },
          { window: { duration: 30, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: 1, limit: 3 } },
          { name: 'Burst', used: 5, limit: 10 },
          { window: { duration: 2, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: 1, limit: 0 } },
          'junk',
        ],
      },
      FIXED
    );
    assert.deepEqual(metrics, [
      { id: '5h', label: '5h', percent: 20, resetsAt: '2026-10-05T17:00:00.000Z' },
      { id: 'weekly', label: 'Weekly', percent: 12, resetsAt: '2026-10-11T00:00:00.000Z' },
      { id: 'monthly', label: 'Month', percent: 34, resetsAt: null },
      { id: 'limit_3600s', label: '1h', percent: 25, resetsAt: new Date(FIXED + 1_800_000).toISOString() },
      { id: 'limit_4', label: 'Burst', percent: 50, resetsAt: null },
    ]);
  });

  test('both shapes in one payload: the current one wins', () => {
    const metrics = Api.parseUsagePayload(
      {
        usages: { limit_7d: { used_ratio: 0.9 } },
        usage: { used: 1, limit: 100 },
        limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { used: 1, limit: 2 } }],
      },
      FIXED
    );
    assert.deepEqual(metrics.map(m => [m.id, m.percent]), [['5h', 50], ['weekly', 90]]);
  });
});

// --- the request ---------------------------------------------------------------

describe('GET /usages', () => {
  const BASE = 'https://api.kimi.com/coding/v1';

  test('sends exactly the bearer token and Accept, nothing else', async () => {
    const token = secret('access');
    const fetch = stubFetch({ '/usages': () => json(CURRENT) });
    const out = await Api.requestUsage(BASE, token, fetch, FIXED);
    assert.equal(out.kind, 'ok');
    assert.equal(fetch.calls.length, 1);
    const [call] = fetch.calls;
    assert.equal(call.url, `${BASE}/usages`);
    assert.equal(call.init.method ?? 'GET', 'GET');
    assert.deepEqual(Object.keys(call.init.headers).sort(), ['Accept', 'Authorization']);
    assert.equal(call.init.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.ok(call.init.signal, 'request has a timeout');
  });

  test('status codes map to error codes', async () => {
    const token = secret('access');
    const run = response => Api.requestUsage(BASE, token, async () => response(), FIXED);
    assert.deepEqual(await run(() => json({}, 401)), { kind: 'unauthorized' });
    await assert.rejects(run(() => json({ message: 'nope' }, 404)), expectError('unsupported', [token]));
    const e404 = await run(() => json({}, 404)).catch(e => e);
    assert.deepEqual(keyText(e404), { title: 'No plan usage', message: 'Needs a Kimi Code plan' });
    assert.deepEqual(keyText(e404, 'zh'), { title: '无套餐用量', message: '需要 Kimi Code 套餐' });

    const e429 = await run(() => json({}, 429, { 'retry-after': '120' })).catch(e => e);
    expectError('rate-limited', [token])(e429);
    assert.equal(e429.retryAfterSeconds, 120);
    assert.equal(Kit.lockoutSeconds(e429), 120);
    const date = new Date(FIXED + 90_000).toUTCString();
    const e429d = await run(() => json({}, 429, { 'retry-after': date })).catch(e => e);
    assert.equal(e429d.retryAfterSeconds, 90);
    const e429n = await run(() => json({}, 429)).catch(e => e);
    assert.equal(Kit.lockoutSeconds(e429n), Kit.DEFAULT_LOCKOUT_SECONDS);

    const e500 = await run(() => json({}, 503)).catch(e => e);
    expectError('http', [token])(e500);
    assert.deepEqual(keyText(e500), { title: 'Usage error', message: 'HTTP 503' });
    assert.equal(Kit.lockoutSeconds(e500), null);
  });

  test('network failures and timeouts', async () => {
    const token = secret('access');
    const refused = Object.assign(new Error('fetch failed'), {
      cause: new Error(`connect ECONNREFUSED Bearer ${token}`),
    });
    await assert.rejects(
      Api.requestUsage(BASE, token, async () => { throw refused; }, FIXED),
      expectError('network', [token])
    );
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const e = await Api.requestUsage(BASE, token, async () => { throw timeout; }, FIXED).catch(x => x);
    expectError('network', [token])(e);
    assert.match(e.message, /timed out/);
    assert.deepEqual(keyText(e, 'zh'), { title: '网络错误', message: '请检查网络连接' });
  });

  test('a body that is not JSON is never quoted', async () => {
    const token = secret('access');
    const body = `<html>${token}</html>`;
    const e = await Api.requestUsage(BASE, token, async () => json(body), FIXED).catch(x => x);
    expectError('parse', [token, '<html>'])(e);
    const e2 = await Api.requestUsage(BASE, token, async () => json([1]), FIXED).catch(x => x);
    expectError('parse', [token])(e2);
  });

  test('never sends the token to a plain-http host', async () => {
    const fetch = stubFetch({});
    await assert.rejects(
      Api.requestUsage('http://api.example.test/coding/v1', secret('access'), fetch, FIXED),
      expectError('not-configured')
    );
    assert.equal(fetch.calls.length, 0);
  });
});

// --- the Kimi Work context ---------------------------------------------------------

describe('Kimi Work context metric', () => {
  test('prefers the running task, then the most recent; skips archived ones', async () => {
    const t = tree();
    writeDesktop(t.desktop, {
      usage: {
        [convKey(1)]: ctxEntry(0.12, FIXED - 10 * 60_000),
        [convKey(2)]: ctxEntry(0.5, FIXED - 60_000),
        [convKey(3)]: ctxEntry(0.9, FIXED),
        [convKey(4)]: { contextUsage: 'x' },
      },
      statuses: { [convKey(1)]: 'running', [convKey(2)]: 'completed', [convKey(3)]: 'completed' },
      archive: { [convKey(3)]: { title: 'Synthetic', archivedAt: 'x' } },
    });
    assert.deepEqual(await Ctx.readContextMetric(t.desktop), {
      id: 'context', label: 'Context', percent: 12, resetsAt: null,
    });
    // nothing running: the most recently updated, not archived (legacy array form)
    writeDesktop(t.desktop, {
      statuses: { [convKey(1)]: 'completed' },
      archive: [convKey(3)],
    });
    assert.equal((await Ctx.readContextMetric(t.desktop)).percent, 50);
  });

  test('no file, a broken file or no usable entry: no metric', async () => {
    const t = tree();
    assert.equal(await Ctx.readContextMetric(t.desktop), null);
    fs.mkdirSync(path.join(t.desktop, 'kimi-agent'), { recursive: true });
    fs.writeFileSync(path.join(t.desktop, 'kimi-agent', 'conversation-context-usage.json'), '{"broken');
    assert.equal(await Ctx.readContextMetric(t.desktop), null);
    writeDesktop(t.desktop, { usage: { [convKey(1)]: { contextUsage: null } } });
    assert.equal(await Ctx.readContextMetric(t.desktop), null);
  });
});

// --- fetchKimiUsage: what is installed ----------------------------------------------

describe('what is installed', () => {
  test('nothing: "Kimi not found", no request', async () => {
    const t = tree();
    const fetch = stubFetch({});
    const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
    expectError('not-installed')(e);
    assert.deepEqual(keyText(e), { title: 'Kimi not found', message: 'Install Kimi Code' });
    assert.deepEqual(keyText(e, 'zh'), { title: '未找到 Kimi', message: '请安装 Kimi Code' });
    assert.equal(fetch.calls.length, 0);
  });

  test('desktop app only, Kimi Work never used: "Log in with Kimi Code"', async () => {
    const t = tree();
    fs.mkdirSync(t.desktop, { recursive: true });
    const e = await U.fetchKimiUsage(t.config, deps(stubFetch({}))).catch(x => x);
    expectError('not-configured')(e);
    assert.deepEqual(keyText(e), { title: 'No usage data', message: 'Log in with Kimi Code' });
    assert.deepEqual(keyText(e, 'zh'), { title: '暂无用量数据', message: '请登录 Kimi Code' });
  });

  test('desktop app with a Kimi Work task: the context metric only', async () => {
    const t = tree();
    writeDesktop(t.desktop, { usage: { [convKey(1)]: ctxEntry(0.344, FIXED) } });
    const fetch = stubFetch({});
    const metrics = await U.fetchKimiUsage(t.config, deps(fetch));
    assert.deepEqual(metrics, [{ id: 'context', label: 'Context', percent: 35, resetsAt: null }]);
    assert.equal(fetch.calls.length, 0);
    // a key set to a plan limit can say why it has none
    assert.deepEqual(U.usageSource.missingText('5h', 'en'), { title: 'No usage data', message: 'Log in with Kimi Code' });
    assert.deepEqual(U.usageSource.missingText('context', 'zh'), { title: '暂无上下文数据', message: '请先使用 Kimi Work' });
  });

  test('Kimi Code folder without a login: "Run kimi login"', async () => {
    const t = tree();
    fs.mkdirSync(t.code, { recursive: true });
    const e = await U.fetchKimiUsage(t.config, deps(stubFetch({}))).catch(x => x);
    expectError('no-credentials')(e);
    assert.deepEqual(keyText(e), { title: 'Not logged in', message: 'Run kimi login' });
    assert.deepEqual(keyText(e, 'zh'), { title: '未登录', message: '请运行 kimi login' });
    // with Kimi Work data the context still shows; plan keys explain the gap
    writeDesktop(t.desktop, { usage: { [convKey(1)]: ctxEntry(0.1, FIXED) } });
    const metrics = await U.fetchKimiUsage(t.config, deps(stubFetch({})));
    assert.deepEqual(metrics.map(m => m.id), ['context']);
    assert.deepEqual(U.usageSource.missingText('weekly', 'zh'), { title: '未登录', message: '请运行 kimi login' });
  });

  test('an unreadable credentials file counts as no login and is never quoted', async () => {
    const t = tree();
    const token = secret('access');
    fs.mkdirSync(path.join(t.code, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(t.code, 'credentials', 'kimi-code.json'), `{"access_token": "${token}"`);
    const e = await U.fetchKimiUsage(t.config, deps(stubFetch({}))).catch(x => x);
    expectError('no-credentials', [token])(e);
  });

  test('a revoked login (empty access token): "Login expired"', async () => {
    const t = tree();
    writeLogin(t.code, { access_token: '', refresh_token: '', expires_at: 0, scope: '', token_type: 'Bearer', expires_in: 0 });
    writeDesktop(t.desktop, { usage: { [convKey(1)]: ctxEntry(0.1, FIXED) } });
    const fetch = stubFetch({});
    const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
    expectError('unauthorized')(e);
    assert.deepEqual(keyText(e), { title: 'Login expired', message: 'Run kimi login' });
    assert.deepEqual(keyText(e, 'zh'), { title: '登录已过期', message: '请运行 kimi login' });
    assert.equal(fetch.calls.length, 0);
  });
});

// --- fetchKimiUsage: logged in ---------------------------------------------------------

describe('logged in to Kimi Code', () => {
  test('plan limits (5h first), the booster wallet and the Kimi Work context', async () => {
    const t = tree();
    const { access } = login(t.code);
    writeDesktop(t.desktop, { usage: { [convKey(1)]: ctxEntry(0.61, FIXED) } });
    const fetch = stubFetch({ '/usages': () => json(CURRENT) });
    const metrics = await U.fetchKimiUsage(t.config, deps(fetch));
    assert.deepEqual(metrics.map(m => [m.id, m.percent]), [
      ['5h', 30], ['weekly', 20], ['monthly', 40], ['monthly_code', 25], ['extra', 25], ['context', 61],
    ]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, 'https://api.kimi.com/coding/v1/usages');
    assert.equal(authOf(fetch.calls[0]), `Bearer ${access}`);
    assert.ok(!JSON.stringify(metrics).includes(access));
  });

  test('a global login reads its own slot and asks api.kimi.ai', async () => {
    const t = tree();
    fs.mkdirSync(t.code, { recursive: true });
    fs.writeFileSync(
      path.join(t.code, 'config.toml'),
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://api.kimi.ai/coding/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        `key = "oauth/${GLOBAL_SLOT}"`,
        'oauth_host = "https://auth.kimi.ai"',
      ].join('\n')
    );
    login(t.code); // the mainland slot: must not be used
    const { access } = login(t.code, { name: GLOBAL_SLOT });
    const fetch = stubFetch({ '/usages': () => json(CURRENT) });
    await U.fetchKimiUsage(t.config, deps(fetch));
    assert.equal(fetch.calls[0].url, 'https://api.kimi.ai/coding/v1/usages');
    assert.equal(authOf(fetch.calls[0]), `Bearer ${access}`);
  });

  test('KIMI_CODE_HOME is used when the folder setting is empty', async () => {
    const t = tree();
    const { access } = login(t.code);
    const fetch = stubFetch({ '/usages': () => json(CURRENT) });
    await U.fetchKimiUsage(
      { kimiDir: '', kimiDesktopDir: t.desktop },
      deps(fetch, { env: { KIMI_CODE_HOME: t.code } })
    );
    assert.equal(authOf(fetch.calls[0]), `Bearer ${access}`);
  });

  test('an answer without limits: context only, else "No usage data"', async () => {
    const t = tree();
    login(t.code);
    const fetch = stubFetch({ '/usages': () => json({ goods_version: 2, usages: {} }) });
    const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
    expectError('unsupported')(e);
    assert.deepEqual(keyText(e), { title: 'No usage data', message: 'No limits reported' });
    writeDesktop(t.desktop, { usage: { [convKey(1)]: ctxEntry(0.2, FIXED) } });
    const metrics = await U.fetchKimiUsage(t.config, deps(fetch));
    assert.deepEqual(metrics.map(m => m.id), ['context']);
  });

  test('errors from the endpoint reach the key unchanged', async () => {
    const t = tree();
    const { access, refresh } = login(t.code);
    for (const [status, code] of [[404, 'unsupported'], [429, 'rate-limited'], [500, 'http']]) {
      const fetch = stubFetch({ '/usages': () => json({}, status) });
      await assert.rejects(U.fetchKimiUsage(t.config, deps(fetch)), expectError(code, [access, refresh]));
      assert.equal(fetch.posts().length, 0);
    }
  });
});

// --- refreshing an expired login ---------------------------------------------------------

describe('refreshing the Kimi Code login', () => {
  const grant = (over = {}) => ({
    access_token: secret('access'),
    refresh_token: secret('refresh'),
    expires_in: 3600,
    scope: 'kimi-code',
    token_type: 'Bearer',
    ...over,
  });

  test('an expired token is refreshed under the CLI lock and written back atomically', async () => {
    const t = tree();
    const old = login(t.code, { expiresInMs: -60_000, extra: { future_field: 'kept' } });
    const next = grant();
    let lockSeen = false;
    const fetch = stubFetch({
      '/api/oauth/token': () => {
        lockSeen = fs.existsSync(path.join(t.code, 'oauth', 'kimi-code.lock'));
        return json(next);
      },
      '/usages': () => json(CURRENT),
    });
    const metrics = await U.fetchKimiUsage(t.config, deps(fetch));
    assert.equal(metrics[0].id, '5h');
    assert.ok(lockSeen, 'refreshed while holding <home>/oauth/kimi-code.lock');

    const [post] = fetch.posts();
    assert.equal(post.url, 'https://auth.kimi.com/api/oauth/token');
    assert.equal(post.init.method, 'POST');
    assert.deepEqual(Object.keys(post.init.headers).sort(), ['Accept', 'Content-Type']);
    const form = new URLSearchParams(post.init.body);
    // Kimi Code's public client id (packages/oauth/src/constants.ts)
    assert.match(Auth.KIMI_CODE_CLIENT_ID, /^17e5f671-d194-4dfb-9706-[0-9a-f]{12}$/);
    assert.deepEqual(Object.fromEntries(form), {
      client_id: Auth.KIMI_CODE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: old.refresh,
    });
    assert.equal(authOf(fetch.gets()[0]), `Bearer ${next.access_token}`);

    const saved = JSON.parse(fs.readFileSync(old.file, 'utf-8'));
    assert.deepEqual(saved, {
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: Math.floor(FIXED / 1000) + 3600,
      scope: 'kimi-code',
      token_type: 'Bearer',
      expires_in: 3600,
      future_field: 'kept',
    });
    assert.equal(fs.statSync(old.file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(t.code, 'credentials')), ['kimi-code.json']);
    assert.deepEqual(fs.readdirSync(path.join(t.code, 'oauth')), [], 'lock released');
  });

  test('refreshing turned off: "Run kimi to refresh", no request, file untouched', async () => {
    const t = tree();
    const old = login(t.code, { expiresInMs: -60_000 });
    const before = fs.readFileSync(old.file, 'utf-8');
    const fetch = stubFetch({});
    const e = await U.fetchKimiUsage({ ...t.config, kimiRefreshLogin: false }, deps(fetch)).catch(x => x);
    expectError('unauthorized', [old.access, old.refresh])(e);
    assert.deepEqual(keyText(e), { title: 'Login expired', message: 'Run kimi to refresh' });
    assert.deepEqual(keyText(e, 'zh'), { title: '登录已过期', message: '运行 kimi 以刷新' });
    assert.equal(fetch.calls.length, 0);
    assert.equal(fs.readFileSync(old.file, 'utf-8'), before);
    assert.ok(!fs.existsSync(path.join(t.code, 'oauth')));
  });

  test('a 401 for a valid-looking token: one forced refresh and one retry', async () => {
    const t = tree();
    const old = login(t.code);
    const next = grant();
    const fetch = stubFetch({
      '/api/oauth/token': () => json(next),
      '/usages': call => (authOf(call) === `Bearer ${old.access}` ? json({}, 401) : json(CURRENT)),
    });
    const metrics = await U.fetchKimiUsage(t.config, deps(fetch));
    assert.equal(metrics.length, 5);
    assert.equal(fetch.gets().length, 2);
    assert.equal(fetch.posts().length, 1);
  });

  test('a login the server keeps refusing is refreshed once, not on every poll', async () => {
    const t = tree();
    const old = login(t.code);
    const fetch = stubFetch({
      '/api/oauth/token': () => json(grant()),
      '/usages': () => json({}, 401),
    });
    for (let i = 0; i < 3; i++) {
      const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
      expectError('unauthorized', [old.access, old.refresh])(e);
      assert.deepEqual(keyText(e), { title: 'Login expired', message: 'Run kimi login' });
    }
    assert.equal(fetch.posts().length, 1, 'one refresh-token rotation');
    assert.equal(fetch.gets().length, 4, 'two for the first poll, one each after');
    // a new login (another token in the file) gets its forced refresh again
    const next = login(t.code);
    const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
    expectError('unauthorized', [next.access, next.refresh])(e);
    assert.equal(fetch.posts().length, 2);
  });

  test('a 401 with refreshing turned off asks to run kimi', async () => {
    const t = tree();
    login(t.code);
    const fetch = stubFetch({ '/usages': () => json({}, 401) });
    const e = await U.fetchKimiUsage({ ...t.config, kimiRefreshLogin: false }, deps(fetch)).catch(x => x);
    expectError('unauthorized')(e);
    assert.equal(fetch.posts().length, 0);
  });

  test('a rejected refresh token: no tombstone, and it is not sent again', async () => {
    const t = tree();
    const old = login(t.code, { expiresInMs: -60_000 });
    const before = fs.readFileSync(old.file, 'utf-8');
    const fetch = stubFetch({
      '/api/oauth/token': () => json({ error: 'invalid_grant', error_description: `bad ${old.refresh}` }, 400),
      '/usages': () => json(CURRENT),
    });
    for (let i = 0; i < 2; i++) {
      const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
      expectError('unauthorized', [old.access, old.refresh])(e);
      assert.deepEqual(keyText(e), { title: 'Login expired', message: 'Run kimi login' });
    }
    assert.equal(fetch.posts().length, 1);
    assert.equal(fetch.gets().length, 0);
    assert.equal(fs.readFileSync(old.file, 'utf-8'), before);
  });

  test('a refresh rejected because a peer rotated the pair uses the peer token', async () => {
    const t = tree();
    const old = login(t.code, { expiresInMs: -60_000 });
    let peer;
    const fetch = stubFetch({
      '/api/oauth/token': () => {
        peer = login(t.code); // the CLI refreshed meanwhile
        return json({}, 401);
      },
      '/usages': () => json(CURRENT),
    });
    await U.fetchKimiUsage(t.config, deps(fetch));
    assert.notEqual(peer.refresh, old.refresh);
    assert.equal(authOf(fetch.gets()[0]), `Bearer ${peer.access}`);
  });

  test('waits for a CLI holding the lock and uses the token it wrote', async () => {
    const t = tree();
    login(t.code, { expiresInMs: -60_000 });
    const lockDir = path.join(t.code, 'oauth', 'kimi-code.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    let peer;
    const fetch = stubFetch({ '/usages': () => json(CURRENT) });
    const sleepStub = async () => {
      if (!peer) {
        peer = login(t.code); // the CLI finishes its refresh and releases
        fs.rmdirSync(lockDir);
      }
    };
    await U.fetchKimiUsage(t.config, deps(fetch, { sleep: sleepStub }));
    assert.equal(fetch.posts().length, 0);
    assert.equal(authOf(fetch.gets()[0]), `Bearer ${peer.access}`);
    assert.deepEqual(fs.readdirSync(path.join(t.code, 'oauth')), []);
  });

  test('a lock that stays held: "Login busy", no refresh, the lock is left alone', async () => {
    const t = tree();
    const old = login(t.code, { expiresInMs: -60_000 });
    const lockDir = path.join(t.code, 'oauth', 'kimi-code.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const fetch = stubFetch({});
    const e = await U.fetchKimiUsage(t.config, deps(fetch)).catch(x => x);
    expectError('network', [old.access, old.refresh])(e);
    assert.deepEqual(keyText(e), { title: 'Login busy', message: 'Retrying soon' });
    assert.equal(fetch.calls.length, 0);
    assert.ok(fs.existsSync(lockDir));
  });

  test('a stale lock (no update for 5 s) is taken over', async () => {
    const t = tree();
    login(t.code, { expiresInMs: -60_000 });
    const lockDir = path.join(t.code, 'oauth', 'kimi-code.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);
    const fetch = stubFetch({ '/api/oauth/token': () => json(grant()), '/usages': () => json(CURRENT) });
    await U.fetchKimiUsage(t.config, deps(fetch));
    assert.equal(fetch.posts().length, 1);
    assert.ok(!fs.existsSync(lockDir));
  });

  test('no lock where the CLI takes none (Windows, KIMI_DISABLE_OAUTH_LOCK=1)', async () => {
    for (const over of [{ platform: 'win32' }, { env: { KIMI_DISABLE_OAUTH_LOCK: '1' } }]) {
      const t = tree();
      login(t.code, { expiresInMs: -60_000 });
      let lockSeen = true;
      const fetch = stubFetch({
        '/api/oauth/token': () => {
          lockSeen = fs.existsSync(path.join(t.code, 'oauth'));
          return json(grant());
        },
        '/usages': () => json(CURRENT),
      });
      await U.fetchKimiUsage(t.config, deps(fetch, over));
      assert.equal(lockSeen, false);
    }
  });

  test('refresh failures map to error codes and never leak tokens', async () => {
    const cases = [
      [() => json({}, 429, { 'retry-after': '30' }), 'rate-limited'],
      [() => json({}, 502), 'http'],
      [() => { throw new Error('getaddrinfo ENOTFOUND auth.kimi.com'); }, 'network'],
      [() => json({ access_token: secret('access') }), 'parse'],
      [() => json('{"access_token": "' + secret('access') + '"'), 'parse'],
      [() => json('{"access_token": "' + secret('access') + '"', 500), 'http'],
    ];
    for (const [handler, code] of cases) {
      const t = tree();
      const old = login(t.code, { expiresInMs: -60_000 });
      const before = fs.readFileSync(old.file, 'utf-8');
      const fetch = stubFetch({ '/api/oauth/token': handler, '/usages': () => json(CURRENT) });
      await assert.rejects(U.fetchKimiUsage(t.config, deps(fetch)), expectError(code, [old.access, old.refresh]));
      assert.equal(fs.readFileSync(old.file, 'utf-8'), before, code);
      assert.equal(fetch.gets().length, 0);
      assert.deepEqual(fs.readdirSync(path.join(t.code, 'oauth')), []);
    }
  });

  test('a token without an expiry is used until the server rejects it', async () => {
    const t = tree();
    const { access } = login(t.code, { extra: { expires_at: 0 } });
    const fetch = stubFetch({ '/usages': () => json(CURRENT) });
    await U.fetchKimiUsage(t.config, deps(fetch));
    assert.equal(authOf(fetch.gets()[0]), `Bearer ${access}`);
    assert.equal(fetch.posts().length, 0);
  });
});

// --- the UsageSource ---------------------------------------------------------------

describe('usageSource', () => {
  test('contract: default metric is the first returned (5h)', () => {
    assert.equal(U.usageSource.defaultMetric, '');
    assert.equal(typeof U.usageSource.fetch, 'function');
    assert.equal(U.usageSource.minFetchGapMs, undefined, '30 s default gap');
  });

  test('logText: the fixed message, without the class name', () => {
    const e = new Kit.ProviderError('no-credentials', 'Kimi Code is not logged in.');
    assert.equal(U.usageSource.logText(e), 'Kimi Code is not logged in.');
    assert.equal(U.usageSource.logText(new Error(`Bearer ${secret('x')}`)), 'Bearer [redacted]');
  });

  test('describe(): metrics, a short-lived cache, and error codes', async () => {
    const t = tree();
    login(t.code, { base: Date.now() }); // describe() runs on the real clock
    let gets = 0;
    globalThis.fetch = async url => {
      assert.ok(String(url).endsWith('/usages'));
      gets++;
      return json(CURRENT);
    };
    const first = await U.usageSource.describe(t.config);
    assert.equal(first.success, true);
    assert.equal(first.contextOnly, false);
    assert.deepEqual(first.metrics.map(m => m.id), ['5h', 'weekly', 'monthly', 'monthly_code', 'extra']);
    await U.usageSource.describe(t.config);
    assert.equal(gets, 1, 'a fresh result is reused');
    await U.usageSource.fetch(t.config);
    assert.equal(gets, 2, 'the key group always fetches');

    const none = tree();
    const failed = await U.usageSource.describe(none.config);
    assert.deepEqual(failed, {
      success: false,
      error: 'Neither Kimi Code nor the Kimi desktop app was found on this computer.',
      code: 'not-installed',
    });

    const desk = tree();
    writeDesktop(desk.desktop, { usage: { [convKey(1)]: ctxEntry(0.3, FIXED) } });
    const ctxOnly = await U.usageSource.describe(desk.config);
    assert.equal(ctxOnly.success, true);
    assert.equal(ctxOnly.contextOnly, true);
    assert.equal(ctxOnly.planCode, 'not-configured');
  });
});

// --- through the generic key group ---------------------------------------------------

function keyGroup(config) {
  const cid = Kit.keyCid('kimi', 'usage');
  const sent = new Map();
  let chain = Promise.resolve();
  const keys = new UsageKeys({
    enqueue: task => (chain = chain.then(task).catch(() => undefined)),
    send: async (_serial, key, image) => sent.set(key.uid, image),
    isOffline: () => false,
    keyWidth: key => key.width,
    bgColor: () => undefined,
    loadConfig: async () => config,
    pollIntervalMs: () => 3_600_000,
    logger: null,
    provider: { cid, brand: KIMI_BRAND, source: U.usageSource },
  });
  const settle = async () => {
    let last;
    do {
      last = chain;
      await last;
      await sleep(5);
    } while (last !== chain);
  };
  return { cid, keys, sent, settle };
}

/** [width, height] of a PNG data URL. */
function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('Kimi usage keys', () => {
  test('without Kimi data every key draws a face, without network', async () => {
    const t = tree();
    const { cid, keys, sent, settle } = keyGroup(t.config);
    try {
      await keys.alive('FAKE-DEVICE-1', [
        { uid: 1, cid, width: 120, data: { metric: '' } },
        { uid: 2, cid, width: 60, data: { metric: '', lang: 'zh' } },
      ]);
      await settle();
      assert.deepEqual(pngSize(sent.get(1)), [120, 60]);
      assert.deepEqual(pngSize(sent.get(2)), [60, 60]);
    } finally {
      keys.stop();
    }
  });

  test('one request serves keys showing different limits; a 429 locks out', async () => {
    const t = tree();
    login(t.code, { base: Date.now() }); // the key group runs on the real clock
    writeDesktop(t.desktop, { usage: { [convKey(1)]: ctxEntry(0.4, FIXED) } });
    let gets = 0;
    let status = 200;
    globalThis.fetch = async () => {
      gets++;
      return status === 200 ? json(CURRENT) : json({}, status, { 'retry-after': '600' });
    };
    const { cid, keys, sent, settle } = keyGroup(t.config);
    try {
      const all = ['', 'weekly', 'monthly', 'monthly_code', 'extra', 'context'].map((metric, i) => ({
        uid: i + 1,
        cid,
        width: [60, 120, 240, 360, 460, 240][i],
        data: { metric, showResetTime: true, showMark: true },
      }));
      await keys.alive('FAKE-DEVICE-1', all);
      await settle();
      assert.equal(gets, 1);
      for (const key of all) assert.deepEqual(pngSize(sent.get(key.uid)), [key.width, 60]);

      // the next fetch is rate limited: no request until the lockout ends
      status = 429;
      await keys.configure(t.config); // within the 30 s gap: no request
      assert.equal(gets, 1);
      keys.lastFetchAt = 0;
      await keys.refresh();
      assert.equal(gets, 2);
      keys.lastFetchAt = 0;
      await keys.refresh();
      assert.equal(gets, 2, 'locked out');
      const reply = await keys.message({ data: 'usage-status', cid, settings: {} });
      assert.equal(reply.success, false);
      assert.match(reply.error, /Rate limited, retry in/);
    } finally {
      keys.stop();
    }
  });
});
