// Tests for the Antigravity usage source (src/providers/antigravity/usage*.ts),
// run against the tsc output of `npm run test:antigravity-usage`
// (.test-build-antigravity-usage/). Rules: synthetic fixtures only (see
// CLAUDE.md), no network, no local RPC and no real process lookups (fetch,
// http/https, net and child_process are stubbed below; fakes are injected),
// never read the real home folder (HOME points at an empty temp folder),
// token-shaped strings (CSRF tokens) are built at runtime.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-usage-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};
// nothing in these tests may reach a real Antigravity language server or
// start a program: every such call fails loudly
const blocked = name => () => {
  throw new Error(`${name} is disabled in tests`);
};
for (const [mod, names] of [
  [http, ['request', 'get']],
  [https, ['request', 'get']],
  [net, ['connect', 'createConnection']],
  [childProcess, ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync']],
]) {
  for (const name of names) mod[name] = blocked(name);
}
after(() => fs.rmSync(empty, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.ANTIGRAVITY_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-antigravity-usage');
const req = p => require(path.join(build, p));
const U = req('providers/antigravity/usage.js');
const M = req('providers/antigravity/usageMetrics.js');
const P = req('providers/antigravity/usageProcess.js');
const R = req('providers/antigravity/usageRpc.js');
const T = req('providers/antigravity/usageText.js');
const F = req('providers/antigravity/usageFace.js');
const Kit = req('providers/kit.js');
const { UsageKeys } = req('usageKey.js');
const { ANTIGRAVITY_BRAND } = req('providers/antigravity/brand.js');

const CONFIG = {
  antigravityDir: path.join(empty, 'gemini'),
  antigravityPath: path.join(empty, 'no-agy'),
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** [width, height] of a PNG data URL. */
function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// --- synthetic fixtures (built at runtime, never real) -----------------------

/** A CSRF-token-shaped value: a UUID with few distinct digits. */
const token = n => ['00000000', '0000', '4000', '8000', String(n).padStart(12, '0')].join('-');
const TOKEN_APP = token(1);
const TOKEN_IDE = token(2);
const TOKEN_OTHER = token(9);
const UID = 501;
const EMAIL = ['you', 'example.com'].join('@');
const MIN = 60_000;
const T0 = Date.parse('2026-10-06T12:00:00.000Z');
const at = minutes => new Date(T0 + minutes * MIN).toISOString();

const APP_EXE = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const IDE_EXE =
  '/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm';

const appCommand = (tok = TOKEN_APP) =>
  `${APP_EXE} --standalone --subclient_type hub --https_server_port 0 --csrf_token ${tok} --app_data_dir antigravity --host_bridge_url http://127.0.0.1:40999 --host_bridge_token ${TOKEN_OTHER}`;
const ideCommand = (tok = TOKEN_IDE) =>
  `${IDE_EXE} --extension_server_csrf_token ${TOKEN_OTHER} --csrf_token ${tok} --extension_server_port 41009 --app_data_dir antigravity-ide --subclient_type ide`;

/** The observed quota summary shape, synthetic values. */
function summary({ gemini5h = 0.4, geminiWeekly = 0.82, claude5h = 1, claudeWeekly = 1 } = {}) {
  return {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: geminiWeekly, resetTime: at(5 * 1440) },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: gemini5h, resetTime: at(150) },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: claudeWeekly, resetTime: at(7 * 1440) },
            { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: claude5h, resetTime: at(300) },
          ],
        },
      ],
      description: 'FAKE explanatory text',
    },
  };
}

/** A GetUserStatus answer (identity fields synthetic, never surfaced). */
function userStatus({ signedIn = true, models = [] } = {}) {
  return {
    userStatus: {
      ...(signedIn ? { name: 'FAKE Person', email: EMAIL } : {}),
      planStatus: { planInfo: { planName: 'FAKE Plan' } },
      cascadeModelConfigData: { clientModelConfigs: models },
      ...(signedIn ? { userTier: { id: 'fake-tier', name: 'FAKE Tier' } } : {}),
    },
  };
}

const ok = body => ({ status: 200, contentType: 'application/json', text: JSON.stringify(body) });
const connectError = (status, code, message = 'FAKE message') => ({
  status,
  contentType: 'application/json',
  text: JSON.stringify({ code, message }),
});
const TLS_ANSWER = {
  status: 400,
  contentType: 'text/plain',
  text: 'Client sent an HTTP request to an HTTPS server.\n',
};
const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

/**
 * A fake machine: language servers in the process table (ps), their ports
 * (lsof) and their answers (post). `servers` entries: { pid, product,
 * token, ports: { [port]: handler } } where a handler gets the request and
 * returns a RawReply, or throws.
 */
function fakeMachine(servers, { extraPs = [], checkToken = true } = {}) {
  const calls = { ps: 0, lsof: [], post: [], runArgs: [] };
  const state = { servers };
  const run = async (file, args) => {
    calls.runArgs.push([file, ...args]);
    if (args[0] === '-axww') {
      calls.ps++;
      const lines = [
        '    1     0 /sbin/launchd',
        ...extraPs,
        ...state.servers.map(
          s =>
            `${String(s.pid).padStart(5)} ${String(s.uid ?? UID).padStart(5)} ${
              s.command ?? (s.product === 'app' ? appCommand(s.token) : ideCommand(s.token))
            }`
        ),
      ];
      return `${lines.join('\n')}\n`;
    }
    const pid = Number(args[args.indexOf('-p') + 1]);
    calls.lsof.push(pid);
    const s = state.servers.find(x => x.pid === pid);
    if (!s) return '';
    return [
      `p${pid}`,
      ...Object.keys(s.ports).flatMap((port, i) => [`f${20 + i}`, `n127.0.0.1:${port}`]),
      'f30',
      'n[::1]:40998',
    ].join('\n');
  };
  const post = async request => {
    calls.post.push({
      port: request.port,
      method: request.method,
      body: request.body,
      token: request.token,
    });
    const s = state.servers.find(x => String(request.port) in x.ports);
    if (!s) throw refused();
    // the token must only go to a port of the server it came from
    if (checkToken) assert.equal(request.token, s.token, 'token sent to another server');
    const handler = s.ports[request.port];
    return handler(request, calls);
  };
  return { run, post, calls, state };
}

