// Synthetic membership fixtures, injected token readers and fetch stubs only.
// The integration cases use an isolated Code login and never open the app's
// credential store, refresh a web session or send a real network request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build = process.env.KIMI_USAGE_TEST_BUILD ?? path.join(here, '..', '.test-build-kimi-usage');
const req = file => require(path.join(build, file));
const Membership = req('providers/kimi/usageMembership.js');
const Api = req('providers/kimi/usageApi.js');
const Face = req('providers/kimi/usageFace.js');
const Usage = req('providers/kimi/usage.js');
const Auth = req('providers/kimi/usageAuth.js');

const FIXED = Date.parse('2026-10-12T04:00:00.000Z');
const RESET = '2026-10-21T00:00:00+08:00';
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-membership-test-'));
const originalFetch = globalThis.fetch;
const offline = async () => { throw new Error('Unexpected network request in membership tests'); };
globalThis.fetch = offline;
after(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(empty, { recursive: true, force: true });
});
beforeEach(() => {
  Usage.resetUsageState();
  Auth.resetAuthState();
  globalThis.fetch = offline;
});

const secret = kind => ['kimi', 'FAKE', kind, 'q'.repeat(20)].join('-');
const payload = (ratio = 0.5905, overrides = {}) => ({
  subscriptionBalance: {
    type: 'SUBSCRIPTION', feature: 'FEATURE_OMNI', amountUsedRatio: ratio,
    expireTime: RESET, ...overrides,
  },
});
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const total = () => Membership.parseMembershipPayload(payload());
const noRatio = () => {
  const value = payload();
  delete value.subscriptionBalance.amountUsedRatio;
  return value;
};

describe('the shared membership total', () => {
  test('59.05% total usage preserves the app precision and leaves 40.95%', () => {
    const metric = Membership.parseMembershipPayload(payload());
    assert.deepEqual(metric, {
      id: 'monthly', label: 'Month', percent: 59.05,
      resetsAt: '2026-10-20T16:00:00.000Z',
    });
    assert.equal(Face.membershipRemaining(metric), 40.95);
    assert.equal(Membership.parseMembershipPayload(payload('0.5905')).percent, 59.05);
  });

  test('unused, exhausted and overdrawn totals stay within 0–100%', () => {
    for (const [ratio, used, left] of [[0, 0, 100], [1, 100, 0], [1.4, 100, 0]]) {
      const metric = Membership.parseMembershipPayload(payload(ratio));
      assert.equal(metric.percent, used);
      assert.equal(Face.membershipRemaining(metric), left);
    }
  });

  test('missing or invalid ratios remain unknown instead of reporting an unused quota', () => {
    assert.equal(Membership.parseMembershipPayload(noRatio()), null);
    for (const ratio of [null, undefined, '', ' ', 'not-a-ratio', false, {}, NaN, Infinity, -0.1]) {
      assert.equal(Membership.parseMembershipPayload(payload(0.5905, { amountUsedRatio: ratio })), null);
    }
  });

  test('Code-specific and booster balances never become the membership total', () => {
    for (const changes of [
      { feature: 'FEATURE_CODING' }, { type: 'BOOSTER' }, { feature: undefined }, { type: undefined },
    ]) {
      assert.equal(Membership.parseMembershipPayload(payload(0.5905, changes)), null);
    }
    assert.equal(Membership.parseMembershipPayload({
      featureBalances: [{ type: 'SUBSCRIPTION', feature: 'FEATURE_CODING', amountUsedRatio: 0 }],
      boosterBalance: { type: 'BOOSTER', feature: 'FEATURE_OMNI', amountUsedRatio: 0 },
    }), null);
    for (const value of [null, [], 'not-an-object', {}, { subscriptionBalance: [] }]) {
      assert.equal(Membership.parseMembershipPayload(value), null);
    }
  });

  test('an invalid reset date does not discard a valid total or invent a date', () => {
    for (const expireTime of [undefined, '', 'not-a-date', 42]) {
      const metric = Membership.parseMembershipPayload(payload(0.5905, { expireTime }));
      assert.equal(metric.percent, 59.05);
      assert.equal(metric.resetsAt, null);
    }
  });

  test('Code API total precision changes while rolling and Code-only limits keep their existing rounding', () => {
    const metrics = Api.parseUsagePayload({ usages: {
      limit_5h: { used_ratio: 0.5905 },
      limit_7d: { used_ratio: 0.5905 },
      limit_month_total: { used_ratio: 0.5905 },
      limit_month_code: { used_ratio: 0.5905 },
    } });
    assert.equal(metrics.find(m => m.id === 'monthly').percent, 59.05);
    for (const id of ['5h', 'weekly', 'monthly_code']) {
      assert.equal(metrics.find(m => m.id === id).percent, 60);
    }
    const legacy = Api.parseUsagePayload({ limits: [{
      window: { duration: 30, timeUnit: 'DAY' },
      detail: { used: 5905, limit: 10000, resetTime: RESET },
    }] });
    assert.equal(legacy[0].id, 'monthly');
    assert.equal(legacy[0].percent, 59.05);
    assert.equal(Face.membershipRemaining(legacy[0]), 40.95);
  });

  test('Code API missing and invalid monthly ratios do not fabricate totals', () => {
    for (const ratio of [undefined, null, '', NaN, -0.1]) {
      const metrics = Api.parseUsagePayload({ usages: {
        limit_5h: { used_ratio: 0 }, limit_month_total: { used_ratio: ratio },
      } });
      assert.equal(metrics.some(m => m.id === 'monthly'), false);
      assert.equal(metrics.find(m => m.id === '5h').percent, 0);
    }
  });
});

