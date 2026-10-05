// Tests for the Gemini session source and New Session launcher
// (src/providers/gemini/session*.ts, newSession.ts), run against the tsc
// output of `npm run test:gemini-session` (.test-build-gemini-session/).
// Rules: synthetic fixtures only (see CLAUDE.md), never read the real home
// folder (HOME points at an empty temp folder), never open a link, a
// terminal or an app, never start ps/lsof: every launcher, process probe and
// command runner below is a stub.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-session-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
for (const name of ['GEMINI_CLI_HOME']) delete process.env[name];
globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};
after(() => fs.rmSync(empty, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.GEMINI_SESSION_TEST_BUILD ??
  path.join(here, '..', '.test-build-gemini-session');
const req = p => require(path.join(build, p));
const S = req('providers/gemini/session.js');
const P = req('providers/gemini/sessionParse.js');
const PR = req('providers/gemini/sessionProcs.js');
const M = req('providers/gemini/sessionMonitor.js');
const CLI = req('providers/gemini/sessionCli.js');
const NS = req('providers/gemini/newSession.js');
const Kit = req('providers/kit.js');
const L = req('launch.js');
const V = req('sessionView.js');
const { SessionKeys } = req('sessionKey.js');
const { NewSessionKeys } = req('newSessionKey.js');
const { GEMINI_BRAND } = req('providers/gemini/brand.js');

const CONFIG = {
  geminiDir: path.join(empty, 'gemini'),
  geminiPath: path.join(empty, 'no-gemini'),
};
const SERIAL = 'FAKE-DEVICE-1';
const HOME = '/Users/you';
const MIN = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sid = n => `${String(n).repeat(8)}-0000-4000-8000-00000000000${n}`;

function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function drawHooks(config = CONFIG) {
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

// --- synthetic session files -------------------------------------------------

const iso = ms => new Date(ms).toISOString();
let nextId = 1;
const mid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

const msg = {
  user: (text, at, display) => ({
    id: mid(),
    timestamp: iso(at),
    type: 'user',
    content: [{ text }],
    ...(display !== undefined ? { displayContent: [{ text: display }] } : {}),
  }),
  gemini: (text, at, toolCalls) => ({
    id: mid(),
    timestamp: iso(at),
    type: 'gemini',
    content: text,
    thoughts: [{ subject: 'Thinking', description: 'synthetic', timestamp: iso(at) }],
    tokens: { input: 10, output: 5, cached: 0, thoughts: 1, tool: 0, total: 16 },
    model: 'gemini-2.5-pro',
    ...(toolCalls ? { toolCalls } : {}),
  }),
  info: (text, at) => ({ id: mid(), timestamp: iso(at), type: 'info', content: text }),
  warning: (text, at) => ({ id: mid(), timestamp: iso(at), type: 'warning', content: text }),
  error: (text, at) => ({ id: mid(), timestamp: iso(at), type: 'error', content: text }),
};

const call = (name, status, args = {}) => ({
  id: `${name}_1_0`,
  name,
  args,
  result: [{ functionResponse: { id: `${name}_1_0`, name, response: { output: 'synthetic' } } }],
  status,
  timestamp: iso(Date.now()),
  displayName: name,
  description: '',
  renderOutputAsMarkdown: false,
});

function documentOf({ id, start, messages, kind = 'main', summary, lastUpdated }) {
  const last = messages.length ? Date.parse(messages[messages.length - 1].timestamp) : start;
  const doc = {
    sessionId: id,
    projectHash: '0'.repeat(64),
    startTime: iso(start),
    lastUpdated: iso(lastUpdated ?? last),
    messages,
    kind,
  };
  if (summary) doc.summary = summary;
  return JSON.stringify(doc, null, 2);
}

function facts(messages, extra = {}) {
  const t = P.parseDocument(documentOf({ id: sid(1), start: Date.now() - 60 * MIN, messages, ...extra }));
  assert.ok(t, 'document parses');
  return P.factsOf(t);
}

function derive(messages, options = {}) {
  return P.deriveGeminiStatus(facts(messages), {
    now: Date.now(),
    idleMs: 15 * MIN,
    live: null,
    project: 'demo-app',
    ...options,
  });
}

const alive = (extra = {}) => ({ alive: true, toolChildAt: null, approvalMode: null, ...extra });
const dead = { alive: false, toolChildAt: null, approvalMode: null };

// --- parser and status -----------------------------------------------------------

describe('Gemini session files', () => {
  test('message text: display content first, CJK kept, thoughts left out', () => {
    const now = Date.now();
    const m = P.compactMessage(msg.user('expanded @file content', now, '  看看 @a.ts   这个\n文件 '));
    assert.equal(m.text, '看看 @a.ts 这个 文件');
    assert.equal(P.partsText([{ text: 'a' }, { text: 'hidden', thought: true }, { text: 'b' }]), 'ab');
    assert.equal(P.partsText('plain'), 'plain');
    const g = P.compactMessage({ type: 'gemini', content: 'x'.repeat(5000), timestamp: iso(now) });
    assert.equal(g.text.length, 2000, 'only the end of a long reply is kept');
    assert.equal(P.compactMessage({ content: 'no type' }), null);
  });

  test('titles: summary, then the first prompt that is no command', () => {
    const now = Date.now();
    const base = [msg.user('/stats', now - 9 * MIN), msg.user('?', now - 8 * MIN), msg.user('修复登录页面的错误', now - 7 * MIN), msg.gemini('ok', now - 6 * MIN)];
    assert.equal(facts(base).title, '修复登录页面的错误');
    assert.equal(facts(base, { summary: 'Fix the login page' }).title, 'Fix the login page');
    assert.equal(facts([msg.user('/compress', now)]).title, '/compress', 'falls back to the last prompt');
    assert.equal(facts([]).title, null);
  });

  test('a prompt waiting for the model is working; a gone CLI makes it stopped', () => {
    const now = Date.now();
    const s = derive([msg.user('Add a test', now - 5_000)]);
    assert.equal(s.state, 'working');
    assert.equal(s.since, now - 5_000);
    assert.equal(s.title, 'Add a test');
    assert.equal(s.project, 'demo-app');
    assert.equal(derive([msg.user('Add a test', now - 30_000)], { live: dead }).state, 'working', 'grace period');
    assert.equal(derive([msg.user('Add a test', now - 2 * MIN)], { live: dead }).state, 'interrupted');
    assert.equal(derive([msg.user('Add a test', now - 2 * MIN)], { live: alive() }).state, 'working');
    assert.equal(derive([msg.user('Add a test', now - 2 * MIN)], { live: alive() }).live, true);
    assert.equal(derive([msg.user('Add a test', now - 40 * MIN)]).state, 'idle', 'stale without process info');
  });

  test('finished tool calls go back to the model: working', () => {
    const now = Date.now();
    const s = derive([
      msg.user('Run the tests', now - 60_000),
      msg.gemini('Running them.', now - 50_000, [call('run_shell_command', 'success', { command: 'npm test' })]),
    ]);
    assert.equal(s.state, 'working');
    assert.equal(s.since, now - 60_000);
    const errored = derive([
      msg.user('Run the tests', now - 60_000),
      msg.gemini('', now - 50_000, [call('run_shell_command', 'error')]),
    ]);
    assert.equal(errored.state, 'working');
  });

  test('cancelled calls and cancel notices are interrupted', () => {
    const now = Date.now();
    const turn = [msg.user('Delete the build folder', now - 60_000)];
    assert.equal(derive([...turn, msg.gemini('', now - 50_000, [call('run_shell_command', 'cancelled')])]).state, 'interrupted');
    for (const text of ['Request cancelled.', 'User cancelled the request.', 'Operation cancelled.', 'Agent execution stopped: hook said no']) {
      const s = derive([...turn, msg.gemini('Working on it', now - 50_000), msg.info(text, now - 40_000)]);
      assert.equal(s.state, 'interrupted', text);
      assert.equal(s.since, now - 40_000);
    }
  });

  test('other notices and warnings keep the state', () => {
    const now = Date.now();
    const s = derive([
      msg.user('Explain the parser', now - 60_000),
      msg.gemini('It splits lines.', now - 50_000),
      msg.info('Chat history compressed.', now - 40_000),
      msg.warning('Some synthetic warning', now - 30_000),
    ]);
    assert.equal(s.state, 'done');
    assert.equal(s.since, now - 50_000);
  });

  test('a reply without text is a pending tool call: working, then Approval?', () => {
    const now = Date.now();
    const turn = [msg.user('Edit the config', now - 60_000)];
    assert.equal(derive([...turn, msg.gemini('', now - 3_000)]).state, 'working');
    const waiting = derive([...turn, msg.gemini('', now - 30_000)]);
    assert.equal(waiting.state, 'permission');
    assert.equal(waiting.confident, false);
    assert.equal(waiting.since, now - 30_000);
    const view = V.buildSessionView(waiting, { lang: 'en', showProject: true, now });
    assert.equal(view.label, 'Approval?');
    assert.equal(view.tone, 'attention');
    // a tool process started after the reply: it runs
    assert.equal(derive([...turn, msg.gemini('', now - 30_000)], { live: alive({ toolChildAt: now - 20_000 }) }).state, 'working');
    // children from before the reply (MCP servers) do not count
    assert.equal(derive([...turn, msg.gemini('', now - 30_000)], { live: alive({ toolChildAt: now - 90_000 }) }).state, 'permission');
    assert.equal(derive([...turn, msg.gemini('', now - 30_000)], { live: alive({ approvalMode: 'yolo' }) }).state, 'working', 'no approvals in yolo mode');
    assert.equal(derive([msg.user('Edit the config', now - 4 * MIN), msg.gemini('', now - 3 * MIN)], { live: dead }).state, 'interrupted');
    // a subagent writing after the reply: busy
    assert.equal(derive([...turn, msg.gemini('', now - 30_000)], { subagentAt: now - 5_000 }).state, 'working');
  });

  test('newer releases may record a call awaiting approval: confident Approval', () => {
    const now = Date.now();
    const s = derive([msg.user('Write the file', now - 60_000), msg.gemini('Writing.', now - 30_000, [call('write_file', 'awaiting_approval')])]);
    assert.equal(s.state, 'permission');
    assert.equal(s.confident, true);
    assert.equal(derive([msg.user('x', now - 60_000), msg.gemini('', now - 30_000, [call('run_shell_command', 'executing')])]).state, 'working');
  });

  test('a reply with text is done, with a trailing question when it ends in one', () => {
    const now = Date.now();
    const turn = [msg.user('Add a unit test', now - 60_000)];
    const done = derive([...turn, msg.gemini('Done. The test passes.', now - 30_000)]);
    assert.equal(done.state, 'done');
    assert.equal(done.hasQuestion, false);
    assert.equal(done.since, now - 30_000);
    const asked = derive([...turn, msg.gemini('Done. Should I also cover the error path?', now - 30_000)]);
    assert.equal(asked.state, 'done');
    assert.equal(asked.hasQuestion, true);
    assert.equal(asked.question, 'Should I also cover the error path?');
    assert.equal(V.buildSessionView(asked, { lang: 'zh', showProject: true, now }).label, '有疑问');
    const zh = derive([...turn, msg.gemini('已完成。要继续优化吗？', now - 30_000)]);
    assert.equal(zh.question, '要继续优化吗？');
    // a preamble with a tool now running
    assert.equal(derive([...turn, msg.gemini('Let me run it.', now - 30_000)], { live: alive({ toolChildAt: now - 25_000 }) }).state, 'working');
    // idle after the key's idle time
    const old = derive([...turn.map(m => ({ ...m, timestamp: iso(now - 50 * MIN) })), msg.gemini('Done?', now - 40 * MIN)]);
    assert.equal(old.state, 'idle');
    assert.equal(old.hasQuestion, false);
  });

  test('an error ends the turn with its first line', () => {
    const now = Date.now();
    const s = derive([msg.user('Summarize', now - 60_000), msg.error('[API Error: synthetic quota message]\nsecond line', now - 30_000)]);
    assert.equal(s.state, 'error');
    assert.equal(s.detail, '[API Error: synthetic quota message]');
    assert.equal(V.buildSessionView(s, { lang: 'en', showProject: true, now }).tone, 'error');
    // a new prompt clears it
    assert.equal(derive([msg.user('a', now - 90_000), msg.error('x', now - 80_000), msg.user('b', now - 5_000)]).detail, null);
  });

  test('progress comes from the latest completed write_todos', () => {
    const now = Date.now();
    const todos = status => ({
      todos: [
        { description: 'Read the code', status: 'completed' },
        { description: 'Write the test', status },
        { description: 'Dropped idea', status: 'cancelled' },
      ],
    });
    const s = derive([msg.user('Plan it', now - 60_000), msg.gemini('', now - 50_000, [call('write_todos', 'success', todos('in_progress'))])]);
    assert.deepEqual(s.progress, { completed: 1, total: 2, active: 'Write the test' });
    // a finished list from an earlier turn is history
    const later = derive([
      msg.user('Plan it', now - 90_000),
      msg.gemini('', now - 80_000, [call('write_todos', 'success', todos('completed'))]),
      msg.gemini('All done.', now - 70_000),
      msg.user('Next thing', now - 5_000),
    ]);
    assert.equal(later.progress, null);
    // a failed write_todos changes nothing
    assert.equal(derive([msg.user('x', now - 9_000), msg.gemini('', now - 8_000, [call('write_todos', 'error', todos('pending'))])]).progress, null);
  });

  test('no messages: idle', () => {
    const s = derive([]);
    assert.equal(s.state, 'idle');
    assert.equal(s.title, null);
  });

  test('a half-written document is not parsed (and the error stays inside)', () => {
    const text = documentOf({ id: sid(1), start: Date.now(), messages: [msg.user('secret prompt text', Date.now())] });
    assert.equal(P.parseDocument(text.slice(0, text.length / 2)), null);
    assert.equal(P.parseDocument(''), null);
    assert.equal(P.parseDocument('[]'), null);
  });

  test('big documents are read from their head and tail', () => {
    const now = Date.now();
    const messages = [msg.user('The first prompt', now - 50 * MIN)];
    for (let i = 0; i < 200; i++) messages.push(msg.gemini(`step ${i}`, now - 40 * MIN + i * 1000, [call('read_file', 'success')]));
    messages.push(msg.gemini('All finished. Anything else?', now - MIN));
    const text = documentOf({ id: sid(2), start: now - 50 * MIN, messages, summary: 'Summarized title' });
    const t = P.parseDocumentSlices(text.slice(0, 2000), text.slice(-6000));
    assert.ok(t);
    assert.equal(t.meta.sessionId, sid(2));
    assert.equal(t.meta.kind, 'main');
    assert.equal(t.meta.summary, 'Summarized title');
    const f = P.factsOf(t);
    assert.equal(f.last.kind, 'reply');
    assert.equal(f.replyText, 'All finished. Anything else?');
    assert.equal(t.messages[0].text, 'The first prompt');
    // trailing directories after kind
    const withDirs = text.replace(/\n}$/, ',\n  "directories": [\n    "/Users/you/x"\n  ]\n}');
    assert.equal(P.parseDocumentSlices(withDirs.slice(0, 2000), withDirs.slice(-6000)).meta.summary, 'Summarized title');
    assert.equal(P.parseDocumentSlices('not json', 'nothing'), null);
  });

  test('JSONL: metadata, re-appended ids, $set, $patch and $rewindTo', () => {
    const now = Date.now();
    const t = new P.GeminiTranscript();
    const u1 = msg.user('First prompt', now - 60_000);
    const g1 = msg.gemini('Running.', now - 50_000);
    const lines = [
      { sessionId: sid(3), projectHash: '0'.repeat(64), startTime: iso(now - 70_000), lastUpdated: iso(now - 70_000), kind: 'main', directories: [] },
      u1,
      { $set: { lastUpdated: iso(now - 60_000) } },
      g1,
      { ...g1, toolCalls: [call('run_shell_command', 'success')] },
      'not json at all',
      { $set: { summary: 'Synthetic summary' } },
    ];
    t.applyLines(lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    assert.equal(t.meta.sessionId, sid(3));
    assert.equal(t.messages.length, 2, 'a re-appended id replaces in place');
    assert.equal(t.messages[1].toolCalls.length, 1);
    assert.equal(P.factsOf(t).title, 'Synthetic summary');
    assert.equal(P.factsOf(t).last.kind, 'tools');
    const g2 = msg.gemini('Done.', now - 40_000);
    const u2 = msg.user('Second prompt', now - 30_000);
    t.applyRecord(g2);
    t.applyRecord(u2);
    t.applyRecord({ $rewindTo: u2.id });
    assert.equal(P.factsOf(t).last.kind, 'reply', 'rewind drops the message and what follows');
    t.applyRecord({ $patch: { updates: [{ id: g2.id, content: [{ text: 'Patched. Ready?' }] }] } });
    assert.equal(P.factsOf(t).replyText, 'Patched. Ready?');
    t.applyRecord({ $patch: { orderIds: [g2.id, u1.id, g1.id] } });
    assert.deepEqual(t.messages.map(m => m.id), [g2.id, u1.id, g1.id]);
    t.applyRecord({ $patch: { removeIds: [g2.id] } });
    assert.deepEqual(t.messages.map(m => m.id), [u1.id, g1.id]);
    t.applyRecord({ $set: { messages: [u2] } });
    assert.equal(t.messages.length, 1);
  });
});

// --- processes -----------------------------------------------------------------

describe('Gemini CLI processes', () => {
  const NODE = '/opt/homebrew/Cellar/node/24.0.0/bin/node';

  test('ps elapsed times', () => {
    assert.equal(PR.parseEtime('05'), null);
    assert.equal(PR.parseEtime('01:05'), 65);
    assert.equal(PR.parseEtime('2:01:05'), 7265);
    assert.equal(PR.parseEtime('3-02:01:05'), 3 * 86400 + 7265);
    assert.equal(PR.parseEtime('soon'), null);
  });

  test('Gemini CLI command lines, with their approval mode', () => {
    const cases = [
      [`${NODE} --no-warnings=DEP0040 /opt/homebrew/bin/gemini`, true, null],
      [`node --max-old-space-size=8192 /opt/homebrew/bin/gemini --yolo`, true, 'yolo'],
      [`node /usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js --approval-mode=plan`, true, 'plan'],
      [`node /Users/you/.npm/_npx/x/node_modules/@google/gemini-cli/dist/index.js --approval-mode auto_edit`, true, 'auto_edit'],
      [`node /opt/homebrew/bin/gemini -y`, true, 'yolo'],
      [`node /opt/homebrew/bin/gemini --approval-mode bogus`, true, null],
      [`node /Users/you/server.js gemini`, false, null],
      [`/usr/bin/vim gemini`, false, null],
      [`/bin/zsh -c gemini`, false, null],
      [`node`, false, null],
    ];
    for (const [line, gemini, mode] of cases) {
      assert.deepEqual(PR.inspectCommand(line), { gemini, approvalMode: mode }, line);
    }
  });

  test('instances group the relaunched child and find tool children', () => {
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    const ps = [
      `  101     1   10:00 ${NODE} --no-warnings=DEP0040 /opt/homebrew/bin/gemini --yolo`,
      `  102   101   09:59 ${NODE} --max-old-space-size=8192 /opt/homebrew/bin/gemini --yolo`,
      `  103   102   09:58 node /Users/you/mcp-server.js`,
      `  104   102   00:07 bash -c npm test`,
      `  201     1 1-00:00:00 node /usr/local/bin/gemini`,
      `  301     1   00:30 node /Users/you/other.js`,
      `garbage line`,
    ].join('\n');
    const rows = PR.parsePs(ps, now);
    assert.equal(rows.length, 6);
    const instances = PR.findInstances(rows);
    assert.equal(instances.length, 2);
    const [a, b] = instances;
    assert.deepEqual(a.pids, [101, 102]);
    assert.equal(a.startedAt, now - 600_000);
    assert.equal(a.approvalMode, 'yolo');
    assert.equal(a.toolChildAt, now - 7_000);
    assert.deepEqual(b.pids, [201]);
    assert.equal(b.toolChildAt, null);
    assert.equal(b.startedAt, now - 86_400_000);
  });

  test('lsof output', () => {
    const map = PR.parseLsof('p101\nfcwd\nn/Users/you/work/demo app\np201\nfcwd\nn/Users/you/项目\n');
    assert.equal(map.get(101), '/Users/you/work/demo app');
    assert.equal(map.get(201), '/Users/you/项目');
  });

  test('the probe runs ps and lsof without a shell and caches folders', async () => {
    const calls = [];
    let ps = `  101     1   10:00 node /opt/homebrew/bin/gemini\n  102   101   09:59 node /opt/homebrew/bin/gemini\n`;
    const run = async (file, args) => {
      calls.push([file, args]);
      if (file === '/bin/ps') return { stdout: ps, ok: true };
      if (file === '/usr/sbin/lsof') return { stdout: 'p101\nfcwd\nn/Users/you/work\n', ok: false };
      throw new Error('unexpected command');
    };
    const probe = PR.createProcessProbe({ platform: 'darwin', run, now: () => Date.parse('2026-10-05T12:00:00Z') });
    const first = await probe();
    assert.equal(first.length, 1);
    assert.equal(first[0].cwd, '/Users/you/work');
    assert.deepEqual(calls[0], ['/bin/ps', ['-axww', '-o', 'pid=,ppid=,etime=,command=']]);
    assert.deepEqual(calls[1], ['/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', '101']]);
    await probe();
    assert.equal(calls.filter(([file]) => file === '/usr/sbin/lsof').length, 1, 'cwd cached');
    ps = '';
    assert.deepEqual(await probe(), []);
    assert.equal(await PR.createProcessProbe({ platform: 'win32', run })(), null);
    const failing = PR.createProcessProbe({ platform: 'darwin', run: async () => ({ stdout: '', ok: false }) });
    assert.equal(await failing(), null);
    const linux = PR.createProcessProbe({
      platform: 'linux',
      run: async () => ({ stdout: '  7  1  01:00 node /home/you/.local/bin/gemini\n', ok: true }),
      readCwd: async pid => (pid === 7 ? '/home/you/app' : null),
    });
    assert.equal((await linux())[0].cwd, '/home/you/app');
  });
});

// --- finding the CLI -----------------------------------------------------------

describe('Gemini CLI program', () => {
  test('setting first (no search), then PATH and the usual folders', () => {
    const exists = new Set(['/Users/you/.nvm/versions/node/v22.3.0/bin/gemini', '/Users/you/bin/my-gemini']);
    const search = {
      home: HOME,
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: file => exists.has(file),
      listDir: dir => (dir === '/Users/you/.nvm/versions/node' ? ['v20.11.1', 'v22.3.0'] : []),
    };
    assert.equal(CLI.findGeminiCli({ ...search, setting: null }), '/Users/you/.nvm/versions/node/v22.3.0/bin/gemini');
    assert.equal(CLI.findGeminiCli({ ...search, setting: '/Users/you/bin/my-gemini' }), '/Users/you/bin/my-gemini');
    assert.equal(CLI.findGeminiCli({ ...search, setting: '/Users/you/bin/missing' }), null);
    const dirs = CLI.cliFolders({ ...search, setting: null });
    assert.deepEqual(dirs.slice(0, 4), ['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']);
    assert.ok(dirs.indexOf('/Users/you/.nvm/versions/node/v22.3.0/bin') < dirs.indexOf('/Users/you/.nvm/versions/node/v20.11.1/bin'));
    const win = CLI.cliFolders({ home: 'C:\\Users\\you', platform: 'win32', env: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\you\\AppData\\Roaming' }, setting: null, listDir: () => [] });
    assert.ok(win.includes('C:\\Users\\you\\AppData\\Roaming\\npm'));
    assert.equal(CLI.findGeminiCli({ home: HOME, platform: 'linux', env: { PATH: '' }, isExecutable: () => false, listDir: () => [], setting: null }), null);
  });
});

// --- the monitor on a synthetic Gemini home ------------------------------------

function makeHome() {
  const home = fs.mkdtempSync(path.join(empty, 'home-'));
  fs.mkdirSync(path.join(home, 'tmp', 'bin'), { recursive: true });
  return home;
}

function project(home, dirName, root) {
  const dir = path.join(home, 'tmp', dirName);
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  if (root) fs.writeFileSync(path.join(dir, '.project_root'), root);
  fs.writeFileSync(path.join(dir, 'logs.json'), '[]');
  return dir;
}

function sessionName(born, id, ext = 'json') {
  return `session-${iso(born).slice(0, 16).replace(':', '-')}-${id.slice(0, 8)}.${ext}`;
}

function writeSession(dir, { id, born, messages, kind, summary, mtime, name }) {
  const file = path.join(dir, 'chats', name ?? sessionName(born, id));
  fs.writeFileSync(file, documentOf({ id, start: born, messages, kind, summary }));
  const at = (mtime ?? (messages.length ? Date.parse(messages[messages.length - 1].timestamp) : born)) / 1000;
  fs.utimesSync(file, at, at);
  return file;
}

function monitor(home, extra = {}) {
  return new M.GeminiSessionMonitor({
    home,
    onChange: () => undefined,
    probe: null,
    cliInstalled: () => true,
    platform: 'darwin',
    watch: false,
    ...extra,
  });
}

describe('Gemini session monitor', () => {
  test('filter spelling', () => {
    assert.equal(M.filterKey(' My_App '), 'my-app');
    assert.equal(M.filterKey('/Users/you/工作/项目 一'), 'users-you-工作-项目-一');
    assert.equal(M.filterKey(''), '');
    assert.deepEqual(M.parseSessionName('session-2026-10-05T09-00-11111111.json'), {
      base: 'session-2026-10-05T09-00-11111111',
      format: 'json',
      bornAt: Date.UTC(2026, 9, 5, 9, 0),
      id8: '11111111',
    });
    assert.equal(M.parseSessionName('session-x.jsonl').format, 'jsonl');
    assert.equal(M.parseSessionName('logs.json'), null);
  });

  test('picks the latest session, names projects by folder, dedupes copies', async () => {
    const now = Date.now();
    const home = makeHome();
    const rootA = path.join(empty, 'work', 'my_app');
    const rootB = path.join(empty, 'work', '项目');
    const a = project(home, 'my-app', rootA);
    // CJK folders all get slug "project": the name comes from .project_root
    const b = project(home, 'project', rootB);
    // an old hash-named folder with a copy of the same file
    const legacy = project(home, createHash('sha256').update(rootA).digest('hex'), null);
    const doneMsgs = [msg.user('Add a unit test', now - 20 * MIN), msg.gemini('Done.', now - 19 * MIN)];
    writeSession(a, { id: sid(1), born: now - 20 * MIN, messages: doneMsgs });
    writeSession(legacy, { id: sid(1), born: now - 20 * MIN, messages: doneMsgs, mtime: now - 30 * MIN });
    writeSession(b, { id: sid(2), born: now - 10 * MIN, messages: [msg.user('重构解析器', now - 3 * MIN), msg.gemini('好的。还需要别的吗？', now - 2 * MIN)] });
    // a 0.36 subagent file: same id prefix as its parent, kind subagent
    writeSession(b, { id: sid(2), born: now - MIN, kind: 'subagent', messages: [msg.user('subagent task', now - 30_000), msg.gemini('sub', now - 20_000)], name: sessionName(now - MIN, sid(2)).replace('.json', '-sub.json') });
    fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { [rootA]: 'my-app', [rootB]: 'project' } }));

    let changes = 0;
    const mon = monitor(home, { onChange: () => changes++ });
    mon.setFilters(['', 'my_app', '项目']);
    await mon.rescan();
    assert.ok(changes >= 1);
    const all = mon.getStatus('', now, 15 * MIN);
    assert.equal(all.status.project, '项目');
    assert.equal(all.status.title, '重构解析器');
    assert.equal(all.status.state, 'done');
    assert.equal(all.status.hasQuestion, true);
    assert.equal(all.others, 0);
    const mine = mon.getStatus('my_app', now, 60 * MIN);
    assert.equal(mine.status.project, 'my_app');
    assert.equal(mine.status.state, 'done');
    assert.equal(mon.getStatus('nothing-like-this', now, 15 * MIN).status, null);
    const list = mon.listRunning('', now, 60 * MIN);
    assert.equal(list.length, 2, 'copies and subagents are not listed');
    assert.deepEqual(list.map(r => r.status.project).sort(), ['my_app', '项目']);
    assert.equal(mon.notice(), null);
    mon.stop();
  });

  test('live CLIs: running sessions, stopped ones, new ones without a file', async () => {
    const now = Date.now();
    const home = makeHome();
    const root = path.join(empty, 'live', 'demo-app');
    const other = path.join(empty, 'live', 'other app');
    const dir = project(home, 'demo-app', root);
    // CLI 1 started 30 min ago; its session (born 25 min ago) waits for the model
    writeSession(dir, { id: sid(1), born: now - 25 * MIN, messages: [msg.user('Long task', now - 3 * MIN)] });
    // an older session of the same folder, from a CLI that is gone
    writeSession(dir, { id: sid(2), born: now - 120 * MIN, messages: [msg.user('Killed mid-turn', now - 5 * MIN)] });
    let instances = [
      { pids: [101, 102], startedAt: now - 30 * MIN, cwd: root, approvalMode: null, toolChildAt: now - 29 * MIN },
      { pids: [201, 202], startedAt: now - 2 * MIN, cwd: other, approvalMode: null, toolChildAt: null },
    ];
    let probes = 0;
    let clock = now;
    const mon = monitor(home, { probe: async () => (probes++, instances), now: () => clock });
    mon.setFilters(['']);
    mon.setRunningWindow(15 * MIN);
    await mon.rescan();
    assert.equal(probes, 1);
    const list = mon.listRunning('', now, 15 * MIN, { lang: 'en' });
    const byTitle = Object.fromEntries(list.map(r => [r.status.title, r]));
    assert.equal(byTitle['Long task'].status.state, 'working');
    assert.equal(byTitle['Long task'].status.live, true);
    assert.equal(byTitle['Long task'].group, 'working');
    assert.equal(byTitle['Killed mid-turn'].status.state, 'interrupted');
    assert.equal(byTitle['Killed mid-turn'].group, 'stopped');
    assert.equal(byTitle['New session'].status.project, 'other app');
    assert.equal(byTitle['New session'].status.state, 'idle');
    assert.equal(byTitle['New session'].group, 'done');
    assert.equal(mon.listRunning('', now, 15 * MIN, { lang: 'zh' }).some(r => r.status.title === '新会话'), true);
    // a key for the new CLI's folder shows it instead of "No sessions"
    mon.setFilters(['', 'other app']);
    const fresh = mon.getStatus('other app', now, 15 * MIN, { lang: 'en' });
    assert.equal(fresh.status.title, 'New session');
    assert.equal(fresh.status.live, true);
    // live detection off for a key: files only
    const filesOnly = mon.listRunning('', now, 15 * MIN, { liveDetection: false });
    assert.equal(filesOnly.some(r => r.status.title === 'New session'), false);
    assert.equal(filesOnly.find(r => r.status.title === 'Killed mid-turn').status.state, 'working');
    assert.equal(mon.getStatus('other app', now, 15 * MIN, { liveDetection: false }).status, null);
    // the CLI exits: its session counts as stopped after the grace period
    instances = [];
    clock += 3_000;
    await mon.rescan();
    const later = mon.listRunning('', now, 15 * MIN);
    assert.equal(later.find(r => r.status.title === 'Long task').status.state, 'interrupted');
    // the folder of a CLI is unknown: no verdict for sessions without a CLI
    instances = [{ pids: [301], startedAt: now - MIN, cwd: null, approvalMode: null, toolChildAt: null }];
    clock += 3_000;
    await mon.rescan();
    assert.equal(mon.listRunning('', now, 15 * MIN).find(r => r.status.title === 'Long task').status.state, 'working');
    mon.stop();
  });

  test('a /clear leaves the old session; a resumed one is matched by its write', async () => {
    const now = Date.now();
    const home = makeHome();
    const root = path.join(empty, 'clear', 'app');
    const dir = project(home, 'app', root);
    writeSession(dir, { id: sid(1), born: now - 20 * MIN, messages: [msg.user('Before clear', now - 15 * MIN)] });
    writeSession(dir, { id: sid(2), born: now - 10 * MIN, messages: [msg.user('After clear', now - MIN)] });
    // an old session, resumed by a second CLI that started 5 minutes ago
    writeSession(dir, { id: sid(3), born: now - 300 * MIN, messages: [msg.user('Resumed', now - 2 * MIN)] });
    const instances = [
      { pids: [101], startedAt: now - 21 * MIN, cwd: root, approvalMode: null, toolChildAt: null },
      { pids: [201], startedAt: now - 5 * MIN, cwd: root, approvalMode: null, toolChildAt: null },
    ];
    const mon = monitor(home, { probe: async () => instances });
    mon.setRunningWindow(30 * MIN);
    await mon.rescan();
    const list = mon.listRunning('', now, 30 * MIN);
    const state = title => list.find(r => r.status.title === title)?.status;
    assert.equal(state('After clear').live, true);
    assert.equal(state('Resumed').live, true);
    assert.equal(state('Before clear').live, false);
    assert.equal(state('Before clear').state, 'interrupted');
    mon.stop();
  });

  test('JSONL sessions and subagent folders', async () => {
    const now = Date.now();
    const home = makeHome();
    const dir = project(home, 'jsonl-app', path.join(empty, 'jl', 'jsonl-app'));
    const id = sid(4);
    const file = path.join(dir, 'chats', sessionName(now - 10 * MIN, id, 'jsonl'));
    const u = msg.user('Edit the parser', now - 2 * MIN);
    const g = msg.gemini('', now - 90_000);
    fs.writeFileSync(file, [
      { sessionId: id, projectHash: '0'.repeat(64), startTime: iso(now - 10 * MIN), lastUpdated: iso(now - 10 * MIN), kind: 'main' },
      u,
      g,
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const mon = monitor(home);
    await mon.rescan();
    let s = mon.getStatus('', now, 15 * MIN).status;
    assert.equal(s.state, 'permission');
    assert.equal(s.confident, false);
    // a subagent of this session writes: busy
    fs.mkdirSync(path.join(dir, 'chats', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chats', id, `${sid(5)}.jsonl`), '{}\n');
    await mon.rescan();
    assert.equal(mon.getStatus('', Date.now(), 15 * MIN).status.state, 'working');
    // appended lines are read incrementally; a partial last line waits
    fs.appendFileSync(file, JSON.stringify({ ...g, toolCalls: [call('replace', 'success')] }) + '\n' + JSON.stringify(msg.gemini('Edited. Anything else?', now)) + '\n{"partial":');
    await mon.rescan();
    s = mon.getStatus('', now + 60_000, 15 * MIN).status;
    assert.equal(s.state, 'done');
    assert.equal(s.hasQuestion, true);
    mon.stop();
  });

  test('a half-written 0.36 file keeps the last good state', async () => {
    const now = Date.now();
    const home = makeHome();
    const dir = project(home, 'half', path.join(empty, 'half'));
    const file = writeSession(dir, { id: sid(6), born: now - 5 * MIN, messages: [msg.user('Go', now - 2 * MIN), msg.gemini('Gone.', now - MIN)] });
    const mon = monitor(home);
    await mon.rescan();
    assert.equal(mon.getStatus('', now, 15 * MIN).status.state, 'done');
    const full = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, full.slice(0, 200));
    await mon.rescan();
    assert.equal(mon.getStatus('', now, 15 * MIN).status.state, 'done');
    mon.stop();
  });

  test('a started monitor follows new files through its watcher', async () => {
    const now = Date.now();
    const home = makeHome();
    const dir = project(home, 'watched', path.join(empty, 'watched'));
    writeSession(dir, { id: sid(8), born: now - 5 * MIN, messages: [msg.user('First', now - 2 * MIN), msg.gemini('Done.', now - MIN)] });
    let changes = 0;
    const mon = new M.GeminiSessionMonitor({ home, onChange: () => changes++, probe: null, cliInstalled: () => true });
    try {
      mon.start();
      for (let i = 0; i < 200 && changes === 0; i++) await sleep(10);
      assert.equal(mon.getStatus('', Date.now(), 15 * MIN).status.title, 'First');
      await sleep(200);
      writeSession(dir, { id: sid(9), born: now, messages: [msg.user('Second', Date.now())], mtime: Date.now() });
      // quicker than the 5 s poll: the watcher saw it
      let title = null;
      for (let i = 0; i < 45 && title !== 'Second'; i++) {
        await sleep(100);
        title = mon.getStatus('', Date.now(), 15 * MIN).status?.title ?? null;
      }
      assert.equal(title, 'Second');
    } finally {
      mon.stop();
    }
  });

  test('nothing to read: a notice only when the CLI is missing', async () => {
    const mon = monitor(path.join(empty, 'missing-home'), { cliInstalled: () => false, probe: async () => assert.fail('no probe without a Gemini home') });
    await mon.rescan();
    assert.equal(mon.getStatus('', Date.now(), 15 * MIN).status, null);
    assert.deepEqual(mon.notice(), { label: { en: 'No sessions', zh: '无会话' }, text: { en: 'Gemini CLI not found', zh: '未找到 Gemini CLI' } });
    const installed = monitor(path.join(empty, 'missing-home'), { cliInstalled: () => true });
    await installed.rescan();
    assert.equal(installed.notice(), null);
    const view = V.buildSessionView(null, { lang: 'zh', showProject: true, now: Date.now(), productName: GEMINI_BRAND.productName });
    assert.deepEqual([view.label, view.text], ['无会话', '启动 Gemini CLI']);
  });
});

// --- provider and key ----------------------------------------------------------

describe('Gemini session provider contract', () => {
  test('a source reports a change after start and answers queries', async () => {
    const location = S.sessionProvider.location(CONFIG);
    assert.equal(location, CONFIG.geminiDir);
    let changes = 0;
    const source = S.sessionProvider.create({
      location,
      config: CONFIG,
      onChange: () => changes++,
    });
    try {
      source.start();
      for (let i = 0; i < 100 && changes === 0; i++) await sleep(10);
      assert.ok(changes > 0, 'onChange after start');
      source.setFilters(['']);
      source.setRunningWindow(15 * 60_000);
      const pick = source.getStatus('', Date.now(), 15 * 60_000);
      assert.equal(pick.status, null, 'no sessions in an empty folder');
      assert.equal(typeof pick.others, 'number');
      assert.deepEqual(source.listRunning('', Date.now(), 15 * 60_000), []);
      await source.rescan();
      // geminiPath points nowhere: the CLI counts as missing
      assert.equal(source.notice().text.en, 'Gemini CLI not found');
    } finally {
      source.stop();
    }
  });

  test('describe answers the settings page', async () => {
    const reply = await S.sessionProvider.describe('', CONFIG);
    assert.equal(reply.success, false);
    for (const field of ['projectsDir', 'state', 'project', 'title', 'others']) {
      assert.ok(field in reply, field);
    }
    assert.equal(reply.projectsDir, path.join(CONFIG.geminiDir, 'tmp'));
    assert.equal(reply.notice.label.en, 'No sessions');

    const now = Date.now();
    const home = makeHome();
    const dir = project(home, 'described', path.join(empty, 'described'));
    writeSession(dir, { id: sid(7), born: now - 5 * MIN, messages: [msg.user('Describe me', now - 2 * MIN), msg.error('[API Error: synthetic]', now - MIN)] });
    const provider = S.createGeminiSessionProvider({ probe: () => null, cliInstalled: () => true });
    const found = await provider.describe('describ', { geminiDir: home }, { idleMinutes: 30 });
    assert.deepEqual(
      [found.success, found.state, found.project, found.title, found.others, found.notice],
      [true, 'error', 'described', 'Describe me', 0, null]
    );
  });

  test('the key draws faces and the running list', async () => {
    const now = Date.now();
    const home = makeHome();
    const dir = project(home, 'keyed', path.join(empty, 'keyed-app'));
    for (let i = 1; i <= 4; i++) {
      writeSession(dir, { id: sid(i), born: now - (10 + i) * MIN, messages: [msg.user(`Task number ${i}`, now - i * MIN)] });
    }
    const cid = Kit.keyCid('gemini', 'session');
    const hooks = drawHooks({ geminiDir: home });
    const provider = S.createGeminiSessionProvider({ probe: () => null, cliInstalled: () => true });
    const keys = new SessionKeys({ ...hooks.deps, provider: { cid, brand: GEMINI_BRAND, sessions: provider } });
    try {
      const key = { uid: 1, cid, width: 240, data: { lang: 'en', idleMinutes: 15 } };
      await keys.alive(SERIAL, [key, { uid: 2, cid, width: 60, data: { lang: 'zh' } }]);
      await sleep(100);
      await hooks.settle();
      assert.ok(hooks.sent.length >= 2);
      for (const [uid, image] of hooks.sent) {
        assert.deepEqual(pngSize(image), [uid === 1 ? 240 : 60, 60]);
      }
      const before = hooks.sent.length;
      await keys.press(SERIAL, key);
      await hooks.settle();
      assert.ok(hooks.sent.length > before, 'the press shows the list');
    } finally {
      await keys.dead(SERIAL, []);
    }
  });
});

// --- new session -----------------------------------------------------------------

describe('Gemini New Session launcher', () => {
  const request = (data, folder = null, platform = 'darwin') => ({
    data,
    rawFolder: folder ?? '',
    folder,
    home: HOME,
    platform,
  });
  const launcher = (extra = {}) =>
    NS.createGeminiLauncher({
      isDirectory: dir => dir === '/Users/you/work/demo app',
      findCli: () => '/opt/homebrew/bin/gemini',
      appInstalled: () => true,
      ...extra,
    });

  test('preset arguments only', () => {
    assert.deepEqual(NS.cliArgs({}), []);
    assert.deepEqual(NS.cliArgs({ resume: true, approvalMode: 'yolo' }), ['--resume', 'latest', '--approval-mode', 'yolo']);
    assert.deepEqual(NS.cliArgs({ approvalMode: 'default' }), []);
    assert.deepEqual(NS.cliArgs({ approvalMode: "yolo'; rm -rf ~; '", resume: 'yes' }), []);
    assert.equal(NS.targetOf({ target: 'gemini-app' }), 'gemini-app');
    assert.equal(NS.targetOf({ target: 'other' }), 'terminal-cli');
  });

  test('terminal target: the CLI in the folder (home when none)', () => {
    const l = launcher();
    assert.deepEqual(l.target(request({ approvalMode: 'plan' }, '/Users/you/work/demo app')), {
      kind: 'terminal',
      command: ['/opt/homebrew/bin/gemini', '--approval-mode', 'plan'],
      cwd: '/Users/you/work/demo app',
    });
    assert.deepEqual(l.target(request({})), { kind: 'terminal', command: ['/opt/homebrew/bin/gemini'], cwd: HOME });
  });

  test('failures carry their own key text', () => {
    const fails = (l, req, title) =>
      assert.throws(
        () => l.target(req),
        error => {
          assert.ok(error instanceof Kit.ProviderError);
          assert.equal(error.extra.keyText.en.title, title);
          assert.ok(!error.message.includes('/Users/you'), 'no path in the log text');
          return true;
        }
      );
    fails(launcher(), request({}, '/Users/you/missing'), 'Folder not found');
    fails(launcher({ findCli: () => null }), request({}), 'Gemini CLI not found');
    fails(launcher({ appInstalled: () => false }), request({ target: 'gemini-app' }), 'Gemini app not found');
    fails(launcher(), request({ target: 'gemini-app' }, null, 'linux'), 'Gemini app not found');
    assert.equal(NS.LAUNCH_ERRORS.cli.zh.title, '未找到 Gemini CLI');
  });

  test('app target: a new chat in the Gemini app', () => {
    assert.deepEqual(launcher().target(request({ target: 'gemini-app' }, '/Users/you/work/demo app')), {
      kind: 'url',
      url: 'googlegemini://newchat',
    });
  });

  test('the script for Terminal quotes every word', async () => {
    const writes = [];
    const runs = [];
    const open = L.createTerminalOpener({
      platform: 'darwin',
      tmpDir: path.join(empty, 'scripts'),
      writeFile: async (file, data, mode) => writes.push({ file, data, mode }),
      unlink: async () => undefined,
      run: async command => runs.push(command),
    });
    const target = launcher({ isDirectory: () => true }).target(request({ resume: true }, "/Users/you/it's here"));
    await open(target.command, target.cwd);
    assert.equal(writes[0].mode, 0o700);
    assert.equal(
      writes[0].data,
      "#!/bin/sh\nrm -f -- \"$0\"\ncd -- '/Users/you/it'\\''s here' || { echo 'Folder not found'; exit 1; }\nexec '/opt/homebrew/bin/gemini' '--resume' 'latest'\n"
    );
    assert.deepEqual(runs[0], { file: '/usr/bin/open', args: ['-a', 'Terminal', writes[0].file] });
  });

  test('a key press opens the terminal target through the key group stubs', async () => {
    const cid = Kit.keyCid('gemini', 'newsession');
    const hooks = drawHooks();
    const opened = [];
    const keys = new NewSessionKeys({
      ...hooks.deps,
      provider: { cid, brand: GEMINI_BRAND, launcher: launcher({ isDirectory: () => true }) },
      launch: async url => opened.push(['url', url]),
      run: async command => opened.push(['run', command]),
      terminal: async (command, cwd) => opened.push(['terminal', command, cwd]),
      home: HOME,
      platform: 'darwin',
      timings: { openingMs: 5, errorMs: 5 },
    });
    const key = { uid: 1, cid, width: 120, data: { folder: '~/work/demo-app', lang: 'en' } };
    await keys.alive(SERIAL, [key]);
    assert.equal(await keys.press(SERIAL, key), true);
    await hooks.settle();
    assert.deepEqual(opened, [['terminal', ['/opt/homebrew/bin/gemini'], '/Users/you/work/demo-app']]);
    for (const [, image] of hooks.sent) assert.deepEqual(pngSize(image), [120, 60]);
    await keys.dead(SERIAL, []);
  });

  test('the shipped launcher fails cleanly for a missing folder, launching nothing', async () => {
    const cid = Kit.keyCid('gemini', 'newsession');
    const hooks = drawHooks();
    const opened = [];
    const keys = new NewSessionKeys({
      ...hooks.deps,
      provider: { cid, brand: GEMINI_BRAND, launcher: NS.newSessionLauncher },
      launch: async url => opened.push(['url', url]),
      run: async command => opened.push(['run', command]),
      terminal: async (command, cwd) => opened.push(['terminal', command, cwd]),
      home: '/Users/you',
      platform: 'darwin',
      timings: { openingMs: 5, errorMs: 5 },
    });
    const key = { uid: 1, cid, width: 120, data: { folder: '~/work/demo-app' } };
    await keys.alive(SERIAL, [key]);
    assert.equal(await keys.press(SERIAL, key), false);
    await hooks.settle();
    assert.deepEqual(opened, []);
    assert.equal(NS.newSessionLauncher.appName, 'Gemini CLI');
    await keys.dead(SERIAL, []);
  });
});
