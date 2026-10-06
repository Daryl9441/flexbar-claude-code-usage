// Tests for the Antigravity session source and New Session launcher
// (src/providers/antigravity/session*.ts, newSession.ts), run against the
// tsc output of `npm run test:antigravity-session`
// (.test-build-antigravity-session/).
// Rules: synthetic fixtures only (see CLAUDE.md), never read the real home
// folder (HOME points at an empty temp folder), never open a link, a
// terminal or an app, never reach a real Antigravity language server or
// list real processes: the process probe, the loopback RPC, the summary
// database reader and every launcher below are fakes, and fetch,
// http/https, net and child_process fail loudly. Token-shaped strings are
// built at runtime.
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
import { inspect } from 'node:util';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-session-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};
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
  process.env.ANTIGRAVITY_SESSION_TEST_BUILD ??
  path.join(here, '..', '.test-build-antigravity-session');
const req = p => require(path.join(build, p));
const S = req('providers/antigravity/session.js');
const NS = req('providers/antigravity/newSession.js');
const Mon = req('providers/antigravity/sessionMonitor.js');
const Sum = req('providers/antigravity/sessionSummary.js');
const Proto = req('providers/antigravity/sessionProto.js');
const Procs = req('providers/antigravity/sessionProcs.js');
const Rpc = req('providers/antigravity/sessionRpc.js');
const Db = req('providers/antigravity/sessionDb.js');
const Cli = req('providers/antigravity/sessionCli.js');
const Kit = req('providers/kit.js');
const { SessionKeys } = req('sessionKey.js');
const { NewSessionKeys } = req('newSessionKey.js');
const { ANTIGRAVITY_BRAND } = req('providers/antigravity/brand.js');

const SERIAL = 'FAKE-DEVICE-1';
const MIN = 60_000;
const FIXED = Date.parse('2026-10-05T12:00:00.000Z');
const IDLE_MS = 15 * MIN;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = msAgo => new Date(FIXED - msAgo).toISOString();
// token-shaped strings, built at runtime
const TOKEN = ['fake', 'csrf', 'token', 'one'].join('-');
const TOKEN2 = ['fake', 'csrf', 'token', 'two'].join('-');
const EXT_TOKEN = ['fake', 'extension', 'token'].join('-');

function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(empty, 'root-'));
  for (const dir of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    fs.mkdirSync(path.join(root, dir, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(root, dir, 'brain'), { recursive: true });
  }
  return root;
}

/** A CascadeTrajectorySummary in its JSON shape (synthetic values). */
function summary(fields = {}) {
  return {
    summary: 'FAKE conversation summary',
    stepCount: 12,
    lastModifiedTime: iso(2 * MIN),
    lastUserInputTime: iso(6 * MIN),
    lastUserInputStepIndex: 3,
    status: 'CASCADE_RUN_STATUS_IDLE',
    workspaces: [
      { workspaceFolderAbsoluteUri: 'file:///Users/you/demo-app', branchName: 'main' },
    ],
    annotations: { title: 'FAKE Dark mode toggle' },
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    ...fields,
  };
}

const waitingStep = interaction => [
  {
    stepIndex: 41,
    step: {
      status: 'CORTEX_STEP_STATUS_WAITING',
      requestedInteraction: interaction,
      runCommand: { commandLine: 'npm test' },
    },
  },
];

// --- protobuf fixtures (a tiny encoder) ------------------------------------------