function membershipDeps(fetch, state = { kind: 'valid', accessToken: secret('app-access') }) {
  const calls = { reads: 0, requests: [] };
  return {
    calls,
    deps: {
      now: () => FIXED,
      readToken: async (folder, options) => {
        calls.reads++;
        assert.equal(folder, 'MOCK-DESKTOP');
        assert.equal(options.now, FIXED);
        return state;
      },
      fetch: async (url, init) => {
        calls.requests.push({ url, init });
        return fetch(url, init);
      },
    },
  };
}

describe('the optional membership request', () => {
  test('sends a read-only app token only to the fixed official endpoint without redirects or device metadata', async () => {
    const token = secret('app-access');
    const stub = membershipDeps(async () => json({ ...payload(), ignoredToken: token }), {
      kind: 'valid', accessToken: token,
    });
    const metric = await Membership.fetchDesktopMembership('MOCK-DESKTOP', stub.deps);
    assert.deepEqual(metric, total());
    assert.equal(stub.calls.reads, 1);
    assert.equal(stub.calls.requests.length, 1);
    const { url, init } = stub.calls.requests[0];
    assert.equal(url, Membership.MEMBERSHIP_STATS_URL);
    assert.equal(url, 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{}');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.deepEqual([...headers.keys()].sort(), ['authorization', 'connect-protocol-version', 'content-type']);
    assert.ok(headers.get('authorization') === `Bearer ${token}`, 'the injected token is used');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('connect-protocol-version'), '1');
    assert.ok(!JSON.stringify(metric).includes(token), 'credentials never enter the returned metric');
  });

  test('missing, expired and unreadable app sessions skip requests', async () => {
    for (const kind of ['missing', 'expired', 'unreadable']) {
      const stub = membershipDeps(offline, { kind });
      assert.equal(await Membership.fetchDesktopMembership('MOCK-DESKTOP', stub.deps), null);
      assert.equal(stub.calls.reads, 1);
      assert.equal(stub.calls.requests.length, 0);
    }
    let requests = 0;
    const result = await Membership.fetchDesktopMembership('MOCK-DESKTOP', {
      now: () => FIXED,
      readToken: async () => { throw new Error('unreadable synthetic store'); },
      fetch: async () => { requests++; return json(payload()); },
    });
    assert.equal(result, null);
    assert.equal(requests, 0);
  });

  for (const status of [401, 403, 429, 500]) {
    test(`HTTP ${status} is unavailable and never refreshes or retries the app login`, async () => {
      const stub = membershipDeps(async () => json({}, status));
      assert.equal(await Membership.fetchDesktopMembership('MOCK-DESKTOP', stub.deps), null);
      assert.equal(stub.calls.reads, 1);
      assert.equal(stub.calls.requests.length, 1);
      assert.equal(stub.calls.requests[0].url, Membership.MEMBERSHIP_STATS_URL);
    });
  }

  test('transport, body, JSON and oversized replies fail quietly without leaking a synthetic credential', async () => {
    const token = secret('do-not-log');
    const failures = [
      async () => { throw new Error(token); },
      async () => ({ ok: true, text: async () => { throw new Error(token); } }),
      async () => ({ ok: true, text: async () => `invalid-json-${token}` }),
      async () => ({ ok: true, text: async () => ' '.repeat(1024 * 1024 + 1) }),
      async () => json(noRatio()),
    ];
    const messages = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const name of Object.keys(original)) console[name] = (...args) => messages.push(args);
    try {
      for (const failure of failures) {
        const stub = membershipDeps(failure, { kind: 'valid', accessToken: token });
        assert.equal(await Membership.fetchDesktopMembership('MOCK-DESKTOP', stub.deps), null);
        assert.equal(stub.calls.requests.length, 1);
      }
    } finally {
      Object.assign(console, original);
    }
    assert.equal(messages.length, 0, 'optional membership failures are never logged');
  });
});

