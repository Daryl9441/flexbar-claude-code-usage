// Moonshot balance added beside Kimi Code quota. Fetch is stubbed.
// A missing API key must not change the existing quota behaviour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-balance-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
for (const name of [
  'KIMI_CODE_HOME',
  'KIMI_SHARE_DIR',
  'KIMI_CODE_BASE_URL',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_OAUTH_HOST',
  'KIMI_DISABLE_OAUTH_LOCK',
  'MOONSHOT_API_KEY',
  'MOONSHOT_API_BASE',
]) {
  delete process.env[name];
}

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.KIMI_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-kimi-usage');
const req = file => require(path.join(build, file));
const U = req('providers/kimi/usage.js');
const B = req('providers/kimi/usageBalance.js');
const Face = req('providers/kimi/usageFace.js');
const Auth = req('providers/kimi/usageAuth.js');

const FIXED = Date.parse('2026-10-05T12:00:00.000Z');
const KEY = ['sk-', 'FAKE', 'moonshot', '0001'].join('');
const QUOTA = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-10-05T17:00:00Z' },
    limit_7d: { used_ratio: 0.5, reset_time: '2026-10-12T12:00:00Z' },
  },
};

let caseNo = 0;
function tree() {
  const root = path.join(empty, `case-${++caseNo}`);
  fs.mkdirSync(root);
  const code = path.join(root, 'kimi-code');
  const desktop = path.join(root, 'kimi-desktop');
  fs.mkdirSync(code);
  return { code, desktop, config: { kimiDir: code, kimiDesktopDir: desktop } };
}

