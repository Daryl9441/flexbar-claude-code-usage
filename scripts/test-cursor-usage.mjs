// Tests for the Cursor usage source. Synthetic fixtures only. fetch and the
// Cursor token lookup are stubbed, and the real home folder is never read.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.CURSOR_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-cursor-usage');
const req = file => require(path.join(build, file));
const U = req('providers/cursor/usage.js');
const D = req('providers/cursor/usageDecode.js');
const P = req('providers/cursor/paths.js');
const Login = req('providers/cursor/login.js');
const Text = req('providers/cursor/usageText.js');
const Seal = req('providers/grokbot/cursorSeal.js');
const GrokText = req('providers/grokbot/usageText.js');

const HOME = '/Users/you';
const TOKEN = ['cursor', 'FAKE-ACCESS', 'TEST'].join('-');
const STATE_DB =
  '/Users/you/Library/Application Support/Cursor/User/globalStorage/state.vscdb';
const CYCLE_END = '1771077734000';
const PLANTED = 'PLANTED-USAGE-BODY-TEST';

function fakeJwt(tag) {
  const part = text =>
    Buffer.from(`test-${tag}-${text}-padding`).toString('base64url');
  return [part('header'), part('payload'), part('signature')].join('.');
}

function source(overrides = {}) {
  const calls = [];
  const fetchImpl =
    overrides.fetch ??
    (async () => {
      throw new Error('network is disabled in tests');
    });
  const wrapped = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  };
  const usage = U.createCursorUsageSource({
    fetch: wrapped,
    home: HOME,
    platform: overrides.platform ?? 'darwin',
    env: overrides.env ?? {},
    exists: overrides.exists ?? (() => false),
    loadToken:
      overrides.loadToken ??
      (async () => {
        throw new Error('token lookup should not run');
      }),
  });
  return { usage, calls };
}

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

function periodBody(extra = {}) {
  return {
    billingCycleEnd: CYCLE_END,
    planUsage: {
      totalPercentUsed: 42.4,
      autoPercentUsed: 10,
      apiPercentUsed: 32.2,
      ...extra.planUsage,
    },
    ...extra.rest,
  };
}

const INSTALLED = file => file === '/Applications/Cursor.app' || file === STATE_DB;

describe('Cursor usage paths', () => {
  test('state database, user data and the open URL follow the platform', () => {
    assert.equal(P.cursorStateDb({}, {}, HOME, 'darwin'), STATE_DB);
    assert.equal(
      P.cursorUserDataDir({}, {}, HOME, 'darwin'),
      '/Users/you/Library/Application Support/Cursor'
    );
    assert.equal(
      P.cursorStateDb({}, { XDG_CONFIG_HOME: '/xdg' }, HOME, 'linux'),
      '/xdg/Cursor/User/globalStorage/state.vscdb'
    );
    assert.equal(
      P.cursorUserDataDir({}, { APPDATA: 'C:\\Roaming' }, HOME, 'win32'),
      path.join('C:\\Roaming', 'Cursor')
    );
    assert.equal(P.CURSOR_OPEN_URL, 'cursor://');
    assert.equal(P.CURSOR_OPEN_URL.includes('?'), false);
    assert.equal(U.PERIOD_USAGE_ENDPOINT.includes('GetCurrentPeriodUsage'), true);
    assert.equal(U.PERIOD_USAGE_ENDPOINT.includes('GetSandUsageStatus'), false);
  });
});