/** Routes a server's Connect port by method. */
const routes = table => request => {
  const route = table[request.method];
  if (!route) return connectError(404, 'unimplemented');
  return typeof route === 'function' ? route(request) : route;
};

let tmpCount = 0;
function tmpDir(name) {
  const dir = path.join(empty, `${name}-${++tmpCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A source wired to a fake machine and a clock. */
function source(machine, extra = {}) {
  const clock = { now: T0 };
  const src = U.createAntigravityUsageSource({
    now: () => clock.now,
    home: () => empty,
    platform: 'darwin',
    env: { PATH: '' },
    run: machine.run,
    post: machine.post,
    tools: () => ({ ps: '/bin/ps', lsof: '/usr/sbin/lsof' }),
    uid: () => UID,
    appFolders: () => [path.join(empty, 'no-apps')],
    ...extra,
  });
  return { src, clock };
}

const appServer = (table, extra = {}) => ({
  pid: 4100,
  product: 'app',
  token: TOKEN_APP,
  ports: { 41001: () => TLS_ANSWER, 41002: routes(table) },
  ...extra,
});
const ideServer = (table, extra = {}) => ({
  pid: 4200,
  product: 'ide',
  token: TOKEN_IDE,
  ports: { 41011: () => TLS_ANSWER, 41012: routes(table) },
  ...extra,
});

// --- process discovery ------------------------------------------------------

describe('language server discovery', () => {
  test('the app and the IDE servers are found with their tokens and skipped ports', () => {
    const app = P.parseServerCommand(10, appCommand());
    assert.deepEqual(app, { pid: 10, product: 'app', token: TOKEN_APP, skipPorts: [] });
    const ide = P.parseServerCommand(11, ideCommand());
    assert.equal(ide.product, 'ide');
    // --extension_server_csrf_token is never taken for the CSRF token
    assert.equal(ide.token, TOKEN_IDE);
    assert.deepEqual(ide.skipPorts, [41009]);
    const withLsp = P.parseServerCommand(
      12,
      `${IDE_EXE} --enable_lsp --lsp_port=41020 --csrf_token=${TOKEN_IDE} --app_data_dir=antigravity-ide --https_server_port 41021`
    );
    assert.deepEqual(withLsp.skipPorts, [41020, 41021]);
    // the old single-app layout counts as the app
    const old = P.parseServerCommand(
      13,
      `/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token ${TOKEN_APP} --app_data_dir antigravity`
    );
    assert.equal(old.product, 'app');
  });

  test('other programs, other products and broken tokens are not servers', () => {
    const cases = [
      // the CLI's data folder: agy has no separate server
      `${APP_EXE} --csrf_token ${TOKEN_APP} --app_data_dir antigravity-cli`,
      // another product's language server
      `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm --csrf_token ${TOKEN_APP} --app_data_dir windsurf`,
      // a command mentioning the server
      `/usr/bin/grep ${APP_EXE} --app_data_dir antigravity --csrf_token ${TOKEN_APP}`,
      `/bin/zsh -c ${APP_EXE} --app_data_dir antigravity --csrf_token ${TOKEN_APP}`,
      `node -e "language_server" --app_data_dir antigravity --csrf_token ${TOKEN_APP}`,
      // no token, only the extension server's, or a malformed one
      `${APP_EXE} --app_data_dir antigravity`,
      `${IDE_EXE} --extension_server_csrf_token ${TOKEN_OTHER} --app_data_dir antigravity-ide`,
      `${APP_EXE} --csrf_token a"b;c --app_data_dir antigravity`,
      // no data folder
      `${APP_EXE} --csrf_token ${TOKEN_APP}`,
    ];
    for (const command of cases) {
      assert.equal(P.parseServerCommand(1, command), null, command.slice(0, 60));
    }
  });

  test('ps output: own uid only, the app first, newest first', () => {
    const ps = [
      `  300   ${UID} ${ideCommand()}`,
      `  200   ${UID} ${appCommand()}`,
      `  400   ${UID} ${ideCommand(token(3))}`,
      `  500   502 ${appCommand(token(4))}`,
      'garbage line',
      `  600   ${UID} /usr/bin/grep language_server --app_data_dir antigravity`,
    ].join('\n');
    const found = P.parseServers(ps, UID);
    assert.deepEqual(
      found.map(s => [s.pid, s.product]),
      [
        [200, 'app'],
        [400, 'ide'],
        [300, 'ide'],
      ]
    );
    assert.equal(P.parseServers(ps, null).length, 4);
  });

  test('lsof output: 127.0.0.1 listeners only, highest first, skipped ports out', () => {
    const out = ['p42', 'f10', 'n127.0.0.1:41001', 'f11', 'n127.0.0.1:41002', 'f12', 'n[::1]:41003', 'f13', 'n*:41004', 'f14', 'n127.0.0.1:41002', 'f15', 'n127.0.0.1:41009'].join('\n');
    assert.deepEqual(P.parseListeningPorts(out), [41009, 41002, 41001]);
    assert.deepEqual(P.parseListeningPorts(out, [41009]), [41002, 41001]);
    assert.deepEqual(P.parseListeningPorts(''), []);
  });

  test('ps and lsof are run without a shell, and never with the token', async () => {
    const machine = fakeMachine([appServer({})]);
    const servers = await P.findServers(machine.run, UID, '/bin/ps');
    assert.equal(servers.length, 1);
    const ports = await P.serverPorts(machine.run, servers[0], '/usr/sbin/lsof');
    assert.deepEqual(ports, [41002, 41001]);
    assert.deepEqual(machine.calls.runArgs, [
      ['/bin/ps', '-axww', '-o', 'pid=,uid=,command='],
      ['/usr/sbin/lsof', '-nP', '-a', '-p', '4100', '-iTCP', '-sTCP:LISTEN', '-Fn'],
    ]);
    // a failing lsof is "no ports"
    const failing = await P.serverPorts(async () => {
      throw new Error('lsof failed');
    }, servers[0]);
    assert.deepEqual(failing, []);
  });
});