const varint = n => {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const tag = (f, w) => varint(f * 8 + w);
const pbStr = (f, s) => {
  const b = [...Buffer.from(s, 'utf8')];
  return [...tag(f, 2), ...varint(b.length), ...b];
};
const pbMsg = (f, bytes) => [...tag(f, 2), ...varint(bytes.length), ...bytes];
const pbU = (f, n) => [...tag(f, 0), ...varint(n)];
const pbTs = (f, ms) =>
  pbMsg(f, [...pbU(1, Math.floor(ms / 1000)), ...pbU(2, (ms % 1000) * 1e6)]);

/** A serialized summary: running, waiting for a command approval. */
function encodedSummary() {
  return Uint8Array.from([
    ...pbStr(1, 'FAKE encoded summary'),
    ...pbU(2, 9),
    ...pbTs(3, FIXED - MIN),
    ...pbU(5, 2), // RUNNING
    ...pbMsg(8, [
      ...pbMsg(1, [
        ...pbU(4, 9),
        ...pbMsg(56, pbMsg(3, [])), // requestedInteraction.runCommand
        ...pbMsg(28, pbStr(23, 'npm run lint')),
      ]),
      ...pbU(2, 8),
    ]),
    ...pbMsg(9, [...pbStr(1, 'file:///Users/you/cli-app'), ...pbStr(4, 'dev')]),
    ...pbTs(10, FIXED - 4 * MIN),
    ...pbMsg(15, pbStr(1, 'FAKE encoded title')),
    ...pbU(16, 2),
    ...pbU(21, 1), // notFullyIdle
    ...pbU(22, 4), // CASCADE
    // an unknown field and a known one with a foreign wire type: skipped
    ...pbStr(99, 'ignored'),
    ...pbStr(18, 'wrong wire type'),
  ]);
}

// --- fakes ---------------------------------------------------------------------------

/** A probe returning fixed servers and CLIs. */
function fakeProbe(snapshot) {
  const probe = {
    calls: 0,
    forgotten: [],
    snapshot: async () => {
      probe.calls++;
      return typeof snapshot === 'function' ? snapshot() : snapshot;
    },
    forgetPorts: pid => probe.forgotten.push(pid),
  };
  return probe;
}

const server = (pid, product, ports = [50111, 50110], token = TOKEN) => ({
  pid,
  startedAt: FIXED - 60 * MIN,
  product,
  token: new Procs.CsrfToken(token),
  ports,
});

/** A loopback transport answering per port. */
function fakePost(answer) {
  const post = async (port, p, headers, body) => {
    post.calls.push({ port, path: p, headers, body });
    return answer(port, p, headers, body);
  };
  post.calls = [];
  return post;
}

const ok = map => ({ status: 200, body: JSON.stringify({ trajectorySummaries: map }) });

function makeSource({
  root = tempRoot(),
  probe = fakeProbe({ servers: [], clis: [] }),
  post = fakePost(() => ok({})),
  rows = {},
  installed = ['app', 'ide', 'cli'],
  clock = { now: FIXED },
  logger = null,
} = {}) {
  let changes = 0;
  const provider = S.createAntigravitySessionProvider({
    probe: () => probe,
    post,
    readDb: () => async file => {
      const product = Object.entries({
        app: `${path.sep}antigravity${path.sep}`,
        ide: `${path.sep}antigravity-ide${path.sep}`,
        cli: `${path.sep}antigravity-cli${path.sep}`,
      }).find(([, dir]) => file.includes(dir))?.[0];
      const value = rows[product];
      return typeof value === 'function' ? value() : (value ?? null);
    },
    installed: () => new Set(installed),
    now: () => clock.now,
    platform: 'darwin',
  });
  const source = provider.create({
    location: root,
    config: { antigravityDir: root },
    onChange: () => changes++,
    logger,
  });
  return { provider, source, root, probe, post, clock, changes: () => changes };
}

const statusOf = (source, data = {}, filter = '') =>
  source.getStatus(filter, FIXED, IDLE_MS, data).status;

function drawHooks(config = {}) {
  const sent = [];
  let chain = Promise.resolve();
  return {
    sent,
    settle: async () => {
      for (let i = 0; i < 3; i++) {
        await chain;
        await sleep(5);
      }
    },
    deps: {
      enqueue: task => (chain = chain.then(task).catch(() => undefined)),
      send: async (_serial, key, image) => sent.push([key.uid, image]),
      isOffline: () => false,
      keyWidth: key => key.width,
      bgColor: () => undefined,
      loadConfig: async () => config,
    },
  };
}

// --- tests -----------------------------------------------------------------------------

describe('process probe (ps + lsof)', () => {
  const PS = [
    `  101  4242     01:00:00 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --subclient_type hub --csrf_token ${TOKEN} --app_data_dir antigravity --https_server_port 0`,
    `  102  4242  1-02:03:04 /Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --extension_server_csrf_token ${EXT_TOKEN} --csrf_token=${TOKEN2} --extension_server_port 50001 --app_data_dir antigravity-ide --subclient_type ide --lsp_port 50002`,
    `  103  9999     01:00 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token ${TOKEN} --app_data_dir antigravity`,
    `  104  4242     01:00 /opt/other/language_server --csrf_token ${TOKEN} --app_data_dir something-else`,
    '  201  4242     05:00 /Users/you/.local/bin/agy',
    '  202  4242     05:00 /Users/you/.local/bin/agy models',
    '  203  4242     05:00 /Users/you/.local/bin/agy --bg-updater',
    '  204  4242     00:30 agy -p FAKE prompt text',
    '  205  4242     00:30 /usr/bin/vim agy',
  ].join('\n');

  function fakeRun() {
    const calls = [];
    const run = async (file, args) => {
      calls.push([file, args]);
      if (file === '/bin/ps') return { stdout: PS, ok: true };
      if (args.includes('cwd')) {
        return { stdout: 'p201\nfcwd\nn/Users/you/demo-app\np204\nfcwd\nn/Users/you/other app\n', ok: true };
      }
      const pid = args[args.indexOf('-p') + 1];
      if (pid === '101') {
        return { stdout: 'p101\nf10\nn127.0.0.1:50110\nf11\nn127.0.0.1:50111\nf12\nn*:50999\nn[::1]:50112\n', ok: true };
      }
      if (pid === '102') {
        return { stdout: 'p102\nn127.0.0.1:50120\nn127.0.0.1:50121\nn127.0.0.1:50002\nn127.0.0.1:50001\n', ok: false };
      }
      return { stdout: '', ok: false };
    };
    return { run, calls };
  }

  test('finds the app and IDE language servers of this user with their tokens and ports', async () => {
    const { run, calls } = fakeRun();
    const probe = Procs.createProcessProbe({ platform: 'darwin', run, uid: 4242, now: () => FIXED });
    const snap = await probe.snapshot();
    assert.deepEqual(
      snap.servers.map(s => [s.pid, s.product, s.ports]),
      [
        [101, 'app', [50111, 50110]],
        [102, 'ide', [50121, 50120]],
      ]
    );
    assert.equal(snap.servers[0].token.reveal(), TOKEN);
    // --csrf_token, never --extension_server_csrf_token
    assert.equal(snap.servers[1].token.reveal(), TOKEN2);
    assert.equal(snap.servers[1].startedAt, FIXED - (86_400 + 2 * 3600 + 3 * 60 + 4) * 1000);
    assert.deepEqual(
      snap.clis.map(c => [c.pid, c.cwd]),
      [
        [201, '/Users/you/demo-app'],
        [204, '/Users/you/other app'],
      ]
    );
    // every program runs without a shell, with an argument list
    for (const [file, args] of calls) {
      assert.ok(file.startsWith('/'), file);
      assert.ok(Array.isArray(args));
      assert.ok(!args.join(' ').includes(TOKEN), 'no token on a command line');
    }
  });

  test('ports and folders are looked up once per process, again after forgetPorts', async () => {
    const { run, calls } = fakeRun();
    const probe = Procs.createProcessProbe({ platform: 'darwin', run, uid: 4242, now: () => FIXED });
    await probe.snapshot();
    const first = calls.length;
    await probe.snapshot();
    assert.equal(calls.length - first, 1, 'only ps the second time');
    probe.forgetPorts(101);
    const before = calls.length;
    await probe.snapshot();
    assert.deepEqual(
      calls.slice(before).map(([file, args]) => (file === '/bin/ps' ? 'ps' : args[args.indexOf('-p') + 1])),
      ['ps', '101']
    );
  });

  test('no probe on Windows; an unusable ps gives no snapshot', async () => {
    assert.equal(Procs.createProcessProbe({ platform: 'win32' }), null);
    const probe = Procs.createProcessProbe({
      platform: 'darwin',
      run: async () => ({ stdout: '', ok: false }),
      uid: 4242,
    });
    assert.equal(await probe.snapshot(), null);
  });

  test('command-line parsing', () => {
    assert.equal(Procs.flagValue('--a_csrf_token x --csrf_token y', 'csrf_token'), 'y');
    assert.equal(Procs.flagValue('--csrf_token=z', 'csrf_token'), 'z');
    assert.equal(Procs.inspectServer('/x/language_server --app_data_dir antigravity'), null, 'no token');
    assert.equal(
      Procs.inspectServer(`/x/language_server --csrf_token ${TOKEN} --app_data_dir antigravity-cli`),
      null,
      'not the app or the IDE'
    );
    assert.equal(
      Procs.inspectServer(`/x/language_server_helper --csrf_token ${TOKEN} --app_data_dir antigravity`),
      null
    );
    assert.equal(Procs.isAgySession('/Users/you/.local/bin/agy --mode plan'), true);
    assert.equal(Procs.isAgySession('agy update'), false);
    assert.equal(Procs.isAgySession('agy --help'), false);
    assert.equal(Procs.isAgySession('/usr/bin/agyx'), false);
    assert.deepEqual(Procs.loopbackPorts(['127.0.0.1:1', 'localhost:3', '*:4', '10.0.0.1:5'], [3]), [1]);
    assert.equal(Procs.parseEtime('2-03:04:05'), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  });

  test('a CSRF token never prints', () => {
    const token = new Procs.CsrfToken(TOKEN);
    const holder = { token, ports: [1] };
    for (const text of [String(token), `${token}`, JSON.stringify(holder), inspect(holder, { depth: 5 })]) {
      assert.ok(!text.includes(TOKEN), text);
    }
    assert.equal(token.reveal(), TOKEN);
    assert.ok(token.same(new Procs.CsrfToken(TOKEN)));
  });
});

describe('loopback RPC', () => {
  test('tries the remembered port, then the others from the highest down; TLS ports are skipped', async () => {
    const post = fakePost(port =>
      port === 50111
        ? { status: 400, body: 'Client sent an HTTP request to an HTTPS server.\n' }
        : port === 50110
          ? ok({ [ID(1)]: summary() })
          : { error: 'refused' }
    );
    const s = server(101, 'app', [50112, 50111, 50110]);
    const outcome = await Rpc.fetchTrajectories(s, post, null);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.port, 50110);
    assert.deepEqual(Object.keys(outcome.summaries), [ID(1)]);
    assert.deepEqual(post.calls.map(c => c.port), [50112, 50111, 50110]);
    for (const call of post.calls) {
      assert.equal(call.path, '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories');
      assert.equal(call.headers['x-codeium-csrf-token'], TOKEN);
      assert.equal(call.headers['connect-protocol-version'], '1');
      assert.deepEqual(JSON.parse(call.body), { excludeSubtrajectories: true });
    }
    post.calls.length = 0;
    await Rpc.fetchTrajectories(s, post, 50110);
    assert.deepEqual(post.calls.map(c => c.port), [50110]);
    // a port the server does not list is never used
    post.calls.length = 0;
    await Rpc.fetchTrajectories(s, post, 4242);
    assert.ok(!post.calls.some(c => c.port === 4242));
  });

  test('an empty answer has no summaries; rejections and failures name the code only', async () => {
    const s = server(101, 'app', [50111]);
    assert.deepEqual(
      (await Rpc.fetchTrajectories(s, fakePost(() => ({ status: 200, body: '{}' })))).summaries,
      {}
    );
    const rejected = await Rpc.fetchTrajectories(
      s,
      fakePost(() => ({ status: 401, body: JSON.stringify({ code: 'unauthenticated', message: `bad ${TOKEN}` }) }))
    );
    assert.deepEqual(rejected, { ok: false, reason: 'rejected', detail: 'unauthenticated' });
    const refused = await Rpc.fetchTrajectories(s, fakePost(() => ({ error: 'refused' })));
    assert.equal(refused.reason, 'unreachable');
    const garbage = await Rpc.fetchTrajectories(s, fakePost(() => ({ status: 200, body: '<html>' })));
    assert.equal(garbage.ok, false);
    const unavailable = await Rpc.fetchTrajectories(
      s,
      fakePost(() => ({ status: 503, body: JSON.stringify({ code: 'unavailable', message: 'x' }) }))
    );
    assert.deepEqual(unavailable, { ok: false, reason: 'error', detail: 'unavailable' });
    const none = await Rpc.fetchTrajectories(server(1, 'app', []), fakePost(() => ok({})));
    assert.equal(none.reason, 'unreachable');
  });

  test('the default transport posts to 127.0.0.1 only, with a timeout and no agent', async () => {
    const seen = [];
    const request = (options, onResponse) => {
      seen.push(options);
      const handlers = {};
      const req = {
        on: (event, fn) => ((handlers[event] = fn), req),
        destroy: () => undefined,
        end: payload => {
          seen.push(String(payload));
          const resHandlers = {};
          const res = {
            statusCode: 200,
            on: (event, fn) => ((resHandlers[event] = fn), res),
            destroy: () => undefined,
          };
          onResponse(res);
          resHandlers.data(Buffer.from('{"trajectorySummaries":{}}'));
          resHandlers.end();
        },
      };
      return req;
    };
    const post = Rpc.createPost(request);
    const result = await post(50111, '/x', { 'x-codeium-csrf-token': TOKEN }, '{}');
    assert.deepEqual(result, { status: 200, body: '{"trajectorySummaries":{}}' });
    assert.equal(seen[0].host, '127.0.0.1');
    assert.equal(seen[0].port, 50111);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].agent, false);
    assert.ok(seen[0].timeout > 0 && seen[0].timeout <= 10_000);
    assert.equal(seen[0].headers['x-codeium-csrf-token'], TOKEN);
    assert.equal(seen[1], '{}');

    const failing = Rpc.createPost(() => {
      const req = {
        on: (event, fn) => {
          if (event === 'error') setImmediate(() => fn(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })));
          return req;
        },
        destroy: () => undefined,
        end: () => undefined,
      };
      return req;
    });
    assert.deepEqual(await failing(1, '/x', {}, '{}'), { error: 'refused' });
    const throwing = Rpc.createPost(() => {
      throw new Error('blocked');
    });
    assert.deepEqual(await throwing(1, '/x', {}, '{}'), { error: 'failed' });
  });
});

