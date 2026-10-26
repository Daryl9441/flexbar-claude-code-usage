// Tests for the Grok Bot usage source. Synthetic fixtures only. fetch and
// the Cursor token lookup are stubbed, and the real home folder is never read.
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
  process.env.GROKBOT_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-grokbot-usage');
const req = file => require(path.join(build, file));
const U = req('providers/grokbot/usage.js');
const D = req('providers/grokbot/usageDecode.js');
const P = req('providers/grokbot/paths.js');
const A = req('providers/grokbot/usageAuth.js');
const Seal = req('providers/grokbot/cursorSeal.js');
const Kit = req('providers/kit.js');

const HOME = '/Users/you';
const TOKEN = ['cursor', 'FAKE-ACCESS', 'TEST'].join('-');
const RESET_SECONDS = 1_781_646_433;
const PLANTED = 'PLANTED-USAGE-BODY-TEST';

function source(overrides = {}) {
  const calls = [];
  const fetchImpl = overrides.fetch ?? (async () => {
    throw new Error('network is disabled in tests');
  });
  const wrapped = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  };
  const usage = U.createGrokbotUsageSource({
    fetch: wrapped,
    home: HOME,
    platform: overrides.platform ?? 'darwin',
    env: overrides.env ?? {},
    exists: overrides.exists ?? (() => false),
    loadToken: overrides.loadToken ?? (async () => {
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
      return JSON.stringify(body);
    },
  };
}

const INSTALLED = () => true;

describe('Grok Bot usage paths', () => {
  test('user data, data root and Cursor state follow the platform', () => {
    assert.equal(
      P.grokbotUserDataDir({}, {}, HOME, 'darwin'),
      '/Users/you/Library/Application Support/Grok Bot'
    );
    assert.equal(
      P.grokbotUserDataDir({}, { XDG_CONFIG_HOME: '/xdg' }, HOME, 'linux'),
      '/xdg/Grok Bot'
    );
    assert.equal(
      P.grokbotDataRoot({}, { SAND_DATA_ROOT: '/srv/sand' }, HOME),
      '/srv/sand'
    );
    assert.equal(
      P.grokbotDataRoot({ grokbotDataRoot: '~/bots' }, { SAND_DATA_ROOT: '/srv/sand' }, HOME),
      '/Users/you/bots'
    );
    assert.equal(
      P.cursorStateDb({}, {}, HOME, 'linux'),
      '/Users/you/.config/Cursor/User/globalStorage/state.vscdb'
    );
    assert.equal(P.GROKBOT_OPEN_URL, 'grokbot://app/v1/open');
  });
});

describe('Grok Bot usage decode', () => {
  test('weekly used percent and a seconds reset become one meter', () => {
    const decoded = D.decodeSandUsage({
      usagePercent: 42.4,
      nextResetTimestampUtc: RESET_SECONDS,
      hasNonZeroIncludedLimit: true,
      grokPlanLabel: 'Ultra',
    });
    assert.equal(decoded.kind, 'metric');
    assert.equal(decoded.metric.percent, 42);
    assert.equal(decoded.metric.id, 'weekly');
    assert.equal(decoded.metric.tag, '7d');
    assert.equal(
      decoded.metric.resetsAt,
      new Date(RESET_SECONDS * 1000).toISOString()
    );
    assert.equal(decoded.planLabel, 'Ultra');
  });

  test('a numeric string percent and an ISO reset are accepted', () => {
    const decoded = D.decodeSandUsage({
      usagePercent: '7',
      nextResetTimestampUtc: '2026-10-20T00:00:00.000Z',
    });
    assert.equal(decoded.metric.percent, 7);
    assert.equal(decoded.metric.resetsAt, '2026-10-20T00:00:00.000Z');
  });

  test('pooled and zero allowances are refusals, not a zero meter', () => {
    assert.equal(
      D.decodeSandUsage({
        usesPooledEnterpriseAllowance: true,
        usagePercent: 10,
      }).kind,
      'pooled'
    );
    assert.equal(
      D.decodeSandUsage({
        hasNonZeroIncludedLimit: false,
        usagePercent: 0,
      }).kind,
      'no-allowance'
    );
  });

  test('a missing or negative percent is not a meter', () => {
    assert.equal(D.decodeSandUsage({ hasNonZeroIncludedLimit: true }), null);
    assert.equal(D.decodeSandUsage({ usagePercent: -1 }), null);
    assert.equal(D.planLabelOf('Ultra <script>'), 'Ultra script');
  });
});

describe('Grok Bot usage source', () => {
  test('does not call Cursor when Grok Bot is not installed', async () => {
    let looked = false;
    const { usage, calls } = source({
      loadToken: async () => {
        looked = true;
        return TOKEN;
      },
    });
    await assert.rejects(
      usage.fetch({}),
      error => error.problem === 'not-installed'
    );
    assert.equal(looked, false);
    assert.equal(calls.length, 0);
  });

  test('a missing Cursor login is not signed in, and the token is not fetched', async () => {
    const { usage, calls } = source({
      exists: INSTALLED,
      loadToken: async () => null,
    });
    await assert.rejects(
      usage.fetch({}),
      error => error.problem === 'not-signed-in'
    );
    assert.equal(calls.length, 0);
    const text = usage.errorText(
      new Kit.ProviderError('no-credentials', 'x'),
      'en'
    );
    assert.equal(text.title.length > 0, true);
  });

  test('posts the weekly status call with the Cursor token and reads the meter', async () => {
    const { usage, calls } = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () =>
        jsonResponse(200, {
          usagePercent: 42,
          nextResetTimestampUtc: RESET_SECONDS,
          hasNonZeroIncludedLimit: true,
          grokPlanLabel: 'Ultra',
          note: PLANTED,
        }),
    });
    const metrics = await usage.fetch({});
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].percent, 42);
    assert.equal(metrics[0].label, 'Weekly');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, U.SAND_USAGE_ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{}');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers['Connect-Protocol-Version'], '1');
    const described = await usage.describe({});
    assert.equal(described.success, true);
    assert.equal(described.planLabel, 'Ultra');
    assert.equal(JSON.stringify(described).includes(TOKEN), false);
    assert.equal(JSON.stringify(described).includes(PLANTED), false);
    assert.equal(usage.metricLabel(metrics[0], 'zh'), '每周');
  });

  test('a pooled allowance and a rejected login stay off the meter', async () => {
    const pooled = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () =>
        jsonResponse(200, {
          usesPooledEnterpriseAllowance: true,
          usagePercent: 80,
          detail: PLANTED,
        }),
    });
    await assert.rejects(
      pooled.usage.fetch({}),
      error => error.problem === 'pooled' && !String(error).includes(PLANTED)
    );
    const face = pooled.usage.errorText(
      await pooled.usage.fetch({}).catch(error => error),
      'zh'
    );
    assert.equal(face.title, '共享额度');
    assert.equal(face.message.includes(TOKEN), false);

    const denied = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () => jsonResponse(401, { message: PLANTED, token: TOKEN }),
    });
    await assert.rejects(denied.usage.fetch({}), error => {
      assert.equal(error.problem, 'login-expired');
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message.includes(PLANTED), false);
      return true;
    });
  });

  test('no included allowance is unsupported, and a rate limit carries a wait', async () => {
    const none = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () =>
        jsonResponse(200, { hasNonZeroIncludedLimit: false, usagePercent: 0 }),
    });
    await assert.rejects(
      none.usage.fetch({}),
      error => error.problem === 'no-allowance'
    );

    const limited = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () => jsonResponse(429, { message: PLANTED }, { 'retry-after': '90' }),
    });
    const error = await limited.usage.fetch({}).catch(caught => caught);
    assert.equal(error.problem, 'rate-limited');
    assert.equal(error.retryAfterSeconds, 90);
    assert.equal(limited.usage.keepLastOnError(error), false);
  });

  test('a network failure keeps the last meter and does not quote the token', async () => {
    const { usage } = source({
      exists: INSTALLED,
      loadToken: async () => TOKEN,
      fetch: async () => {
        throw new Error(`socket down ${TOKEN}`);
      },
    });
    const error = await usage.fetch({}).catch(caught => caught);
    assert.equal(error.problem, 'network');
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(usage.keepLastOnError(error), true);
    assert.equal(usage.logText(error).includes(TOKEN), false);
  });

  test('an unreadable token store is not reported as signed out', async () => {
    const { Text } = { Text: req('providers/grokbot/usageText.js') };
    const { usage } = source({
      exists: INSTALLED,
      loadToken: async () => {
        throw new Text.GrokbotUsageError(
          'state-unreadable',
          'Cursor state database could not be opened'
        );
      },
    });
    const described = await usage.describe({});
    assert.equal(described.success, false);
    assert.equal(described.problem, 'state-unreadable');
    assert.equal(String(described.error).includes(TOKEN), false);
  });

  test('a sealed login the keychain will not open is not sent to Cursor', async () => {
    const Text = req('providers/grokbot/usageText.js');
    const { usage, calls } = source({
      exists: INSTALLED,
      loadToken: async () => {
        throw new Text.GrokbotUsageError(
          'keychain-blocked',
          'Cursor sealed its login and the keychain did not hand over the key'
        );
      },
    });
    const error = await usage.fetch({}).catch(caught => caught);
    assert.equal(error.problem, 'keychain-blocked');
    assert.equal(calls.length, 0);
    assert.equal(usage.errorText(error, 'en').message, 'Allow Cursor login');
    assert.equal(usage.errorText(error, 'zh').title, '钥匙串未允许');
    assert.equal(usage.logText(error).includes(TOKEN), false);
  });
});