// --- Connect replies ----------------------------------------------------------

describe('Connect replies', () => {
  test('answers are classified without quoting them', () => {
    assert.deepEqual(R.classifyReply(ok({ response: {} })), { kind: 'ok', json: { response: {} } });
    assert.deepEqual(R.classifyReply({ status: 200, contentType: '', text: 'not json' }), { kind: 'parse' });
    assert.deepEqual(R.classifyReply(TLS_ANSWER), { kind: 'wrong-port' });
    const echoed = 'FAKE-ECHOED-REQUEST-DATA';
    const signedOut = R.classifyReply(connectError(401, 'unauthenticated', echoed));
    assert.deepEqual(signedOut, { kind: 'connect', status: 401, code: 'unauthenticated', csrf: false });
    const csrf = R.classifyReply(connectError(403, 'permission_denied', 'invalid CSRF token'));
    assert.equal(csrf.csrf, true);
    assert.deepEqual(R.classifyReply({ status: 502, contentType: 'text/html', text: '<html>' }), { kind: 'http', status: 502 });
    assert.deepEqual(R.classifyReply(connectError(500, 'Weird Code!')).code, 'weirdcode');
    assert.ok(!JSON.stringify(signedOut).includes(echoed));
  });

  test('the transport refuses anything but a valid loopback port and method', async () => {
    await assert.rejects(
      R.httpPost({ port: 0, method: 'GetUserStatus', body: {}, token: TOKEN_APP, timeoutMs: 10, maxBytes: 10 }),
      { name: 'RpcTransportError', message: /bad port/ }
    );
    await assert.rejects(
      R.httpPost({ port: 41002, method: '../x', body: {}, token: TOKEN_APP, timeoutMs: 10, maxBytes: 10 }),
      { message: /bad method/ }
    );
    assert.equal(R.describeTransport(refused()), 'ECONNREFUSED');
    assert.equal(R.describeTransport(new Error(`odd ${TOKEN_APP}`)), 'request failed');
  });
});

// --- quota summary → metrics ---------------------------------------------------