describe('summaries and status', () => {
  const derive = (fields, options = {}) =>
    Sum.deriveAgStatus(Sum.factsFromSummary(ID(1), summary(fields), 'app'), {
      now: FIXED,
      idleMs: IDLE_MS,
      liveness: 'live',
      lang: 'en',
      ...options,
    });

  test('facts: title, workspace, hidden conversations', () => {
    const f = Sum.factsFromSummary(ID(1), summary(), 'app');
    assert.equal(f.title, 'FAKE Dark mode toggle');
    assert.equal(f.workspace, '/Users/you/demo-app');
    assert.equal(f.branch, 'main');
    assert.equal(f.lastModified, FIXED - 2 * MIN);
    assert.equal(f.hidden, false);
    const untitled = Sum.factsFromSummary(ID(1), summary({ annotations: {}, summary: `  FAKE ${'long '.repeat(30)}` }), 'app');
    assert.ok(untitled.title.startsWith('FAKE long'));
    assert.ok(untitled.title.length <= 60);
    assert.equal(Sum.factsFromSummary(ID(1), summary({ annotations: {}, summary: '' }), 'app').title, null);
    for (const fields of [
      { trajectoryMetadata: { parentConversationId: ID(9) } },
      { trajectoryMetadata: { isBattleModeFork: true } },
      { annotations: { title: 'FAKE', archived: true } },
      { trajectoryType: 'CORTEX_TRAJECTORY_TYPE_BRAIN_UPDATE' },
      { source: 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT' },
    ]) {
      assert.equal(Sum.factsFromSummary(ID(1), summary(fields), 'app').hidden, true, JSON.stringify(fields));
    }
    const viaMeta = Sum.factsFromSummary(
      ID(1),
      summary({ workspaces: [], trajectoryMetadata: { workspaceUris: ['file:///Users/you/my%20app'] } }),
      'ide'
    );
    assert.equal(viaMeta.workspace, '/Users/you/my app');
    assert.equal(Sum.factsFromSummary(ID(1), null, 'app'), null);
  });

  test('a running conversation is working, with the task status', () => {
    const s = derive({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      notFullyIdle: true,
      latestTaskBoundaryStep: { stepIndex: 5, step: { taskBoundary: { taskName: 'FAKE Implement toggle', taskStatus: 'FAKE Running tests' } } },
    });
    assert.equal(s.state, 'working');
    assert.equal(s.detail, 'FAKE Running tests');
    assert.equal(s.since, FIXED - 6 * MIN, 'since the turn started');
    assert.equal(s.background, false);
    assert.equal(s.live, true);
  });

  test('waiting steps: questions and approvals', () => {
    const run = { status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true };
    const command = derive({ ...run, waitingSteps: waitingStep({ runCommand: {} }) });
    assert.equal(command.state, 'permission');
    assert.equal(command.confident, true);
    assert.equal(command.tool, 'Run: npm test');
    const zh = derive({ ...run, waitingSteps: waitingStep({ runCommand: {} }) }, { lang: 'zh' });
    assert.equal(zh.tool, '运行: npm test');
    assert.equal(
      derive({ ...run, waitingSteps: waitingStep({ permission: { resource: { action: 'write', target: '/x' } } }) }).tool,
      'Permission: write'
    );
    assert.equal(
      derive({ ...run, waitingSteps: waitingStep({ permission: { resource: { action: 'escalate_admin' } } }) }).tool,
      'Administrator access'
    );
    assert.equal(derive({ ...run, waitingSteps: waitingStep({ filePermission: {} }) }).tool, 'File access');
    assert.equal(derive({ ...run, waitingSteps: waitingStep({ somethingNew: {} }) }).tool, 'Input required');
    const question = derive({
      ...run,
      waitingSteps: waitingStep({
        askQuestion: { questions: [{ question: 'FAKE Ship it today?', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] }] },
      }),
    });
    assert.equal(question.state, 'question');
    assert.equal(question.question, 'FAKE Ship it today?');
    assert.deepEqual(question.options, ['Yes', 'No']);
    assert.equal(derive({ ...run, waitingSteps: waitingStep({ elicitation: { message: 'FAKE Pick one' } }) }).question, 'FAKE Pick one');
    // waiting steps of an idle (or killed) conversation do not count
    assert.equal(derive({ waitingSteps: waitingStep({ runCommand: {} }) }).state, 'done');
    assert.equal(derive({ ...run, killed: true, waitingSteps: waitingStep({ runCommand: {} }) }).state, 'interrupted');
    // the language server is gone: nothing waits any more
    assert.equal(derive({ ...run, waitingSteps: waitingStep({ runCommand: {} }) }, { liveness: 'gone' }).state, 'interrupted');
  });

  test('a blocking notify_user after the last input waits for a review', () => {
    const notify = index => ({ stepIndex: index, step: { notifyUser: { isBlocking: true } } });
    const plan = derive({
      latestNotifyUserStep: notify(9),
      latestTaskBoundaryStep: { step: { taskBoundary: { taskName: 'FAKE Plan the toggle' } } },
    });
    assert.equal(plan.state, 'plan');
    assert.equal(plan.detail, 'FAKE Plan the toggle');
    assert.equal(derive({ latestNotifyUserStep: notify(2) }).state, 'done', 'answered since');
    assert.equal(
      derive({ latestNotifyUserStep: { stepIndex: 9, step: { notifyUser: { isBlocking: false } } } }).state,
      'done'
    );
  });

  test('background work, stops, done and idle', () => {
    const bg = derive({ notFullyIdle: true });
    assert.equal(bg.state, 'working');
    assert.equal(bg.background, true);
    assert.equal(derive({ hasActiveChildren: true }).state, 'working');
    assert.equal(derive({ interrupted: true }).state, 'interrupted');
    assert.equal(derive({ killed: true, notFullyIdle: true }).state, 'interrupted');
    assert.equal(derive({}).state, 'done');
    assert.equal(derive({ lastModifiedTime: iso(20 * MIN) }).state, 'idle');
    assert.equal(derive({ interrupted: true, lastModifiedTime: iso(20 * MIN) }).state, 'idle');
    // without process information, an old "running" is stale
    assert.equal(
      derive({ status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: iso(45 * MIN) }, { liveness: 'unknown' }).state,
      'idle'
    );
    assert.equal(derive({ status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: iso(45 * MIN) }).state, 'working');
    // a running conversation of a language server that is gone stopped
    assert.equal(derive({ status: 'CASCADE_RUN_STATUS_RUNNING' }, { liveness: 'gone' }).state, 'interrupted');
  });

  test('times, statuses and paths are parsed leniently', () => {
    assert.equal(Sum.timeOf('2026-10-05 20:00:00.123456789+08:00'), FIXED + 123);
    assert.equal(Sum.timeOf('2026-10-05T12:00:00Z'), FIXED);
    assert.equal(Sum.timeOf(FIXED / 1000), FIXED);
    assert.equal(Sum.timeOf('nonsense'), null);
    assert.equal(Sum.runStatusOf('CASCADE_RUN_STATUS_BUSY'), 'busy');
    assert.equal(Sum.runStatusOf('running'), 'running');
    assert.equal(Sum.runStatusOf(1), 'idle');
    assert.equal(Sum.runStatusOf(''), 'unspecified');
    assert.equal(Sum.workspacePath('file:///Users/you/a%20b/'), '/Users/you/a b');
    assert.equal(Sum.workspacePath('https://example.invalid/x'), null);
  });

  test('task.md progress', () => {
    const text = [
      '# FAKE task',
      '- [x] FAKE first',
      '- [x] FAKE second',
      '- [/] **FAKE third** step',
      '  - [ ] FAKE nested',
      '* [ ] FAKE fourth',
      '1. [X] FAKE numbered',
      '- not a task',
    ].join('\n');
    assert.deepEqual(Sum.progressOfTask(text), { completed: 3, total: 6, active: 'FAKE third step' });
    assert.equal(Sum.progressOfTask('# nothing'), null);
  });

  test('raw_summary blobs decode into the same facts', () => {
    const decoded = Proto.decodeSummary(encodedSummary());
    assert.equal(decoded.status, 'CASCADE_RUN_STATUS_RUNNING');
    assert.equal(decoded.lastModifiedTime, iso(MIN));
    const f = Sum.factsFromRow({ conversation_id: ID(3), title: 'FAKE column title' }, 'cli', decoded);
    assert.equal(f.title, 'FAKE encoded title');
    assert.equal(f.workspace, '/Users/you/cli-app');
    assert.equal(f.branch, 'dev');
    assert.equal(f.notFullyIdle, true);
    assert.equal(f.waiting.kind, 'runCommand');
    assert.equal(f.waiting.command, 'npm run lint');
    assert.equal(f.lastUserInputStepIndex, 2);
    const s = Sum.deriveAgStatus(f, { now: FIXED, idleMs: IDLE_MS, liveness: 'live', lang: 'en' });
    assert.equal(s.state, 'permission');
    assert.equal(s.tool, 'Run: npm run lint');
    // broken blobs: no summary, the columns instead
    assert.equal(Proto.decodeSummary(Uint8Array.from([0x0a, 0x7f, 0x01])), null);
    assert.equal(Proto.decodeSummary(Uint8Array.from([])), null);
    assert.equal(Proto.decodeSummary(Uint8Array.from(pbStr(99, 'only unknown'))), null);
  });

  test('rows without a blob use the columns', () => {
    const f = Sum.factsFromRow(
      {
        conversation_id: ID(4),
        title: '',
        preview: 'FAKE preview text',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        last_modified_time: '2026-10-05 19:58:00.5+08:00',
        workspace_uris: '["file:///Users/you/cli-app"]',
        not_fully_idle: 1,
        killed: 0,
        last_user_input_step_index: -1,
        raw_summary: null,
      },
      'cli',
      null
    );
    assert.equal(f.title, 'FAKE preview text');
    assert.equal(f.status, 'running');
    assert.equal(f.lastModified, FIXED - 2 * MIN + 500);
    assert.equal(f.workspace, '/Users/you/cli-app');
    assert.equal(f.notFullyIdle, true);
    assert.equal(f.lastUserInputStepIndex, null);
    assert.equal(Sum.factsFromRow({ conversation_id: ID(5), parent_conversation_id: ID(4) }, 'cli', null).hidden, true);
    assert.equal(Sum.factsFromRow({ title: 'no id' }, 'cli', null), null);
    assert.equal(Sum.factsFromRow({ conversation_id: ID(6), workspace_uris: 'not json' }, 'cli', null).workspace, null);
  });
});