describe('Cursor usage decode', () => {
  test('included, auto and API percents share the billing-cycle end', () => {
    const decoded = D.decodePeriodUsage(periodBody());
    assert.equal(decoded.kind, 'metrics');
    assert.deepEqual(
      decoded.metrics.map(metric => [metric.id, metric.percent, metric.tag]),
      [
        ['included', 42, 'plan'],
        ['auto', 10, 'auto'],
        ['api', 32, 'api'],
      ]
    );
    assert.equal(decoded.metrics[0].resetsAt, new Date(Number(CYCLE_END)).toISOString());
    assert.equal(JSON.stringify(decoded).includes(PLANTED), false);
  });

  test('included spend over the plan limit is the included meter', () => {
    const decoded = D.decodePeriodUsage({
      planUsage: {
        includedSpend: 758,
        limit: 1000,
        totalPercentUsed: 3.1,
        autoPercentUsed: 3.3,
        apiPercentUsed: 0.7,
      },
    });
    assert.deepEqual(
      decoded.metrics.map(metric => [metric.id, metric.percent]),
      [
        ['included', 76],
        ['auto', 3],
        ['api', 1],
      ]
    );
    const zeroSpend = D.decodePeriodUsage({
      planUsage: { includedSpend: 0, limit: 1000, totalPercentUsed: 40 },
    });
    assert.equal(zeroSpend.metrics[0].percent, 0);
    const over = D.decodePeriodUsage({
      planUsage: { includedSpend: 1500, limit: 1000, totalPercentUsed: 4 },
    });
    assert.equal(over.metrics[0].percent, 100);
  });

  test('snake_case fields and a spend/limit fallback still make a meter', () => {
    const decoded = D.decodePeriodUsage({
      billing_cycle_end: '2026-10-20T00:00:00.000Z',
      plan_usage: { included_spend: '2500', limit: '10000' },
    });
    assert.equal(decoded.metrics[0].id, 'included');
    assert.equal(decoded.metrics[0].percent, 25);
    assert.equal(decoded.metrics[0].resetsAt, '2026-10-20T00:00:00.000Z');
  });

  test('zero used is a meter; a pooled team plan without a percent is not', () => {
    const zero = D.decodePeriodUsage({
      planUsage: { totalPercentUsed: 0 },
    });
    assert.equal(zero.kind, 'metrics');
    assert.equal(zero.metrics[0].percent, 0);
    const pooled = D.decodePeriodUsage({
      planUsage: {},
      spendLimitUsage: { pooledLimit: 50000, limitType: 'team' },
    });
    assert.equal(pooled.kind, 'pooled');
    const empty = D.decodePeriodUsage({ planUsage: {} });
    assert.equal(empty.kind, 'no-allowance');
    assert.equal(D.decodePeriodUsage({ ok: true }), null);
  });

  test('on-demand used over the individual cap clamps, and the plan name is cleaned', () => {
    const decoded = D.decodePeriodUsage({
      planName: 'Pro+',
      planUsage: { totalPercentUsed: 1 },
      spendLimitUsage: { individualLimit: 100, individualUsed: 250 },
    });
    const extra = decoded.metrics.find(metric => metric.id === 'ondemand');
    assert.equal(extra.percent, 100);
    assert.equal(decoded.planLabel, 'Pro+');
    assert.equal(
      D.periodPlanLabel({ planInfo: { planName: 'Pro+', price: '$60/mo' } }),
      'Pro+'
    );
  });
});

describe('Cursor usage requests', () => {
  test('a signed-in install posts the period usage and then the plan name', async () => {
    const { usage, calls } = source({
      exists: INSTALLED,
      loadToken: async file => {
        assert.equal(file, STATE_DB);
        return TOKEN;
      },
      fetch: async url => {
        if (url === U.PERIOD_USAGE_ENDPOINT) {
          return jsonResponse(200, periodBody());
        }
        assert.equal(url, U.PLAN_INFO_ENDPOINT);
        return jsonResponse(200, { planInfo: { planName: 'Pro+' } });
      },
    });
    const described = await usage.describe({});
    assert.equal(described.success, true);
    assert.equal(described.planLabel, 'Pro+');
    assert.equal(described.metrics[0].percent, 42);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.body, '{}');
      assert.equal(call.init.redirect, 'error');
      assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(call.init.headers['Connect-Protocol-Version'], '1');
      assert.equal(String(call.url).includes('GetSandUsageStatus'), false);
    }
    assert.equal(JSON.stringify(described).includes(TOKEN), false);
    assert.equal(usage.metricLabel(described.metrics[0], 'zh'), '套餐');
    const face = usage.errorText(
      new Text.CursorUsageError('not-signed-in', 'hidden'),
      'zh'
    );
    assert.equal(face.title, '未登录');
  });

  test('an HTTP failure does not quote the token or the body', async () => {
    const { usage, calls } = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () => {
        throw new Error(`socket reset ${TOKEN} ${PLANTED}`);
      },
    });
    const described = await usage.describe({});
    assert.equal(described.success, false);
    assert.equal(described.problem, 'network');
    assert.equal(described.error.includes(TOKEN), false);
    assert.equal(described.error.includes(PLANTED), false);
    assert.equal(calls.length, 1);
    assert.equal(usage.keepLastOnError(new Text.CursorUsageError('network', 'x')), true);
  });

  test('401, 429 and a missing install stop before a plan lookup', async () => {
    const rejected = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () => jsonResponse(401, { code: 'unauthenticated' }),
    });
    const expired = await rejected.usage.describe({});
    assert.equal(expired.problem, 'login-expired');
    assert.equal(rejected.calls.length, 1);

    const limited = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () => jsonResponse(429, {}, { 'retry-after': '90' }),
    });
    const rate = await limited.usage.describe({});
    assert.equal(rate.problem, 'rate-limited');
    assert.equal(rate.code, 'rate-limited');

    let looked = false;
    const missing = source({
      exists: () => false,
      loadToken: async () => {
        looked = true;
        return TOKEN;
      },
    });
    const absent = await missing.usage.describe({});
    assert.equal(absent.problem, 'not-installed');
    assert.equal(looked, false);
    assert.equal(missing.calls.length, 0);
  });

  test('a period body that already names the plan does not send the token again', async () => {
    const { usage, calls } = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () =>
        jsonResponse(200, { ...periodBody(), planName: 'Ultra' }),
    });
    const described = await usage.describe({});
    assert.equal(described.planLabel, 'Ultra');
    assert.equal(calls.length, 1);
  });

  test('a press clears a remembered keychain denial', async () => {
    Seal.resetCursorSealState();
    const keyPassword = ['FAKE', 'CURSOR', 'KEY'].join('-');
    const key = crypto.pbkdf2Sync(keyPassword, 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const jwt = fakeJwt('deny');
    const body = Buffer.concat([
      Buffer.from('v10'),
      cipher.update(jwt, 'utf8'),
      cipher.final(),
    ]);
    const sealed = `${Seal.SEALED_PREFIX}${body.toString('base64')}`;
    let asks = 0;
    const first = await Seal.openStoredCursorToken(sealed, {
      platform: 'darwin',
      readPassword: async () => {
        asks += 1;
        return null;
      },
    });
    assert.equal(first.kind, 'keychain-blocked');
    assert.equal(asks, 1);
    const { usage } = source({ exists: INSTALLED, loadToken: async () => null });
    await usage.preparePress();
    const third = await Seal.openStoredCursorToken(sealed, {
      platform: 'darwin',
      readPassword: async () => {
        asks += 1;
        return keyPassword;
      },
    });
    assert.equal(third.kind, 'token');
    assert.equal(third.token, jwt);
    assert.equal(asks, 2);
  });
});