describe('quota summary → metrics', () => {
  test('the observed answer: lowest, per group and per limit, used percent', () => {
    const groups = M.parseQuotaSummary(summary(), T0);
    assert.deepEqual(groups.map(g => [g.key, g.short, g.name]), [
      ['gemini', 'Gemini', 'Gemini Models'],
      ['3p', 'Claude', 'Claude and GPT models'],
    ]);
    // 5h before weekly, whatever the server's order
    assert.deepEqual(groups[0].buckets.map(b => b.window), ['5h', 'weekly']);
    const metrics = M.groupMetrics(groups);
    assert.deepEqual(
      metrics.map(m => [m.id, m.label, m.percent, m.resetsAt, m.tag]),
      [
        ['lowest', 'Gemini 5h', 60, at(150), '5h'],
        ['group:gemini', 'Gemini 5h', 60, at(150), '5h'],
        ['gemini-5h', 'Gemini 5h', 60, at(150), '5h'],
        ['gemini-weekly', 'Gemini Weekly', 18, at(5 * 1440), '7d'],
        ['group:3p', 'Claude 5h', 0, null, '5h'],
        // nothing used: the reset time only rolls, so none is shown
        ['3p-5h', 'Claude 5h', 0, null, '5h'],
        ['3p-weekly', 'Claude Weekly', 0, null, '7d'],
      ]
    );
    assert.deepEqual(M.dualViews(groups), [
      { id: 'gemini-dual', short: 'Gemini', group: 'Gemini Models', fiveHour: 'gemini-5h', weekly: 'gemini-weekly' },
      { id: '3p-dual', short: 'Claude', group: 'Claude and GPT models', fiveHour: '3p-5h', weekly: '3p-weekly' },
    ]);
    assert.equal(M.anyStale(groups), false);
  });

  test('the lowest follows the most used limit in any group', () => {
    const metrics = M.groupMetrics(M.parseQuotaSummary(summary({ claudeWeekly: 0.05 }), T0));
    const lowest = metrics.find(m => m.id === 'lowest');
    assert.deepEqual([lowest.label, lowest.percent, lowest.tag], ['Claude Weekly', 95, '7d']);
    assert.equal(metrics.find(m => m.id === 'group:3p').label, 'Claude Weekly');
  });

  test('new buckets and groups get generic ids and names', () => {
    const groups = M.parseQuotaSummary(
      {
        response: {
          groups: [
            {
              displayName: 'Imagen models',
              buckets: [
                { bucketId: 'img-daily', displayName: 'Daily', remainingFraction: '0.25', resetTime: at(600) },
                { bucketId: 'img-monthly', window: 'MONTHLY', remainingFraction: 0.5, resetTime: at(9000) },
              ],
            },
          ],
          // buckets outside any group form one more group
          buckets: [{ bucketId: 'extra-burst', displayName: 'Burst', window: '15m', remainingFraction: 0.9 }],
        },
      },
      T0
    );
    assert.deepEqual(groups.map(g => [g.key, g.short]), [
      ['img', 'Imagen'],
      ['extra', 'extra'],
    ]);
    const metrics = M.groupMetrics(groups);
    assert.deepEqual(
      metrics.map(m => [m.id, m.label, m.percent, m.tag ?? null]),
      [
        ['lowest', 'Imagen Daily', 75, '1d'],
        ['group:img', 'Imagen Daily', 75, '1d'],
        ['bucket:img-daily', 'Imagen Daily', 75, '1d'],
        ['bucket:img-monthly', 'Imagen Monthly', 50, '30d'],
        ['bucket:extra-burst', 'extra 15m', 10, null],
      ]
    );
    assert.deepEqual(M.dualViews(groups), []);
  });

  test('malformed, disabled and count-only buckets', () => {
    const groups = M.parseQuotaSummary(
      {
        response: {
          groups: [
            null,
            'junk',
            {
              displayName: 'Gemini Models',
              buckets: [
                null,
                {},
                { remainingFraction: 0.5 },
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: -2, resetTime: at(60) },
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9 },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 7 },
                { bucketId: 'gemini-daily', window: 'daily', remainingAmount: '12' },
                { bucketId: 'gemini-monthly', window: 'monthly', remainingFraction: 0.1, disabled: true },
                { bucketId: 'gemini<script>', displayName: 'x\u0000y', remainingFraction: 'NaN' },
              ],
            },
          ],
        },
      },
      T0
    );
    assert.equal(groups.length, 1);
    const buckets = groups[0].buckets;
    assert.deepEqual(
      buckets.map(b => [b.metricId, b.left, b.amount, b.disabled]),
      [
        ['gemini-5h', 0, null, false],
        ['bucket:gemini-daily', null, 12, false],
        ['gemini-weekly', 100, null, false],
        ['bucket:gemini-monthly', 10, null, true],
        ['bucket:geminiscript', null, null, false],
      ]
    );
    assert.equal(buckets[4].name, 'x y');
    const metrics = M.groupMetrics(groups);
    assert.deepEqual(metrics.map(m => [m.id, m.percent]), [
      ['lowest', 100],
      ['group:gemini', 100],
      ['gemini-5h', 100],
      ['gemini-weekly', 0],
    ]);
    for (const empty of [null, {}, { response: null }, { response: { groups: 'x' } }, { response: { groups: [] } }]) {
      assert.deepEqual(M.groupMetrics(M.parseQuotaSummary(empty, T0)), []);
    }
  });

  test('a passed reset counts as reset until the server answers again', () => {
    const answer = summary({ gemini5h: 0.1 });
    answer.response.groups[0].buckets[1].resetTime = at(-1);
    const groups = M.parseQuotaSummary(answer, T0);
    assert.equal(M.anyStale(groups), true);
    const metric = M.groupMetrics(groups).find(m => m.id === 'gemini-5h');
    assert.deepEqual([metric.percent, metric.resetsAt], [0, null]);
  });

  test('Chinese chips name the window in Chinese', () => {
    assert.equal(M.localizeLabel('Gemini 5h', 'zh'), 'Gemini 5 小时');
    assert.equal(M.localizeLabel('Claude Weekly', 'zh'), 'Claude 每周');
    assert.equal(M.localizeLabel('Imagen Daily', 'zh'), 'Imagen 每日');
    assert.equal(M.localizeLabel('Gemini 3 Pro', 'zh'), 'Gemini 3 Pro');
    assert.equal(M.localizeLabel('Gemini 5h', 'en'), 'Gemini 5h');
  });

  test('per-model quota from GetUserStatus: one per model, used-up models included', () => {
    const metrics = M.modelMetrics(
      userStatus({
        models: [
          { label: 'Gemini 9 Pro (High)', quotaInfo: { remainingFraction: 0.4, resetTime: at(90) } },
          { label: 'Gemini 9 Pro (Low)', quotaInfo: { remainingFraction: 0.6, resetTime: at(90) } },
          // proto3 leaves a zero fraction out
          { label: 'Claude FAKE Opus', quotaInfo: { resetTime: at(30) } },
          { label: 'Gemini 9 Flash', quotaInfo: { remainingFraction: 1, resetTime: at(300) } },
          { label: 'Disabled model', disabled: true, quotaInfo: { remainingFraction: 0.1 } },
          { label: 'No quota model' },
          { label: '', quotaInfo: { remainingFraction: 0.2 } },
          { label: 'Stale model', quotaInfo: { remainingFraction: 0.2, resetTime: at(-5) } },
        ],
      }),
      T0
    );
    assert.deepEqual(
      metrics.map(m => [m.id, m.label, m.percent, m.resetsAt]),
      [
        ['lowest', 'Claude FAKE Opus', 100, at(30)],
        ['model:Gemini 9 Pro', 'Gemini 9 Pro', 60, at(90)],
        ['model:Claude FAKE Opus', 'Claude FAKE Opus', 100, at(30)],
        ['model:Gemini 9 Flash', 'Gemini 9 Flash', 0, null],
        ['model:Stale model', 'Stale model', 0, null],
      ]
    );
    assert.deepEqual(M.modelMetrics({}, T0), []);
    assert.deepEqual(M.modelMetrics(null, T0), []);
  });

  test('GetUserStatus is reduced to sign-in state, plan and models, never identity', () => {
    const info = U.statusInfo(userStatus(), T0);
    assert.deepEqual(info, { signedIn: true, tier: 'FAKE Tier', models: [] });
    assert.ok(!JSON.stringify(info).includes(EMAIL));
    assert.ok(!JSON.stringify(info).includes('FAKE Person'));
    assert.deepEqual(U.statusInfo(userStatus({ signedIn: false }), T0), {
      signedIn: false,
      tier: null,
      models: [],
    });
    const planOnly = U.statusInfo({ userStatus: { email: EMAIL, planStatus: { planInfo: { planName: 'FAKE Plan' } } } }, T0);
    assert.equal(planOnly.tier, 'FAKE Plan');
    assert.equal(U.statusInfo(null, T0).signedIn, false);
  });
});