describe('summary database reader', () => {
  const sqlite = Db.loadSqlite();
  const SCHEMA =
    'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`))';

  function makeDb(dir) {
    const file = path.join(dir, Db.SUMMARY_DB);
    const db = new sqlite.DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec(SCHEMA);
    const insert = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, status, last_user_input_time, raw_summary) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insert.run(ID(1), 'FAKE first', '2026-10-05 19:50:00+08:00', '["file:///Users/you/cli-app"]', 'CASCADE_RUN_STATUS_IDLE', '2026-10-05 19:49:00+08:00', null);
    insert.run(ID(2), 'FAKE second', '2026-10-05 19:59:00+08:00', '["file:///Users/you/cli-app"]', '', '2026-10-05 19:56:00+08:00', encodedSummary());
    return { file, db };
  }

  const files = dir => fs.readdirSync(dir).sort();

  test('a database without a WAL is read through an immutable URI and nothing is created', { skip: !sqlite }, async () => {
    const dir = fs.mkdtempSync(path.join(empty, 'db-'));
    const { file, db } = makeDb(dir);
    db.close(); // checkpoints and removes the WAL
    assert.deepEqual(files(dir), [Db.SUMMARY_DB]);
    const tmp = fs.mkdtempSync(path.join(empty, 'tmp-'));
    const read = Db.createDbReader({ tmpDir: tmp });
    const rows = await read(file);
    assert.deepEqual(rows.map(r => r.conversation_id), [ID(2), ID(1)], 'newest first');
    assert.ok(rows[1].raw_summary === null);
    assert.ok(rows[0].raw_summary instanceof Uint8Array);
    assert.deepEqual(files(dir), [Db.SUMMARY_DB], 'no -wal / -shm created');
    assert.deepEqual(files(tmp), []);
    assert.equal(Db.immutableUri(file).search, '?mode=ro&immutable=1');
  });

  test('a database being written is read from a temp copy, which is removed', { skip: !sqlite }, async () => {
    const dir = fs.mkdtempSync(path.join(empty, 'db-'));
    const { file, db } = makeDb(dir);
    db.exec('PRAGMA wal_autocheckpoint=0;');
    db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, last_user_input_time) VALUES (?, ?, ?, ?, ?)'
    ).run(ID(3), 'FAKE third', '2026-10-05 19:59:30+08:00', '[]', '2026-10-05 19:59:00+08:00');
    const before = files(dir).map(f => [f, fs.statSync(path.join(dir, f)).size]);
    assert.ok(before.some(([f, size]) => f.endsWith('-wal') && size > 0));
    const tmp = fs.mkdtempSync(path.join(empty, 'tmp-'));
    const rows = await Db.createDbReader({ tmpDir: tmp })(file);
    assert.equal(rows.length, 3, 'the WAL rows too');
    assert.deepEqual(files(dir).map(f => [f, fs.statSync(path.join(dir, f)).size]), before);
    assert.deepEqual(files(tmp), [], 'the copy is gone');
    db.close();
  });

  test('missing or broken databases give null; no node:sqlite gives no reader', { skip: !sqlite }, async () => {
    const dir = fs.mkdtempSync(path.join(empty, 'db-'));
    const read = Db.createDbReader({ tmpDir: dir });
    assert.equal(await read(path.join(dir, 'missing.db')), null);
    fs.writeFileSync(path.join(dir, 'broken.db'), 'not a database');
    assert.equal(await read(path.join(dir, 'broken.db')), null);
    assert.equal(Db.createDbReader({ sqlite: null }), null);
  });
});

