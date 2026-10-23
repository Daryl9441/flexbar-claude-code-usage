// DeepSeek balance: synthetic fixtures, fetch stubbed, no real network.
// Token-shaped strings are built at runtime and never written into errors.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.DEEPSEEK_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-deepseek-usage');
const req = file => require(path.join(build, file));
const Api = req('providers/deepseek/usageApi.js');
const U = req('providers/deepseek/usage.js');
const Face = req('providers/deepseek/usageFace.js');
const Session = req('providers/deepseek/session.js');
const Launch = req('providers/deepseek/newSession.js');
const Money = req('balance.js');

const KEY = ['sk-', 'FAKE', 'deepseek', '0001'].join('');
const OTHER = ['sk-', 'FAKE', 'deepseek', '0002'].join('');

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function source(fetchImpl, env = {}) {
  const calls = [];
  const usage = U.createDeepseekUsageSource({
    env,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return fetchImpl(url, init);
    },
  });
  return { usage, calls };
}

const SAMPLE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

describe('DeepSeek balance parse', () => {
  test('the documented CNY payload becomes total, granted and topped-up rows', () => {
    const metrics = Api.parseDeepseekBalance(SAMPLE);
    assert.deepEqual(
      metrics.map(metric => [metric.id, metric.amount, metric.currency, metric.available]),
      [
        ['cny', 110, 'CNY', true],
        ['cny_granted', 10, 'CNY', true],
        ['cny_topped_up', 100, 'CNY', true],
      ]
    );
    assert.equal(metrics[0].percent, 0);
    assert.equal(metrics[0].resetsAt, null);
  });

  test('CNY is listed before USD, and an unavailable account keeps its amounts', () => {
    const metrics = Api.parseDeepseekBalance({
      is_available: false,
      balance_infos: [
        {
          currency: 'USD',
          total_balance: '1.5',
          granted_balance: '0',
          topped_up_balance: '1.5',
        },
        {
          currency: 'cny',
          total_balance: '0.00',
          granted_balance: '0.00',
          topped_up_balance: '0.00',
        },
      ],
    });
    assert.deepEqual(
      metrics.map(metric => metric.id),
      ['cny', 'cny_granted', 'cny_topped_up', 'usd', 'usd_granted', 'usd_topped_up']
    );
    assert.equal(metrics.every(metric => metric.available === false), true);
  });

  test('a balance that is not the documented shape is rejected', () => {
    assert.equal(Api.parseDeepseekBalance(null), null);
    assert.equal(Api.parseDeepseekBalance({ balance_infos: [] }), null);
    assert.deepEqual(
      Api.parseDeepseekBalance({ is_available: true, balance_infos: [] }),
      []
    );
    assert.deepEqual(
      Api.parseDeepseekBalance({
        is_available: true,
        balance_infos: [{ currency: '??', total_balance: '1' }],
      }),
      []
    );
  });

  test('formatMoney keeps two decimals and a sign', () => {
    assert.equal(Money.formatMoney(110, 'CNY'), '¥110.00');
    assert.equal(Money.formatMoney(49.58894, 'CNY'), '¥49.59');
    assert.equal(Money.formatMoney(-3, 'USD'), '-$3.00');
    assert.equal(Money.formatMoney(1, 'EUR'), '1.00 EUR');
  });
});