// --- the source -----------------------------------------------------------------

describe('Antigravity usage source', () => {
  test('reads the app first, over its plain-HTTP port, with a forced first refresh', async () => {
    const machine = fakeMachine([
      appServer({ RetrieveUserQuotaSummary: ok(summary()) }),
      ideServer({ RetrieveUserQuotaSummary: ok(summary({ gemini5h: 0 })) }),
    ]);
    const { src } = source(machine);
    const metrics = await src.fetch(CONFIG);
    assert.equal(metrics[0].id, 'lowest');
    assert.equal(metrics[0].percent, 60);
    assert.equal(src.lastServer(), 'app');
    assert.equal(src.defaultMetric, 'lowest');
    assert.equal(src.minFetchGapMs, 30_000);
    assert.deepEqual(machine.calls.post.map(c => [c.port, c.method]), [[41002, 'RetrieveUserQuotaSummary']]);
    assert.deepEqual(machine.calls.post[0].body, { request: {}, forceRefresh: true });
    assert.equal(machine.calls.ps, 1);
    assert.deepEqual(machine.calls.lsof, [4100]);
    // the token is never on a command line
    for (const args of machine.calls.runArgs) {
      assert.ok(!args.join(' ').includes(TOKEN_APP));
    }
  });

  test('one round per 30 s; refreshes forced every 15 minutes, else cached', async () => {
    const machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(summary()) })]);
    const { src, clock } = source(machine);
    await src.fetch(CONFIG);
    clock.now += 10_000;
    await src.fetch(CONFIG);
    assert.equal(machine.calls.post.length, 1);
    // two callers at once share one round
    clock.now += 31_000;
    await Promise.all([src.fetch(CONFIG), src.fetch(CONFIG)]);
    assert.equal(machine.calls.post.length, 2);
    assert.deepEqual(machine.calls.post[1].body, { request: {} });
    clock.now += 15 * MIN;
    await src.fetch(CONFIG);
    assert.deepEqual(machine.calls.post[2].body, { request: {}, forceRefresh: true });
  });

  test('the HTTPS port is skipped and the working port is remembered', async () => {
    const server = appServer({ RetrieveUserQuotaSummary: ok(summary()) });
    // the higher port is the TLS one this time
    server.ports = { 41003: () => TLS_ANSWER, 41002: routes({ RetrieveUserQuotaSummary: ok(summary()) }) };
    const machine = fakeMachine([server]);
    const { src, clock } = source(machine);
    await src.fetch(CONFIG);
    assert.deepEqual(machine.calls.post.map(c => c.port), [41003, 41002]);
    clock.now += 31_000;
    await src.fetch(CONFIG);
    assert.deepEqual(machine.calls.post.map(c => c.port), [41003, 41002, 41002]);
  });

  test('the IDE answers when the app does not', async () => {
    const app = appServer({});
    app.ports = { 41002: () => { throw refused(); } };
    const machine = fakeMachine([app, ideServer({ RetrieveUserQuotaSummary: ok(summary()) })]);
    const { src } = source(machine);
    const metrics = await src.fetch(CONFIG);
    assert.equal(metrics.length, 7);
    assert.equal(src.lastServer(), 'ide');
  });

  test('a signed-out app is passed over for a signed-in IDE', async () => {
    const machine = fakeMachine([
      appServer({ RetrieveUserQuotaSummary: connectError(401, 'unauthenticated') }),
      ideServer({ RetrieveUserQuotaSummary: ok(summary()) }),
    ]);
    const { src } = source(machine);
    await src.fetch(CONFIG);
    assert.equal(src.lastServer(), 'ide');
  });

  test('no server: not installed, CLI only, or not running', async () => {
    const machine = fakeMachine([]);
    // nothing at all
    let { src } = source(machine);
    await assert.rejects(src.fetch(CONFIG), { code: 'not-installed', problem: 'not-installed' });

    // only agy's data folder, or agy on PATH
    const root = tmpDir('root');
    fs.mkdirSync(path.join(root, 'antigravity-cli'));
    ({ src } = source(machine));
    await assert.rejects(src.fetch({ ...CONFIG, antigravityDir: root }), { problem: 'cli-only', code: 'unsupported' });
    const bin = tmpDir('bin');
    fs.writeFileSync(path.join(bin, 'agy'), '');
    ({ src } = source(machine, { env: { PATH: bin } }));
    await assert.rejects(src.fetch({ antigravityDir: CONFIG.antigravityDir }), { problem: 'cli-only' });
    // the agy setting is used alone: a wrong one hides agy on PATH
    ({ src } = source(machine, { env: { PATH: bin } }));
    await assert.rejects(src.fetch(CONFIG), { problem: 'not-installed' });
    ({ src } = source(machine));
    await assert.rejects(src.fetch({ ...CONFIG, antigravityPath: path.join(bin, 'agy') }), { problem: 'cli-only' });

    // the app's data folder, or the app bundle (macOS)
    fs.mkdirSync(path.join(root, 'antigravity'));
    ({ src } = source(machine));
    await assert.rejects(src.fetch({ ...CONFIG, antigravityDir: root }), { problem: 'not-running', code: 'not-configured' });
    const apps = tmpDir('apps');
    fs.mkdirSync(path.join(apps, 'Antigravity IDE.app'));
    ({ src } = source(machine, { appFolders: () => [apps] }));
    await assert.rejects(src.fetch(CONFIG), { problem: 'not-running' });
    // the key texts
    const error = await src.fetch({ ...CONFIG, antigravityDir: root }).catch(e => e);
    assert.deepEqual(Kit.errorKeyText(error, ANTIGRAVITY_BRAND, 'en'), { title: 'Not running', message: 'Open Antigravity' });
    assert.deepEqual(Kit.errorKeyText(error, ANTIGRAVITY_BRAND, 'zh'), { title: '未运行', message: '请打开 Antigravity' });
  });

  test('signed out: a refusing server, or no groups and no account', async () => {
    let machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: connectError(401, 'unauthenticated') })]);
    let { src } = source(machine);
    await assert.rejects(src.fetch(CONFIG), { problem: 'signed-out', code: 'no-credentials' });

    machine = fakeMachine([
      appServer({
        RetrieveUserQuotaSummary: ok({ response: {} }),
        GetUserStatus: ok(userStatus({ signedIn: false })),
      }),
    ]);
    ({ src } = source(machine));
    await assert.rejects(src.fetch(CONFIG), { problem: 'signed-out' });
    const status = machine.calls.post.find(c => c.method === 'GetUserStatus');
    assert.deepEqual(status.body, { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });

    machine = fakeMachine([
      appServer({
        RetrieveUserQuotaSummary: ok({ response: { groups: [] } }),
        GetUserStatus: connectError(401, 'unauthenticated'),
      }),
    ]);
    ({ src } = source(machine));
    await assert.rejects(src.fetch(CONFIG), { problem: 'signed-out' });
  });

  test('no groups but per-model quota: model metrics; neither: no quota', async () => {
    const models = [{ label: 'Gemini 9 Pro (High)', quotaInfo: { remainingFraction: 0.25, resetTime: at(40) } }];
    let machine = fakeMachine([
      appServer({
        RetrieveUserQuotaSummary: ok({ response: { groups: [] } }),
        GetUserStatus: ok(userStatus({ models })),
      }),
    ]);
    let { src, clock } = source(machine);
    const metrics = await src.fetch(CONFIG);
    assert.deepEqual(metrics.map(m => [m.id, m.percent]), [
      ['lowest', 75],
      ['model:Gemini 9 Pro', 75],
    ]);
    // GetUserStatus (large) is asked again only after 10 minutes
    clock.now += 31_000;
    await src.fetch(CONFIG);
    assert.equal(machine.calls.post.filter(c => c.method === 'GetUserStatus').length, 1);
    clock.now += 10 * MIN;
    await src.fetch(CONFIG);
    assert.equal(machine.calls.post.filter(c => c.method === 'GetUserStatus').length, 2);

    machine = fakeMachine([
      appServer({
        RetrieveUserQuotaSummary: ok({ response: { groups: [] } }),
        GetUserStatus: ok(userStatus()),
      }),
    ]);
    ({ src } = source(machine));
    await assert.rejects(src.fetch(CONFIG), { problem: 'no-quota' });
  });

  test('a server without the quota method: per-model quota, else "update"', async () => {
    const models = [{ label: 'Gemini 9 Flash', quotaInfo: { remainingFraction: 0.5, resetTime: at(40) } }];
    let machine = fakeMachine([appServer({ GetUserStatus: ok(userStatus({ models })) })]);
    let { src } = source(machine);
    assert.equal((await src.fetch(CONFIG))[1].id, 'model:Gemini 9 Flash');

    machine = fakeMachine([appServer({ GetUserStatus: ok(userStatus()) })]);
    ({ src } = source(machine));
    await assert.rejects(src.fetch(CONFIG), { problem: 'old-version' });
  });

  test('server errors: rate limit, Google unreachable, HTTP, not JSON', async () => {
    const cases = [
      [connectError(429, 'resource_exhausted'), { code: 'rate-limited' }],
      [connectError(503, 'unavailable'), { code: 'network' }],
      [connectError(500, 'internal', 'FAKE detail'), { code: 'http', message: /HTTP 500 \(internal\)/ }],
      [{ status: 502, contentType: 'text/html', text: '<html>' }, { code: 'http', message: /HTTP 502/ }],
      [{ status: 200, contentType: 'text/plain', text: 'garbage' }, { code: 'parse' }],
    ];
    for (const [reply, expected] of cases) {
      const machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: () => reply })]);
      const { src } = source(machine);
      const error = await src.fetch(CONFIG).catch(e => e);
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      for (const [k, v] of Object.entries(expected)) {
        if (v instanceof RegExp) assert.match(error[k], v);
        else assert.equal(error[k], v);
      }
      assert.ok(!src.logText(error).includes('FAKE detail'));
    }
    // the rate limit locks the key out for 5 minutes
    const limited = new Kit.ProviderError('rate-limited', 'x', { retryAfterSeconds: 300 });
    assert.equal(Kit.lockoutSeconds(limited), 300);
  });

  test('a forced refresh Google does not answer falls back to the cached numbers', async () => {
    const machine = fakeMachine([
      appServer({
        RetrieveUserQuotaSummary: request =>
          request.body.forceRefresh ? connectError(503, 'unavailable') : ok(summary()),
      }),
    ]);
    const { src } = source(machine);
    const metrics = await src.fetch(CONFIG);
    assert.equal(metrics[0].percent, 60);
    assert.deepEqual(machine.calls.post.map(c => !!c.body.forceRefresh), [true, false]);
  });

  test('a passed reset asks for a refresh, once', async () => {
    const stale = summary({ gemini5h: 0.1 });
    stale.response.groups[0].buckets[1].resetTime = at(-1);
    const machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(stale) })]);
    const { src, clock } = source(machine);
    await src.fetch(CONFIG); // forced (first)
    clock.now += 31_000;
    await src.fetch(CONFIG); // not forced: the forced answer was stale already
    clock.now += 2 * MIN;
    assert.deepEqual(machine.calls.post.map(c => !!c.body.forceRefresh), [true, false]);
    // an unforced stale answer: the next round (a minute on) forces
    await src.fetch(CONFIG);
    assert.deepEqual(machine.calls.post.map(c => !!c.body.forceRefresh), [true, false, true]);
  });

  test('a restarted server is found again (new pid, new token)', async () => {
    const machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(summary()) })]);
    const { src, clock } = source(machine);
    await src.fetch(CONFIG);
    machine.state.servers = [
      {
        pid: 4300,
        product: 'app',
        token: token(5),
        ports: { 41020: () => TLS_ANSWER, 41021: routes({ RetrieveUserQuotaSummary: ok(summary({ gemini5h: 0.2 })) }) },
      },
    ];
    clock.now += 31_000;
    const metrics = await src.fetch(CONFIG);
    assert.equal(metrics[0].percent, 80);
    assert.equal(machine.calls.ps, 2);
    assert.deepEqual(machine.calls.lsof, [4100, 4300]);
  });

  test('a refused token or a silent server within the lookup window: one more lookup', async () => {
    // the server got a new token; the source still has the old one
    const machine = fakeMachine(
      [
        appServer({
          RetrieveUserQuotaSummary: ok(summary()),
          GetUserStatus: request =>
            request.token === token(6)
              ? ok(userStatus())
              : connectError(403, 'permission_denied', 'invalid CSRF token'),
        }),
      ],
      { checkToken: false }
    );
    const { src, clock } = source(machine);
    await src.fetch(CONFIG);
    machine.state.servers[0].token = token(6);
    clock.now += 10_000;
    // the settings page: quota from the last round, the plan with a new lookup
    const reply = await src.describe(CONFIG);
    assert.equal(reply.tier, 'FAKE Tier');
    assert.equal(machine.calls.ps, 2);
    assert.deepEqual(
      machine.calls.post.filter(c => c.method === 'GetUserStatus').map(c => c.token === token(6)),
      [false, true]
    );

    // a server that stops answering: looked up once more, then given up
    const silent = fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(summary()) })]);
    const s2 = source(silent);
    await s2.src.fetch(CONFIG);
    silent.state.servers[0].ports = { 41002: () => { throw refused(); } };
    s2.clock.now += 10_000;
    const quiet = await s2.src.describe(CONFIG);
    assert.equal(quiet.success, true);
    assert.equal(quiet.tier, null);
    assert.equal(silent.calls.ps, 2);

    // a server that refuses every token, freshly found: "no answer"
    const refusing = fakeMachine([
      appServer({ RetrieveUserQuotaSummary: connectError(403, 'permission_denied', 'missing CSRF token') }),
    ]);
    const fresh = source(refusing).src;
    await assert.rejects(fresh.fetch(CONFIG), { problem: 'unreachable', code: 'network', message: /CSRF token refused/ });
    assert.equal(refusing.calls.ps, 1);
  });

  test('nothing answers: one more process lookup, then "no answer"; the meter stays 30 minutes', async () => {
    const machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(summary()) })]);
    const { src, clock } = source(machine);
    await src.fetch(CONFIG);
    machine.state.servers[0].ports = {
      41001: () => {
        throw refused();
      },
      41002: () => {
        throw refused();
      },
    };
    clock.now += 31_000;
    const psBefore = machine.calls.ps;
    const error = await src.fetch(CONFIG).catch(e => e);
    assert.equal(error.problem, 'unreachable');
    assert.match(error.message, /ECONNREFUSED/);
    // the cached list was 31 s old: looked up again; a fresh list is not
    assert.equal(machine.calls.ps, psBefore + 1);
    assert.equal(src.keepLastOnError(error), true);
    clock.now += 31 * MIN;
    assert.equal(src.keepLastOnError(error), false);
    // not running also keeps the last meter for a while
    const notRunning = new T.AntigravityUsageError('not-running', 'x');
    const s2 = source(fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(summary()) })]));
    await s2.src.fetch(CONFIG);
    assert.equal(s2.src.keepLastOnError(notRunning), true);
    assert.equal(s2.src.keepLastOnError(new T.AntigravityUsageError('signed-out', 'x')), false);
    assert.equal(s2.src.keepLastOnError(new Error('x')), false);
  });

  test('a failing process list and Windows are reported, not thrown raw', async () => {
    const { src } = source({
      run: async () => {
        throw Object.assign(new Error('spawn /bin/ps ENOENT'), { code: 'ENOENT' });
      },
      post: async () => {
        throw new Error('no post expected');
      },
    });
    await assert.rejects(src.fetch(CONFIG), { problem: 'unreachable', message: /ps: ENOENT/ });
    let ran = false;
    const win = U.createAntigravityUsageSource({
      platform: 'win32',
      run: async () => {
        ran = true;
        return '';
      },
    });
    await assert.rejects(win.fetch(CONFIG), { problem: 'unsupported-os' });
    assert.equal(ran, false);
  });

  test('describe: groups, views, plan and server for the settings page, never identity or tokens', async () => {
    const machine = fakeMachine([
      appServer({
        RetrieveUserQuotaSummary: ok(summary()),
        GetUserStatus: ok(userStatus()),
      }),
    ]);
    const { src, clock } = source(machine);
    const reply = await src.describe(CONFIG);
    assert.equal(reply.success, true);
    assert.equal(reply.tier, 'FAKE Tier');
    assert.equal(reply.server, 'app');
    assert.equal(reply.models, false);
    assert.deepEqual(reply.views.map(v => v.id), ['gemini-dual', '3p-dual']);
    assert.deepEqual(reply.groups[0].buckets.map(b => [b.id, b.window, b.left]), [
      ['gemini-5h', '5h', 40],
      ['gemini-weekly', 'weekly', 82],
    ]);
    assert.equal(reply.groups[1].description, 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS');
    const text = JSON.stringify(reply);
    for (const secret of [EMAIL, 'FAKE Person', TOKEN_APP, 'FAKE explanatory']) {
      assert.ok(!text.includes(secret), secret);
    }
    // the plan is asked at most every 30 minutes
    clock.now += 2 * MIN;
    await src.describe(CONFIG);
    assert.equal(machine.calls.post.filter(c => c.method === 'GetUserStatus').length, 1);
    // a settings page forces a refresh (at most once a minute)
    assert.deepEqual(
      machine.calls.post.filter(c => c.method === 'RetrieveUserQuotaSummary').map(c => !!c.body.forceRefresh),
      [true, true]
    );

    const failing = source(fakeMachine([])).src;
    const bad = await failing.describe(CONFIG);
    assert.deepEqual(bad, {
      success: false,
      error: 'Antigravity was not found on this computer',
      problem: 'not-installed',
      code: 'not-installed',
    });
  });
});