describe('Antigravity session source', () => {
  const appServer = server(101, 'app');
  const ideServer = server(102, 'ide', [50121, 50120], TOKEN2);

  test('app and IDE conversations over the RPC; the newest needing attention wins', async () => {
    const post = fakePost((port, p, headers) =>
      headers['x-codeium-csrf-token'] === TOKEN
        ? ok({
            [ID(1)]: summary({ status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true }),
            [ID(2)]: summary({ annotations: { title: 'FAKE subagent' }, trajectoryMetadata: { parentConversationId: ID(1) }, lastModifiedTime: iso(0) }),
          })
        : ok({
            [ID(3)]: summary({
              annotations: { title: 'FAKE IDE question' },
              lastModifiedTime: iso(5 * MIN),
              status: 'CASCADE_RUN_STATUS_RUNNING',
              waitingSteps: waitingStep({ askQuestion: { questions: [{ question: 'FAKE Which one?' }] } }),
              workspaces: [{ workspaceFolderAbsoluteUri: 'file:///Users/you/ide-app' }],
            }),
          })
    );
    const { source, probe } = makeSource({
      probe: fakeProbe({ servers: [appServer, ideServer], clis: [] }),
      post,
    });
    await source.rescan();
    assert.equal(probe.calls, 1);
    const pick = source.getStatus('', FIXED, IDLE_MS, {});
    assert.equal(pick.status.state, 'question');
    assert.equal(pick.status.title, 'FAKE IDE question');
    assert.equal(pick.status.project, 'ide-app');
    assert.equal(pick.others, 1, 'the working app conversation');
    // sources
    assert.equal(statusOf(source, { source: 'app' }).title, 'FAKE Dark mode toggle');
    assert.equal(statusOf(source, { source: 'app' }).state, 'working');
    assert.equal(statusOf(source, { source: 'cli' }), null);
    assert.equal(source.productName({ source: 'ide' }), 'Antigravity IDE');
    assert.equal(source.productName({ source: 'cli' }), 'Antigravity CLI');
    assert.equal(source.productName({}), 'Antigravity');
    // project filter
    assert.equal(statusOf(source, {}, 'Demo').title, 'FAKE Dark mode toggle');
    assert.equal(statusOf(source, {}, 'nothing-like-it'), null);
    source.stop();
  });

  test('the RPC runs when files change, on a press and on its interval, never twice within 2 s', async () => {
    const clock = { now: FIXED };
    let running = false;
    const post = fakePost(() =>
      ok({ [ID(1)]: summary(running ? { status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true } : {}) })
    );
    const { source, root, probe } = makeSource({
      probe: fakeProbe({ servers: [appServer], clis: [] }),
      post,
      clock,
      installed: ['app'],
    });
    const tick = async ms => {
      clock.now += ms;
      await source.refresh('poll');
    };
    await source.rescan();
    assert.equal(post.calls.length, 1);
    await tick(3_000);
    assert.equal(post.calls.length, 1, 'nothing changed');
    // the app writes its summary database
    const db = path.join(root, 'antigravity', 'conversation_summaries.db');
    fs.writeFileSync(db, 'x');
    await tick(1_000);
    assert.equal(post.calls.length, 2, 'a file changed');
    fs.writeFileSync(`${db}-wal`, 'xx');
    await tick(1_000);
    assert.equal(post.calls.length, 2, 'not within 2 s of the last call');
    await tick(1_500);
    assert.equal(post.calls.length, 3);
    await source.rescan();
    assert.equal(post.calls.length, 3, 'a press within 2 s');
    clock.now += 2_000;
    await source.rescan();
    assert.equal(post.calls.length, 4, 'a press');
    await tick(50_000);
    assert.equal(post.calls.length, 4);
    await tick(10_001);
    assert.equal(post.calls.length, 5, 'idle: every 60 s');
    running = true;
    clock.now += 2_000;
    await source.rescan();
    await tick(10_000);
    assert.equal(post.calls.length, 7, 'active: every 10 s');
    source.stop();
  });

  test('ps runs every 30 s without agy, every 10 s with it, and on presses', async () => {
    for (const [installed, expected] of [
      [['app'], 3],
      [['app', 'cli'], 7],
    ]) {
      const clock = { now: FIXED };
      const probe = fakeProbe({ servers: [appServer], clis: [] });
      const { source } = makeSource({ probe, clock, installed });
      await source.rescan();
      for (let i = 0; i < 12; i++) {
        clock.now += 5_000;
        await source.refresh('poll');
      }
      assert.equal(probe.calls, expected, `${installed}`);
      clock.now += 2_000;
      await source.rescan();
      assert.equal(probe.calls, expected + 1, 'a press');
      source.stop();
    }
  });

  test('a failing language server: last answer kept a while, backoff, rediscovery', async () => {
    const clock = { now: FIXED };
    let fail = false;
    const post = fakePost(() => (fail ? { error: 'refused' } : ok({ [ID(1)]: summary() })));
    const messages = [];
    const logger = { info: m => messages.push(m), warn: m => messages.push(m) };
    const probe = fakeProbe({ servers: [appServer], clis: [] });
    const { source } = makeSource({ probe, post, clock, installed: ['app'], logger });
    await source.rescan();
    fail = true;
    clock.now += 61_000;
    await source.refresh('poll');
    const calls = post.calls.length;
    assert.ok(probe.forgotten.includes(101), 'ports looked up again');
    assert.equal(statusOf(source).title, 'FAKE Dark mode toggle', 'kept for a while');
    clock.now += 3_000;
    await source.refresh('poll');
    assert.equal(post.calls.length, calls, 'backoff');
    clock.now += 61_000;
    await source.refresh('poll');
    assert.equal(statusOf(source), null, 'dropped after a minute (no database)');
    fail = false;
    clock.now += 61_000;
    await source.refresh('poll');
    assert.equal(statusOf(source).title, 'FAKE Dark mode toggle');
    assert.equal(messages.filter(m => m.includes('did not answer')).length, 1, 'logged once');
    assert.equal(messages.filter(m => m.includes('answers again')).length, 1);
    for (const m of messages) {
      assert.ok(!m.includes(TOKEN) && !m.includes(ID(1)) && !m.includes('FAKE'), m);
    }
    source.stop();
  });

  test('rejected twice: signed out (when there is nothing else to show)', async () => {
    const clock = { now: FIXED };
    const post = fakePost(() => ({ status: 401, body: JSON.stringify({ code: 'unauthenticated' }) }));
    const { source } = makeSource({
      probe: fakeProbe({ servers: [appServer], clis: [] }),
      post,
      clock,
      installed: ['app'],
    });
    await source.rescan();
    assert.equal(source.notice({}), null);
    clock.now += 6_000;
    await source.refresh('poll');
    assert.equal(source.notice({}).text.en, 'Sign in to Antigravity');
    assert.equal(source.notice({}).label.zh, '未登录');
    source.stop();
  });

  test('without a running language server, the summary database gives the last state', async () => {
    const appRows = [
      { conversation_id: ID(1), title: 'FAKE was running', status: 'CASCADE_RUN_STATUS_RUNNING', last_modified_time: iso(3 * MIN), workspace_uris: '["file:///Users/you/demo-app"]' },
      { conversation_id: ID(2), title: 'FAKE older', status: 'CASCADE_RUN_STATUS_IDLE', last_modified_time: iso(30 * MIN), workspace_uris: '[]' },
    ];
    const { source, post } = makeSource({ rows: { app: appRows }, installed: ['app'] });
    fs.writeFileSync(path.join(source.options.root, 'antigravity', 'conversation_summaries.db'), 'x');
    await source.rescan();
    assert.equal(post.calls.length, 0);
    const s = statusOf(source);
    assert.equal(s.title, 'FAKE was running');
    assert.equal(s.state, 'interrupted', 'the app quit while it ran');
    assert.equal(s.live, false);
    const list = source.listRunning('', FIXED, IDLE_MS, {});
    assert.deepEqual(list.map(r => [r.status.title, r.group]), [['FAKE was running', 'stopped']]);
    source.stop();
  });

  test('agy CLIs: a running CLI owns the newest conversation of its folder; a new one shows as a new session', async () => {
    const cliRows = [
      { conversation_id: ID(11), title: 'FAKE cli working', status: 'CASCADE_RUN_STATUS_RUNNING', not_fully_idle: 1, last_modified_time: iso(MIN), workspace_uris: '["file:///Users/you/cli-app"]' },
      { conversation_id: ID(12), title: 'FAKE cli crashed', status: 'CASCADE_RUN_STATUS_RUNNING', last_modified_time: iso(4 * MIN), workspace_uris: '["file:///Users/you/old-app"]' },
      { conversation_id: ID(13), title: 'FAKE cli finished', status: 'CASCADE_RUN_STATUS_IDLE', last_modified_time: iso(8 * MIN), workspace_uris: '["file:///Users/you/cli-app"]' },
      { conversation_id: ID(14), title: 'FAKE cli subagent', parent_conversation_id: ID(11), last_modified_time: iso(0), workspace_uris: '["file:///Users/you/cli-app"]' },
    ];
    const clis = [
      { pid: 201, startedAt: FIXED - 20 * MIN, cwd: '/Users/you/cli-app' },
      { pid: 202, startedAt: FIXED - 2 * MIN, cwd: '/Users/you/fresh-app' },
    ];
    const { source, root } = makeSource({
      probe: fakeProbe({ servers: [], clis }),
      rows: { cli: cliRows },
      installed: ['cli'],
    });
    fs.writeFileSync(path.join(root, 'antigravity-cli', 'conversation_summaries.db'), 'x');
    await source.rescan();
    const s = statusOf(source, { source: 'cli' });
    assert.equal(s.title, 'FAKE cli working');
    assert.equal(s.state, 'working');
    assert.equal(s.live, true);
    assert.equal(s.project, 'cli-app');
    const list = source.listRunning('', FIXED, IDLE_MS, { lang: 'zh' });
    assert.deepEqual(
      list.map(r => [r.status.title, r.group]),
      [
        ['FAKE cli working', 'working'],
        ['FAKE cli crashed', 'stopped'],
        ['新会话', 'done'],
        ['FAKE cli finished', 'done'],
      ]
    );
    // a key filtered to the new CLI's folder shows it as a new session
    const fresh = source.getStatus('fresh', FIXED, IDLE_MS, { lang: 'en' }).status;
    assert.equal(fresh.title, 'New session');
    assert.equal(fresh.project, 'fresh-app');
    assert.equal(fresh.live, true);
    // the app and IDE sources do not show CLI sessions
    assert.equal(statusOf(source, { source: 'app' }), null);
    source.stop();
  });

  test('the progress of the shown conversation comes from its task.md', async () => {
    const { source, root } = makeSource({
      probe: fakeProbe({ servers: [appServer], clis: [] }),
      post: fakePost(() => ok({ [ID(1)]: summary({ status: 'CASCADE_RUN_STATUS_RUNNING' }) })),
      installed: ['app'],
    });
    const dir = path.join(root, 'antigravity', 'brain', ID(1));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.md'), '- [x] FAKE one\n- [/] FAKE two\n- [ ] FAKE three\n');
    source.start();
    for (let i = 0; i < 50 && source.changes === undefined; i++) await sleep(1);
    await source.rescan();
    assert.equal(statusOf(source).progress, null, 'not read yet');
    for (let i = 0; i < 100 && !statusOf(source).progress; i++) await sleep(5);
    assert.deepEqual(statusOf(source).progress, { completed: 1, total: 3, active: 'FAKE two' });
    assert.equal(statusOf(source, { showProgress: false }).progress, null);
    source.stop();
  });

  test('a desktop database that changes while no server is known: ps again soon', async () => {
    const clock = { now: FIXED };
    let servers = [];
    const probe = fakeProbe(() => ({ servers, clis: [] }));
    const { source, root, post } = makeSource({ probe, clock, installed: ['app'] });
    await source.rescan();
    assert.equal(probe.calls, 1);
    clock.now += 5_000;
    await source.refresh('poll');
    assert.equal(probe.calls, 1, 'every 30 s');
    // the app starts: its language server writes the summary database
    servers = [appServer];
    fs.writeFileSync(path.join(root, 'antigravity', 'conversation_summaries.db'), 'x');
    clock.now += 5_000;
    await source.refresh('poll');
    clock.now += 5_000;
    await source.refresh('poll');
    assert.equal(probe.calls, 2, 'probed at the next tick');
    assert.equal(post.calls.length, 1, 'and asked');
    source.stop();
  });

  test('nothing installed: no process list, no RPC, a not-installed notice', async () => {
    const probe = fakeProbe({ servers: [appServer], clis: [] });
    const { source, post } = makeSource({ probe, installed: [] });
    await source.rescan();
    assert.equal(probe.calls, 0);
    assert.equal(post.calls.length, 0);
    assert.equal(statusOf(source), null);
    assert.equal(source.notice({}).text.en, 'Install Antigravity');
    assert.equal(source.notice({ source: 'cli' }).text.en, 'Install Antigravity CLI');
    source.stop();
  });

  test('only the products keys follow are refreshed', async () => {
    const clock = { now: FIXED };
    const probe = fakeProbe({ servers: [appServer], clis: [] });
    const { source, post } = makeSource({ probe, clock });
    await source.rescan();
    assert.equal(post.calls.length, 1);
    clock.now += 61_000;
    source.getStatus('', clock.now, IDLE_MS, { source: 'cli' });
    await source.refresh('poll');
    assert.equal(post.calls.length, 1, 'no key follows the app');
    assert.equal(statusOf(source, { source: 'app' }), null);
    // a key that follows the app again
    clock.now += 2_000;
    await source.refresh('poll');
    assert.equal(post.calls.length, 2);
    source.stop();
  });

  test('a press list with many sessions, sorted and capped', async () => {
    const map = {};
    const titles = [];
    for (let i = 1; i <= 40; i++) {
      titles.push(`FAKE ${i}`);
      map[ID(i)] = summary({
        annotations: { title: `FAKE ${i}` },
        lastModifiedTime: iso(i * 1000),
        status: i % 3 === 0 ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
        waitingSteps: i === 7 ? waitingStep({ runCommand: {} }) : undefined,
      });
    }
    const { source } = makeSource({
      probe: fakeProbe({ servers: [appServer], clis: [] }),
      post: fakePost(() => ok(map)),
      installed: ['app'],
    });
    await source.rescan();
    const list = source.listRunning('', FIXED, IDLE_MS, {});
    assert.equal(list.length, 36);
    assert.equal(list[0].status.title, 'FAKE 3', 'working first (no waiting step on an idle one)');
    const groups = list.map(r => r.group);
    assert.deepEqual(groups, [...groups].sort((a, b) => ['attention', 'working', 'stopped', 'done'].indexOf(a) - ['attention', 'working', 'stopped', 'done'].indexOf(b)));
    source.stop();
  });

  test('onChange after start, never after stop', async () => {
    const { source, changes } = makeSource();
    source.start();
    for (let i = 0; i < 100 && changes() === 0; i++) await sleep(5);
    assert.ok(changes() > 0);
    source.stop();
    const after = changes();
    await source.rescan();
    await sleep(20);
    assert.equal(changes(), after);
  });

  test('describe answers the settings page', async () => {
    const { provider, root } = makeSource({
      probe: fakeProbe({ servers: [appServer], clis: [] }),
      post: fakePost(() => ok({ [ID(1)]: summary() })),
      installed: ['app'],
    });
    const reply = await provider.describe('', { antigravityDir: root }, { idleMinutes: 15 });
    assert.equal(reply.success, true);
    assert.equal(reply.state, 'done');
    assert.equal(reply.project, 'demo-app');
    assert.equal(reply.projectsDir, root);
    const none = makeSource({ installed: [] });
    const missing = await none.provider.describe('', { antigravityDir: none.root }, {});
    assert.equal(missing.success, false);
    assert.equal(missing.notice.label.en, 'Not installed');
  });

  test('the default provider never reaches a real process or server in tests', async () => {
    let changes = 0;
    const source = S.sessionProvider.create({
      location: S.sessionProvider.location({ antigravityDir: path.join(empty, 'none') }),
      config: { antigravityDir: path.join(empty, 'none'), antigravityPath: path.join(empty, 'no-agy') },
      onChange: () => changes++,
    });
    try {
      source.start();
      for (let i = 0; i < 200 && changes === 0; i++) await sleep(10);
      assert.ok(changes > 0, 'onChange after start');
      assert.equal(typeof source.getStatus('', Date.now(), IDLE_MS).others, 'number');
      assert.ok(Array.isArray(source.listRunning('', Date.now(), IDLE_MS)));
    } finally {
      source.stop();
    }
  });

  test('the key draws 60px faces and a press list', async () => {
    const cid = Kit.keyCid('antigravity', 'session');
    const { provider } = makeSource({
      probe: fakeProbe({ servers: [appServer], clis: [] }),
      post: fakePost(() =>
        ok({
          [ID(1)]: summary({ status: 'CASCADE_RUN_STATUS_RUNNING', waitingSteps: waitingStep({ runCommand: {} }) }),
          [ID(2)]: summary({ annotations: { title: 'FAKE second' }, lastModifiedTime: iso(3 * MIN) }),
        })
      ),
      installed: ['app'],
    });
    const hooks = drawHooks();
    const keys = new SessionKeys({
      ...hooks.deps,
      provider: { cid, brand: ANTIGRAVITY_BRAND, sessions: provider },
    });
    try {
      const k1 = { uid: 1, cid, width: 240, data: { lang: 'en' } };
      await keys.alive(SERIAL, [k1, { uid: 2, cid, width: 60, data: { lang: 'zh' } }]);
      for (let i = 0; i < 100 && hooks.sent.length < 4; i++) await sleep(10);
      await hooks.settle();
      assert.ok(hooks.sent.length >= 2);
      for (const [uid, image] of hooks.sent) {
        assert.deepEqual(pngSize(image), [uid === 1 ? 240 : 60, 60]);
      }
      const count = hooks.sent.length;
      await keys.press(SERIAL, k1);
      await hooks.settle();
      assert.ok(hooks.sent.length > count, 'the list was drawn');
    } finally {
      await keys.dead(SERIAL, []);
    }
  });
});