let caseNo = 0;
function tree(loggedIn = true) {
  const root = path.join(empty, `case-${++caseNo}`);
  const code = path.join(root, 'code');
  const desktop = path.join(root, 'desktop');
  fs.mkdirSync(desktop, { recursive: true });
  let loginFile = null;
  if (loggedIn) {
    const credentials = path.join(code, 'credentials');
    fs.mkdirSync(credentials, { recursive: true, mode: 0o700 });
    loginFile = path.join(credentials, 'kimi-code.json');
    fs.writeFileSync(loginFile, JSON.stringify({
      access_token: secret('code-access'), refresh_token: secret('code-refresh'),
      expires_at: Math.floor((FIXED + 2 * 3_600_000) / 1000),
    }), { mode: 0o600 });
  }
  return {
    code, desktop, loginFile,
    config: { kimiDir: code, kimiDesktopDir: desktop, kimiRefreshLogin: false },
  };
}

function codeDeps(fetch, membershipFetch) {
  return {
    fetch, membershipFetch, now: () => FIXED, sleep: async () => {},
    platform: 'darwin', env: {},
    lock: { retries: 1, delayMs: 1, staleMs: 5000, updateMs: 1000 },
  };
}
const codePayload = { usages: {
  limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0.25 },
  limit_month_code: { used_ratio: 0.12 },
} };