// --- texts --------------------------------------------------------------------

describe('texts', () => {
  test('every problem has en and zh texts and a known code', () => {
    const codes = new Set(['not-installed', 'not-configured', 'unsupported', 'no-credentials', 'unauthorized', 'rate-limited', 'http', 'network', 'parse']);
    for (const problem of T.PROBLEMS) {
      const texts = T.problemText(problem);
      for (const lang of ['en', 'zh']) {
        assert.ok(texts[lang].title && texts[lang].message, `${problem} ${lang}`);
      }
      const error = new T.AntigravityUsageError(problem, 'x');
      assert.ok(codes.has(error.code), problem);
      assert.deepEqual(Kit.errorKeyText(error, ANTIGRAVITY_BRAND, 'zh'), texts.zh);
    }
  });

  test('log text masks CSRF tokens', () => {
    const text = T.antigravityErrorText(
      new Error(`failed: language_server --csrf_token ${TOKEN_APP} --host_bridge_token=${TOKEN_OTHER} x-codeium-csrf-token: ${TOKEN_IDE}`)
    );
    for (const secret of [TOKEN_APP, TOKEN_OTHER, TOKEN_IDE]) assert.ok(!text.includes(secret), text);
    assert.match(text, /\[redacted\]/);
    assert.ok(T.antigravityErrorText(new Error('y'.repeat(500))).length <= 241);
  });
});