function login(code) {
  const dir = path.join(code, 'credentials');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const access = ['kimi', 'TEST', 'access', '0001', 'q'.repeat(12)].join('-');
  fs.writeFileSync(
    path.join(dir, 'kimi-code.json'),
    JSON.stringify({
      access_token: access,
      refresh_token: ['kimi', 'TEST', 'refresh', '0001', 'q'.repeat(12)].join('-'),
      expires_at: Math.floor((FIXED + 3_600_000) / 1000),
      scope: '',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
    { mode: 0o600 }
  );
  return access;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function balanceBody(over = {}) {
  return {
    code: 0,
    status: true,
    scode: '0x0',
    data: {
      available_balance: 49.58894,
      voucher_balance: 46.58893,
      cash_balance: 3.00001,
      ...over,
    },
  };
}

function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    for (const [match, handler] of Object.entries(routes)) {
      if (call.url.includes(match)) return handler(call);
    }
    throw new Error(`unexpected request ${call.url}`);
  };
  fn.calls = calls;
  return fn;
}

function deps(fetch, env = {}) {
  return {
    fetch,
    now: () => FIXED,
    sleep: async () => {},
    platform: 'darwin',
    env,
    lock: { retries: 3, delayMs: 1, staleMs: 5_000, updateMs: 1_000 },
    membershipFetch: async () => null,
  };
}

after(() => fs.rmSync(empty, { recursive: true, force: true }));
beforeEach(() => {
  U.resetUsageState();
  Auth.resetAuthState();
});

describe('Moonshot balance parse', () => {
  test('the documented reply is remaining, cash and voucher in CNY', () => {
    const metrics = B.parseMoonshotBalance(balanceBody(), 'CNY');
    assert.deepEqual(
      metrics.map(metric => [metric.id, metric.amount, metric.available]),
      [
        ['api', 49.58894, true],
        ['api_cash', 3.00001, true],
        ['api_voucher', 46.58893, true],
      ]
    );
    assert.equal(metrics.every(metric => metric.currency === 'CNY'), true);
  });

  test('a zero available balance cannot call the API, and cash may be negative', () => {
    const metrics = B.parseMoonshotBalance(
      balanceBody({
        available_balance: 0,
        voucher_balance: 0,
        cash_balance: -2.5,
      }),
      'CNY'
    );
    assert.equal(metrics[0].available, false);
    assert.equal(metrics[1].amount, -2.5);
    assert.equal(metrics[1].available, false);
  });

  test('a non-zero code or a missing field is not a balance', () => {
    assert.equal(B.parseMoonshotBalance({ code: 1, data: balanceBody().data }, 'CNY'), null);
    assert.equal(B.parseMoonshotBalance({ code: 0, status: false, data: balanceBody().data }, 'CNY'), null);
    assert.equal(B.parseMoonshotBalance({ code: 0, data: { available_balance: 1 } }, 'CNY'), null);
  });

  test('the site picks the official host and currency, not an arbitrary base', () => {
    assert.equal(B.moonshotBalanceUrl({}, {}), 'https://api.moonshot.cn/v1/users/me/balance');
    assert.equal(B.moonshotCurrency({}, {}), 'CNY');
    assert.equal(
      B.moonshotBalanceUrl({ moonshotSite: 'global' }, {}),
      'https://api.moonshot.ai/v1/users/me/balance'
    );
    assert.equal(B.moonshotCurrency({ moonshotSite: 'global' }, {}), 'USD');
    assert.equal(
      B.moonshotBalanceUrl({ moonshotSite: 'https://evil.example' }, {
        MOONSHOT_API_BASE: 'https://evil.example',
      }),
      'https://api.moonshot.cn/v1/users/me/balance'
    );
    assert.equal(
      B.moonshotSite({}, { MOONSHOT_API_BASE: 'https://api.moonshot.ai' }),
      'global'
    );
    assert.equal(
      B.moonshotSite({ moonshotSite: 'cn' }, { MOONSHOT_API_BASE: 'https://api.moonshot.ai' }),
      'cn'
    );
  });
});

describe('Kimi usage with a Moonshot key', () => {
  test('without a key the quota fetch is unchanged and no balance request is made', async () => {
    const home = tree();
    const access = login(home.code);
    const fetch = stubFetch({
      '/usages': call => {
        assert.equal(call.init.headers.Authorization, `Bearer ${access}`);
        return json(QUOTA);
      },
    });
    const metrics = await U.fetchKimiUsage(home.config, deps(fetch));
    assert.deepEqual(metrics.map(metric => metric.id), ['5h', 'weekly']);
    assert.equal(fetch.calls.length, 1);
    assert.equal(U.usageSource.missingText('api', 'en').title, 'API key needed');
    assert.equal(U.usageSource.substituteMetric('api', metrics), null);
  });

  test('a key adds the CNY remainder without replacing plan limits', async () => {
    const home = tree();
    const access = login(home.code);
    const fetch = stubFetch({
      '/usages': call => {
        assert.equal(call.init.headers.Authorization, `Bearer ${access}`);
        return json(QUOTA);
      },
      '/v1/users/me/balance': call => {
        assert.equal(call.url, 'https://api.moonshot.cn/v1/users/me/balance');
        assert.equal(call.init.method, 'GET');
        assert.equal(call.init.redirect, 'error');
        assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
        assert.equal(call.url.includes(KEY), false);
        return json(balanceBody());
      },
    });
    const config = { ...home.config, moonshotApiKey: KEY };
    const metrics = await U.fetchKimiUsage(config, deps(fetch));
    assert.deepEqual(
      metrics.map(metric => metric.id),
      ['5h', 'weekly', 'api', 'api_cash', 'api_voucher']
    );
    const api = metrics.find(metric => metric.id === 'api');
    assert.equal(api.amount, 49.58894);
    assert.equal(api.currency, 'CNY');
    assert.equal(U.usageSource.substituteMetric('monthly_code', metrics), '5h');
    assert.equal(U.usageSource.substituteMetric('api', metrics), null);
    const face = Face.kimiUsageFace({
      metric: 'api',
      metrics,
      width: 240,
      showResetTime: false,
      lang: 'zh',
      data: { showMark: true },
    });
    assert.equal(face.image.startsWith('data:image/png'), true);
    assert.equal(face.image.includes(KEY), false);
    const membership = Face.kimiUsageFace({
      metric: 'membership',
      metrics,
      width: 240,
      showResetTime: false,
      lang: 'en',
      data: { showMark: true },
    });
    assert.equal(membership.text.title, 'Total usage unavailable');
  });

  test('a failed balance read keeps the plan limits', async () => {
    const home = tree();
    login(home.code);
    const fetch = stubFetch({
      '/usages': () => json(QUOTA),
      '/v1/users/me/balance': () => json({ error: { message: KEY } }, 401),
    });
    const metrics = await U.fetchKimiUsage(
      { ...home.config, moonshotApiKey: KEY },
      deps(fetch)
    );
    assert.deepEqual(metrics.map(metric => metric.id), ['5h', 'weekly']);
    const missing = U.usageSource.missingText('api', 'zh');
    assert.equal(missing.title, '密钥被拒绝');
    assert.equal(JSON.stringify(missing).includes(KEY), false);
    assert.equal(U.usageSource.missingText('api_cash', 'en').title, 'API key rejected');
  });

  test('an API key alone is enough when Kimi Code is not installed', async () => {
    const home = tree();
    fs.rmSync(home.code, { recursive: true, force: true });
    const fetch = stubFetch({
      '/v1/users/me/balance': () => json(balanceBody()),
    });
    const metrics = await U.fetchKimiUsage(
      { ...home.config, moonshotApiKey: KEY, moonshotSite: 'global' },
      deps(fetch)
    );
    assert.deepEqual(metrics.map(metric => metric.id), ['api', 'api_cash', 'api_voucher']);
    assert.equal(metrics[0].currency, 'USD');
    assert.equal(fetch.calls[0].url, 'https://api.moonshot.ai/v1/users/me/balance');
    assert.equal(
      U.usageSource.substituteMetric('5h', metrics),
      null
    );
  });

  test('without a key, a missing install still reports Kimi as not installed', async () => {
    const home = tree();
    fs.rmSync(home.code, { recursive: true, force: true });
    const fetch = stubFetch({});
    const error = await U.fetchKimiUsage(home.config, deps(fetch)).catch(caught => caught);
    assert.equal(error.code, 'not-installed');
    assert.equal(fetch.calls.length, 0);
  });
});