describe('Code quotas with optional membership enrichment', () => {
  test('a missing Code total adds the app membership total without changing Code meters', async () => {
    const t = tree();
    let codeCalls = 0;
    let membershipCalls = 0;
    const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(
      async url => {
        codeCalls++;
        assert.ok(String(url).endsWith('/usages'));
        return json(codePayload);
      },
      async desktop => {
        membershipCalls++;
        assert.equal(desktop, t.desktop);
        return total();
      }
    ));
    assert.equal(codeCalls, 1);
    assert.equal(membershipCalls, 1);
    assert.equal(metrics.find(m => m.id === 'monthly').percent, 59.05);
    assert.equal(Face.membershipRemaining(metrics.find(m => m.id === 'monthly')), 40.95);
    assert.equal(metrics.find(m => m.id === '5h').percent, 0);
    assert.equal(metrics.find(m => m.id === 'weekly').percent, 25);
    assert.equal(metrics.find(m => m.id === 'monthly_code').percent, 12);
  });

  test('membership enrichment preserves Code fallback order while the default face finds the total by id', async () => {
    const t = tree();
    const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(
      async () => json({ usages: {
        limit_5h: { used_ratio: 0 }, limit_7d: { used_ratio: 0.25 },
      } }),
      async () => total()
    ));
    assert.deepEqual(metrics.map(m => m.id), ['5h', 'weekly', 'monthly']);
    for (const missing of ['monthly_code', 'extra']) {
      assert.equal(Usage.usageSource.substituteMetric(missing, metrics), '5h');
    }
    assert.equal(Usage.usageSource.substituteMetric('membership', metrics), null);
    assert.equal(Face.membershipRemaining(metrics.find(m => m.id === 'monthly')), 40.95);
    const request = {
      metric: 'membership', metrics, width: 240, lang: 'en',
      showResetTime: false, data: { showMark: false },
    };
    const enriched = Usage.usageSource.face(request);
    const isolated = Usage.usageSource.face({ ...request, metrics: [total()] });
    assert.ok(enriched.image === isolated.image, 'Code-first order cannot change the membership face');
    assert.ok(
      Usage.usageSource.face({ ...request, metric: '' }).image === isolated.image,
      'legacy empty defaults also read the total by id'
    );
  });

  test('a Code monthly total takes precedence and skips the desktop credential reader', async () => {
    const t = tree();
    let appCalls = 0;
    const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(
      async () => json({ usages: { ...codePayload.usages, limit_month_total: { used_ratio: 0.1234 } } }),
      async () => { appCalls++; throw new Error('Desktop token must not be read'); }
    ));
    assert.equal(appCalls, 0);
    assert.equal(metrics.find(m => m.id === 'monthly').percent, 12.34);
  });

  test('an app membership login works without a Code installation or login', async () => {
    const t = tree(false);
    let appCalls = 0;
    const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(offline, async () => {
      appCalls++;
      return total();
    }));
    assert.equal(appCalls, 1);
    assert.deepEqual(metrics, [total()]);
  });

  for (const status of [401, 403, 404, 429, 500]) {
    test(`a Code HTTP ${status} cannot erase a valid app membership total`, async () => {
      const t = tree();
      const initial = fs.readFileSync(t.loginFile, 'utf8');
      let requests = 0;
      const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(
        async url => {
          requests++;
          assert.ok(String(url).endsWith('/usages'), 'no OAuth refresh is permitted');
          return json({}, status);
        },
        async () => total()
      ));
      assert.deepEqual(metrics, [total()]);
      assert.equal(requests, 1);
      assert.ok(fs.readFileSync(t.loginFile, 'utf8') === initial, 'the login remains unchanged');
    });
  }

  test('a Code network or parsing failure cannot erase a valid app membership total', async () => {
    for (const response of [
      async () => { throw new Error('Synthetic offline Code API'); },
      async () => new Response('{invalid-json'),
    ]) {
      const t = tree();
      const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(response, async () => total()));
      assert.deepEqual(metrics, [total()]);
    }
  });

  test('unavailable app membership leaves the successfully fetched Code quotas intact', async () => {
    const t = tree();
    const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(async () => json(codePayload), async () => null));
    assert.deepEqual(metrics, Api.parseUsagePayload(codePayload));
    assert.equal(metrics.some(m => m.id === 'monthly'), false);
  });

  test('real membership enrichment failure handling preserves Code quotas without refresh', async () => {
    for (const appResponse of [
      async () => json({}, 401),
      async () => json({}, 403),
      async () => json({}, 429),
      async () => new Response('{invalid-json'),
      async () => { throw new Error('Synthetic offline app API'); },
    ]) {
      const t = tree();
      const stub = membershipDeps(appResponse);
      const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(
        async () => json(codePayload),
        async () => Membership.fetchDesktopMembership('MOCK-DESKTOP', stub.deps)
      ));
      assert.deepEqual(metrics, Api.parseUsagePayload(codePayload));
      assert.equal(stub.calls.reads, 1);
      assert.equal(stub.calls.requests.length, 1);
      assert.equal(stub.calls.requests[0].url, Membership.MEMBERSHIP_STATS_URL);
    }
  });

  test('an unexpected optional enrichment rejection also leaves Code quotas intact', async () => {
    const t = tree();
    const metrics = await Usage.fetchKimiUsage(t.config, codeDeps(
      async () => json(codePayload),
      async () => { throw new Error('Synthetic optional reader failure'); }
    ));
    assert.deepEqual(metrics, Api.parseUsagePayload(codePayload));
  });
});