// --- key faces ------------------------------------------------------------------

describe('Antigravity usage key', () => {
  test('exports usageSource', () => {
    assert.equal(typeof U.usageSource.fetch, 'function');
    assert.equal(U.usageSource.defaultMetric, 'lowest');
  });

  test('without a process list (stubbed in tests), fetch rejects with a ProviderError', async () => {
    await assert.rejects(U.usageSource.fetch(CONFIG), error => {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      return true;
    });
  });

  /** A UsageKeys group over a source, collecting the drawn images. */
  function keysWith(src) {
    const cid = Kit.keyCid('antigravity', 'usage');
    const sent = new Map();
    let chain = Promise.resolve();
    const keys = new UsageKeys({
      enqueue: task => (chain = chain.then(task).catch(() => undefined)),
      send: async (_serial, key, image) => sent.set(key.uid, image),
      isOffline: () => false,
      keyWidth: key => key.width,
      bgColor: () => undefined,
      loadConfig: async () => CONFIG,
      pollIntervalMs: () => 3_600_000,
      provider: { cid, brand: ANTIGRAVITY_BRAND, source: src },
    });
    return {
      cid,
      keys,
      sent,
      settle: async () => {
        for (let i = 0; i < 5; i++) {
          await chain;
          await sleep(5);
        }
      },
    };
  }

  test('meters, dual faces and the missing-dual text are drawn at every width', async () => {
    const machine = fakeMachine([appServer({ RetrieveUserQuotaSummary: ok(summary()) })]);
    const { src } = source(machine);
    const { cid, keys, sent, settle } = keysWith(src);
    const key = (uid, width, data) => ({ uid, cid, width, data });
    try {
      await keys.alive('FAKE-DEVICE-1', [
        key(1, 120, { metric: '' }),
        key(2, 60, { metric: 'gemini-weekly', lang: 'zh' }),
        key(3, 240, { metric: 'gemini-dual' }),
        key(4, 120, { metric: '3p-dual', showMark: false }),
        key(5, 460, { metric: 'imagen-dual' }),
        key(6, 360, { metric: 'gemini-dual', showMark: false, lang: 'zh' }),
      ]);
      await settle();
      for (const [uid, width] of [[1, 120], [2, 60], [3, 240], [4, 120], [5, 460], [6, 360]]) {
        assert.ok(sent.has(uid), `key ${uid}`);
        assert.deepEqual(pngSize(sent.get(uid)), [width, 60]);
      }
    } finally {
      keys.stop();
    }
    // the dual face itself, and its "no data" text
    const face = await src.face({
      metric: 'gemini-dual',
      metrics: await src.fetch(CONFIG),
      width: 240,
      showResetTime: true,
      lang: 'en',
      data: {},
    });
    assert.ok(face.image.startsWith('data:image/png;base64,'));
    assert.deepEqual(
      await src.face({ metric: 'imagen-dual', metrics: [], width: 240, showResetTime: true, lang: 'zh', data: {} }),
      { text: F.dualMissingText('zh') }
    );
    assert.equal(await src.face({ metric: 'gemini-5h', metrics: [], width: 240, showResetTime: true, lang: 'en', data: {} }), null);
    assert.equal(src.metricLabel({ id: 'gemini-5h', label: 'Gemini 5h', percent: 1, resetsAt: null }, 'zh'), 'Gemini 5 小时');
  });

  test('error faces are drawn without network', async () => {
    const { src } = source(fakeMachine([]));
    const { cid, keys, sent, settle } = keysWith(src);
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
});