const KEY_PASSWORD = 'FAKE-CURSOR-KEY';

function fakeJwt(tag) {
  const part = name => Buffer.from(`fake-claim-${name}-TEST`).toString('base64url');
  return [part(`${tag}-h`), part(`${tag}-p`), part(`${tag}-s`)].join('.');
}

/** Independent of cursorSeal.ts: Chromium's macOS OSCrypt, v10. */
function sealJwt(password, plaintext) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const body = Buffer.concat([
    Buffer.from('v10'),
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return `${Seal.SEALED_PREFIX}${body.toString('base64')}`;
}

describe('sealed Cursor login', () => {
  test('a sealed cell opens to the JWT; a plaintext JWT never asks the keychain', async () => {
    Seal.resetCursorSealState();
    const jwt = fakeJwt('open');
    const sealed = sealJwt(KEY_PASSWORD, jwt);
    assert.equal(sealed.includes('.'), false);
    let asks = 0;
    const opened = await Seal.openStoredCursorToken(sealed, {
      platform: 'darwin',
      readPassword: async () => {
        asks += 1;
        return KEY_PASSWORD;
      },
    });
    assert.equal(opened.kind, 'token');
    assert.equal(opened.token, jwt);
    assert.equal(asks, 1);
    const again = await Seal.openStoredCursorToken(sealed, {
      platform: 'darwin',
      readPassword: async () => {
        asks += 1;
        return KEY_PASSWORD;
      },
    });
    assert.equal(again.token, jwt);
    assert.equal(asks, 1);
    const plain = await Seal.openStoredCursorToken(fakeJwt('plain'), {
      platform: 'darwin',
      readPassword: async () => {
        throw new Error('keychain should stay closed');
      },
    });
    assert.equal(plain.kind, 'token');
  });

  test('a denial is remembered until the key is pressed', async () => {
    Seal.resetCursorSealState();
    const sealed = sealJwt(KEY_PASSWORD, fakeJwt('deny'));
    let asks = 0;
    const readPassword = async () => {
      asks += 1;
      return null;
    };
    const first = await Seal.openStoredCursorToken(sealed, { platform: 'darwin', readPassword });
    const second = await Seal.openStoredCursorToken(sealed, { platform: 'darwin', readPassword });
    assert.equal(first.kind, 'keychain-blocked');
    assert.equal(second.kind, 'keychain-blocked');
    assert.equal(asks, 1);
    const { usage } = source({ exists: INSTALLED, loadToken: async () => null });
    await usage.preparePress();
    const third = await Seal.openStoredCursorToken(sealed, {
      platform: 'darwin',
      readPassword: async () => {
        asks += 1;
        return KEY_PASSWORD;
      },
    });
    assert.equal(third.kind, 'token');
    assert.equal(asks, 2);
  });

  test('a non-JWT cell is not a bearer, and a wrong key does not quote it', async () => {
    Seal.resetCursorSealState();
    const opaque = 'A'.repeat(583);
    assert.equal(opaque.includes('.'), false);
    let asked = false;
    const blocked = await Seal.openStoredCursorToken(opaque, {
      platform: 'darwin',
      readPassword: async () => {
        asked = true;
        return KEY_PASSWORD;
      },
    });
    assert.equal(blocked.kind, 'login-unreadable');
    assert.equal(asked, false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-seal-'));
    const db = path.join(dir, 'state.vscdb');
    const jwt = fakeJwt('db');
    const sealed = sealJwt(KEY_PASSWORD, jwt);
    const { DatabaseSync } = require('node:sqlite');
    const handle = new DatabaseSync(db);
    handle.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
    handle.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', sealed);
    handle.close();
    try {
      const token = await A.readCursorAccessToken(db, os.tmpdir(), {
        platform: 'darwin',
        readPassword: async () => KEY_PASSWORD,
      });
      assert.equal(token, jwt);
      Seal.resetCursorSealState();
      await assert.rejects(
        A.readCursorAccessToken(db, os.tmpdir(), {
          platform: 'darwin',
          readPassword: async () => 'wrong-key',
        }),
        error => {
          assert.equal(error.problem, 'login-unreadable');
          assert.equal(error.message.includes(KEY_PASSWORD), false);
          assert.equal(error.message.includes(jwt), false);
          assert.equal(error.message.includes(sealed), false);
          assert.equal(error.message.includes('wrong-key'), false);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