describe('DeepSeek balance source', () => {
  test('does not call DeepSeek until an API key is set', async () => {
    let called = false;
    const { usage } = source(async () => {
      called = true;
      return jsonResponse(200, SAMPLE);
    });
    await assert.rejects(usage.fetch({}), error => error.problem === 'no-key');
    await assert.rejects(
      usage.fetch({ deepseekApiKey: '   ' }),
      error => error.problem === 'no-key'
    );
    assert.equal(called, false);
  });

  test('sends the key only as a Bearer header to the official URL', async () => {
    const { usage, calls } = source(() => jsonResponse(200, SAMPLE));
    const metrics = await usage.fetch({ deepseekApiKey: KEY });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].url.includes(KEY), false);
    assert.equal(metrics[0].id, 'cny');
    assert.equal(metrics[0].amount, 110);
  });

  test('the plugin setting wins over the environment variable', async () => {
    const seen = [];
    const { usage } = source(
      (_url, init) => {
        seen.push(init.headers.Authorization);
        return jsonResponse(200, SAMPLE);
      },
      { DEEPSEEK_API_KEY: OTHER }
    );
    await usage.fetch({ deepseekApiKey: KEY });
    await usage.fetch({});
    assert.deepEqual(seen, [`Bearer ${KEY}`, `Bearer ${OTHER}`]);
  });

  test('a transport error never repeats the key', async () => {
    const { usage } = source(async () => {
      throw new Error(`connect failed Authorization: Bearer ${KEY}`);
    });
    const error = await usage.fetch({ deepseekApiKey: KEY }).catch(caught => caught);
    assert.equal(error.problem, 'network');
    assert.equal(error.message.includes(KEY), false);
    assert.equal(usage.logText(error).includes(KEY), false);
    const described = await usage.describe({ deepseekApiKey: KEY });
    assert.equal(described.success, false);
    assert.equal(described.problem, 'network');
    assert.equal(JSON.stringify(described).includes(KEY), false);
  });

  test('401, 429 and a bad body map to fixed problems', async () => {
    const unauthorized = source(() => jsonResponse(401, { error: KEY }));
    await assert.rejects(
      unauthorized.usage.fetch({ deepseekApiKey: KEY }),
      error => error.problem === 'unauthorized' && !error.message.includes(KEY)
    );
    const limited = source(() =>
      jsonResponse(429, {}, { 'retry-after': '12' })
    );
    const rate = await limited.usage
      .fetch({ deepseekApiKey: KEY })
      .catch(error => error);
    assert.equal(rate.problem, 'rate-limited');
    assert.equal(rate.retryAfterSeconds, 60);
    const parsed = source(() => jsonResponse(200, 'not-json'));
    await assert.rejects(
      parsed.usage.fetch({ deepseekApiKey: KEY }),
      error => error.problem === 'parse'
    );
    const empty = source(() =>
      jsonResponse(200, { is_available: true, balance_infos: [] })
    );
    await assert.rejects(
      empty.usage.fetch({ deepseekApiKey: KEY }),
      error => error.problem === 'empty'
    );
  });

  test('the balance face draws the amount and not a percent meter', () => {
    const metrics = Api.parseDeepseekBalance(SAMPLE);
    const face = Face.deepseekUsageFace({
      metric: 'cny',
      metrics,
      width: 240,
      showResetTime: true,
      lang: 'zh',
      data: { showMark: true },
    });
    assert.equal(face.image.startsWith('data:image/png'), true);
    const other = Face.deepseekUsageFace({
      metric: 'cny',
      metrics: metrics.map(metric =>
        metric.id === 'cny' ? { ...metric, amount: 1 } : metric
      ),
      width: 240,
      showResetTime: true,
      lang: 'zh',
      data: { showMark: true },
    });
    assert.notEqual(face.image, other.image);
    assert.equal(face.image.includes(KEY), false);
  });

  test('Chinese chip text names granted and topped-up balances', () => {
    const { usage } = source(() => jsonResponse(200, SAMPLE));
    assert.equal(
      usage.metricLabel({ id: 'cny_granted', label: 'Granted', currency: 'CNY' }, 'zh'),
      '赠金'
    );
    assert.equal(
      usage.metricLabel({ id: 'cny_topped_up', label: 'Top-up' }, 'en'),
      'Top-up'
    );
  });
});

describe('DeepSeek session and open key', () => {
  test('the session key reports that there are no local sessions', async () => {
    const described = await Session.sessionProvider.describe('', {});
    assert.equal(described.success, true);
    assert.equal(described.notice.label.zh, '仅余额');
    assert.equal(described.projectsDir, null);
    assert.equal(Session.sessionProvider.location({}), 'deepseek-api');
  });

  test('the third key opens the chat site and does not take a key', () => {
    assert.equal(
      Launch.newSessionLauncher.target({
        data: {},
        rawFolder: '',
        folder: null,
        home: '/Users/you',
        platform: 'linux',
      }).url,
      'https://chat.deepseek.com/'
    );
  });
});