describe('Antigravity New Session launcher', () => {
  const request = (data, extra = {}) => ({
    data,
    rawFolder: data.folder ?? '',
    folder: data.folder ? data.folder.replace(/^~/, '/Users/you') : null,
    home: '/Users/you',
    platform: 'darwin',
    config: {},
    ...extra,
  });
  const launcher = (opts = {}) =>
    NS.createAntigravityLauncher({
      isDirectory: dir => dir.startsWith('/Users/you/') && !dir.includes('missing'),
      findCli: () => ('cli' in opts ? opts.cli : '/Users/you/.local/bin/agy'),
      appInstalled: product => (opts.apps ?? ['app', 'ide']).includes(product),
    });
  const keyTitle = (fn, lang = 'en') => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      return error.extra.keyText[lang].title;
    }
    assert.fail('no error');
  };

  test('auto: agy in a terminal when installed, else the app, else the IDE', () => {
    assert.deepEqual(launcher().target(request({ folder: '~/code/demo-app' })), {
      kind: 'terminal',
      command: ['/Users/you/.local/bin/agy'],
      cwd: '/Users/you/code/demo-app',
    });
    assert.deepEqual(launcher().target(request({})).cwd, '/Users/you', 'home folder by default');
    assert.deepEqual(launcher({ cli: null }).target(request({ folder: '~/code/demo-app' })), {
      kind: 'command',
      file: '/usr/bin/open',
      args: ['-b', 'com.google.antigravity'],
    });
    assert.deepEqual(launcher({ cli: null, apps: ['ide'] }).target(request({ folder: '~/code/demo-app' })), {
      kind: 'command',
      file: '/usr/bin/open',
      args: ['-b', 'com.google.antigravity-ide', '/Users/you/code/demo-app'],
    });
    assert.equal(keyTitle(() => launcher({ cli: null, apps: [] }).target(request({}))), 'Antigravity not found');
    assert.equal(keyTitle(() => launcher().target(request({ folder: '~/missing' })), 'zh'), '未找到文件夹');
  });

  test('terminal-cli: fixed presets only', () => {
    const t = data => launcher().target(request({ target: 'terminal-cli', ...data })).command.slice(1);
    assert.deepEqual(t({}), []);
    assert.deepEqual(t({ resume: true }), ['--continue']);
    assert.deepEqual(t({ mode: 'accept-edits' }), ['--mode', 'accept-edits']);
    assert.deepEqual(t({ mode: 'plan', sandbox: true }), ['--mode', 'plan', '--sandbox']);
    assert.deepEqual(t({ mode: 'skip-permissions' }), ['--dangerously-skip-permissions']);
    assert.deepEqual(t({ mode: 'default' }), []);
    assert.deepEqual(t({ mode: '--model x; rm -rf ~', resume: 'yes', sandbox: 1 }), [], 'no free text');
    assert.deepEqual(t({ mode: 'constructor' }), []);
    assert.equal(keyTitle(() => launcher({ cli: null }).target(request({ target: 'terminal-cli' }))), 'agy not found');
    assert.equal(keyTitle(() => launcher().target(request({ target: 'terminal-cli', folder: '~/missing' }))), 'Folder not found');
  });

  test('app and IDE targets (macOS)', () => {
    assert.deepEqual(launcher().target(request({ target: 'app', folder: '~/code/demo-app' })).args, ['-b', 'com.google.antigravity']);
    assert.deepEqual(launcher().target(request({ target: 'ide' })).args, ['-b', 'com.google.antigravity-ide']);
    assert.equal(keyTitle(() => launcher({ apps: [] }).target(request({ target: 'app' }))), 'App not found');
    assert.equal(keyTitle(() => launcher({ apps: [] }).target(request({ target: 'ide' })), 'zh'), '未找到 IDE');
    assert.equal(keyTitle(() => launcher().target(request({ target: 'app' }, { platform: 'linux' }))), 'App not found');
    assert.equal(keyTitle(() => launcher().target(request({ target: 'ide', folder: '~/missing' }))), 'Folder not found');
  });

  test('subtitles: the folder, or where the app opens; auto names what a press opens', () => {
    const l = launcher();
    assert.equal(l.subtitle({ target: 'app' }, 'demo-app', 'en'), 'App · ⌘N');
    assert.equal(l.subtitle({ target: 'app' }, null, 'zh'), 'App · ⌘N');
    assert.equal(l.subtitle({ target: 'ide' }, null, 'en'), 'IDE');
    assert.equal(l.subtitle({ target: 'ide' }, 'demo-app', 'en'), 'demo-app');
    assert.equal(l.subtitle({ target: 'terminal-cli' }, null, 'en'), null);
    assert.equal(l.subtitle({}, 'demo-app', 'en'), 'demo-app', 'auto: agy');
    const noAgy = launcher({ cli: null });
    assert.equal(noAgy.subtitle({}, 'demo-app', 'en'), 'App · ⌘N', 'auto: the app');
    assert.equal(launcher({ cli: null, apps: ['ide'] }).subtitle({}, null, 'en'), 'IDE');
    assert.equal(launcher({ cli: null, apps: [] }).subtitle({}, 'demo-app', 'en'), 'demo-app');
    // a press decides with the global settings, and the face follows it
    let found = null;
    const l2 = NS.createAntigravityLauncher({
      isDirectory: () => true,
      findCli: (_request, config) => (config.antigravityPath ? found : null),
      appInstalled: () => true,
    });
    assert.equal(l2.subtitle({}, 'demo-app', 'en'), 'App · ⌘N');
    found = '/opt/custom/agy';
    l2.target(request({ folder: '~/code/demo-app' }, { config: { antigravityPath: '/opt/custom/agy' } }));
    assert.equal(l2.subtitle({}, 'demo-app', 'en'), 'demo-app');
    assert.equal(l2.needsConfig, true);
  });

  test('agy lookup: the setting, else PATH and the usual folders', () => {
    const exe = new Set(['/Users/you/.local/bin/agy', '/opt/custom/agy']);
    const isExecutable = f => exe.has(f);
    assert.equal(Cli.findAgy({ setting: '/opt/custom/agy', isExecutable }), '/opt/custom/agy');
    assert.equal(Cli.findAgy({ setting: '/opt/missing/agy', isExecutable }), null);
    assert.equal(
      Cli.findAgy({ setting: null, home: '/Users/you', platform: 'darwin', env: { PATH: '/usr/bin' }, isExecutable }),
      '/Users/you/.local/bin/agy'
    );
    assert.equal(Cli.findAgy({ setting: null, home: '/Users/you', platform: 'darwin', env: {}, isExecutable: () => false }), null);
    assert.equal(Cli.bundleInstalled('ide', '/Users/you', dir => dir === '/Users/you/Applications/Antigravity IDE.app'), true);
    assert.equal(Cli.bundleInstalled('app', '/Users/you', () => false), false);
  });

  test('a press goes through the key group to a stubbed opener', async () => {
    const cid = Kit.keyCid('antigravity', 'newsession');
    const hooks = drawHooks();
    const opened = [];
    const keys = new NewSessionKeys({
      ...hooks.deps,
      provider: { cid, brand: ANTIGRAVITY_BRAND, launcher: launcher() },
      launch: async url => opened.push(['url', url]),
      run: async command => opened.push(['run', command]),
      terminal: async (command, cwd) => opened.push(['terminal', command, cwd]),
      home: '/Users/you',
      platform: 'darwin',
      timings: { openingMs: 5, errorMs: 5 },
    });
    const key = { uid: 1, cid, width: 120, data: { folder: '~/work/demo-app', mode: 'plan' } };
    const appKey = { uid: 2, cid, width: 120, data: { target: 'app' } };
    await keys.alive(SERIAL, [key, appKey]);
    assert.equal(await keys.press(SERIAL, key), true);
    assert.equal(await keys.press(SERIAL, appKey), true);
    await hooks.settle();
    assert.deepEqual(opened, [
      ['terminal', ['/Users/you/.local/bin/agy', '--mode', 'plan'], '/Users/you/work/demo-app'],
      ['run', { file: '/usr/bin/open', args: ['-b', 'com.google.antigravity'] }],
    ]);
    for (const [, image] of hooks.sent) assert.deepEqual(pngSize(image), [120, 60]);
    await keys.dead(SERIAL, []);
  });

  test('the default launcher fails cleanly when nothing is installed', async () => {
    try {
      const target = await NS.newSessionLauncher.target({
        data: { target: 'terminal-cli' },
        rawFolder: '',
        folder: null,
        home: empty,
        platform: 'darwin',
        config: { antigravityPath: path.join(empty, 'no-agy') },
      });
      assert.fail(`unexpected target ${target.kind}`);
    } catch (error) {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      assert.equal(error.extra.keyText.en.title, 'agy not found');
    }
  });
});