describe('Cursor login reuse', () => {
  test('a token from the shared reader is returned and the fallback is not opened', async () => {
    let cells = 0;
    const token = await Login.loadCursorAccessToken(STATE_DB, {
      readToken: async () => TOKEN,
      readStoredCell: async () => {
        cells += 1;
        return null;
      },
    });
    assert.equal(token, TOKEN);
    assert.equal(cells, 0);
  });

  test('a missing login stays missing, and a keychain block is not retried as a raw cell', async () => {
    let cells = 0;
    const missing = await Login.loadCursorAccessToken(STATE_DB, {
      readToken: async () => null,
      readStoredCell: async () => {
        cells += 1;
        return TOKEN;
      },
    });
    assert.equal(missing, null);
    await assert.rejects(
      () =>
        Login.loadCursorAccessToken(STATE_DB, {
          readToken: async () => {
            throw new GrokText.GrokbotUsageError(
              'keychain-blocked',
              `blocked ${TOKEN}`
            );
          },
          readStoredCell: async () => {
            cells += 1;
            return TOKEN;
          },
        }),
      error => {
        assert.equal(error.problem, 'keychain-blocked');
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      }
    );
    assert.equal(cells, 0);
  });

  test('an unreadable database falls back to the same cell opener, which still refuses a non-JWT', async () => {
    const jwt = fakeJwt('fallback');
    const opened = await Login.loadCursorAccessToken(STATE_DB, {
      readToken: async () => {
        throw new GrokText.GrokbotUsageError(
          'state-unreadable',
          'database is larger than the copy cap'
        );
      },
      readStoredCell: async () => jwt,
    });
    assert.equal(opened, jwt);

    const opaque = 'NOT-A-TOKEN-CELL';
    await assert.rejects(
      () =>
        Login.loadCursorAccessToken(STATE_DB, {
          readToken: async () => {
            throw new GrokText.GrokbotUsageError('state-unreadable', 'too big');
          },
          readStoredCell: async () => opaque,
        }),
      error => {
        assert.equal(error.problem, 'login-unreadable');
        assert.equal(error.message.includes(opaque), false);
        assert.equal(error.message.includes('too big'), false);
        return true;
      }
    );
  });

  test('the immutable fallback reads the token cell and does not write a WAL', async t => {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite?.DatabaseSync) {
      t.skip('node:sqlite not available');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-login-test-'));
    const jwt = fakeJwt('immutable');
    try {
      const file = path.join(dir, 'state.vscdb');
      const db = new sqlite.DatabaseSync(file);
      db.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'cursorAuth/accessToken',
        jwt
      );
      db.close();
      const opened = await Login.loadCursorAccessToken(file, {
        readToken: async () => {
          throw new GrokText.GrokbotUsageError(
            'state-unreadable',
            'database is larger than the copy cap'
          );
        },
      });
      assert.equal(opened, jwt);
      assert.equal(fs.existsSync(`${file}-wal`), false);
      assert.equal(fs.existsSync(`${file}-shm`), false);

      const link = path.join(dir, 'linked.vscdb');
      fs.symlinkSync(file, link);
      await assert.rejects(
        () => Login.readStoredCellImmutable(link),
        error => {
          assert.equal(error.problem, 'state-unreadable');
          assert.equal(error.message.includes(jwt), false);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
