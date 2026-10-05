// Tests for the Kimi session source and New Session launcher
// (src/providers/kimi/session*.ts, newSession.ts), run against the tsc output
// of `npm run test:kimi-session` (.test-build-kimi-session/).
// Rules: synthetic fixtures only (see CLAUDE.md), never read the real home
// folder (HOME points at an empty temp folder), never open a link, a
// terminal or an app: every launcher below is a stub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-session-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
for (const name of ['KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'KIMI_INSTALL_DIR']) {
  delete process.env[name];
}
globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};
after(() => fs.rmSync(empty, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.KIMI_SESSION_TEST_BUILD ??
  path.join(here, '..', '.test-build-kimi-session');
const req = p => require(path.join(build, p));
const S = req('providers/kimi/session.js');
const Src = req('providers/kimi/sessionSource.js');
const W = req('providers/kimi/sessionWire.js');
const D = req('providers/kimi/sessionDesktop.js');
const F = req('providers/kimi/sessionFs.js');
const NS = req('providers/kimi/newSession.js');
const Kit = req('providers/kit.js');
const View = req('sessionView.js');
const Launch = req('launch.js');
const { SessionKeys } = req('sessionKey.js');
const { NewSessionKeys } = req('newSessionKey.js');
const { KIMI_BRAND } = req('providers/kimi/brand.js');

const SERIAL = 'FAKE-DEVICE-1';
const MIN = 60_000;
const IDLE = 15 * MIN;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const convKey = n => `agent:main:main:conversation:${uuid(n)}`;
// built at runtime, so the source never holds a token-shaped literal
const FAKE_TOKEN = ['loop', 'back', '-', 'f'.repeat(24)].join('');

let fixtureCount = 0;
function tmp(name) {
  const dir = path.join(empty, `${name}-${++fixtureCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

function writeLines(file, records, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

// --- journal records (synthetic) ------------------------------------------------

const R = {
  meta: (version = '1.5', t = 0) => ({ type: 'metadata', protocol_version: version, created_at: t }),
  prompt: t => ({
    type: 'turn.prompt',
    agentId: 'main',
    input: [{ type: 'text', text: 'synthetic prompt' }],
    origin: { kind: 'user' },
    turnId: 1,
    time: t,
  }),
  loop: (event, t) => ({ type: 'context.append_loop_event', event, time: t }),
  step: t => R.loop({ type: 'step.begin', uuid: 's', turnId: '1', step: 1 }, t),
  text: (text, t) =>
    R.loop({ type: 'content.part', turnId: '1', step: 1, part: { type: 'text', text } }, t),
  call: (id, name, args, t) =>
    R.loop({ type: 'tool.call', turnId: '1', step: 1, toolCallId: id, name, args }, t),
  result: (id, t) => R.loop({ type: 'tool.result', toolCallId: id, result: {} }, t),
  stepEnd: (finishReason, t) =>
    R.loop({ type: 'step.end', turnId: '1', step: 1, finishReason }, t),
  ended: (reason, t, error) => ({
    type: 'turn.ended',
    agentId: 'main',
    turnId: 1,
    reason,
    ...(error ? { error: { message: error } } : {}),
    time: t,
  }),
  cancel: (t, target) => ({ type: 'turn.cancel', agentId: 'main', ...(target ? { target } : {}), time: t }),
  ask: (id, question, t) => ({
    type: 'interaction.request',
    agentId: 'main',
    id,
    kind: 'question',
    request: { questions: [{ question, options: [{ label: 'Yes' }, { label: 'No' }] }] },
    time: t,
  }),
  approve: (id, toolName, toolCallId, t) => ({
    type: 'interaction.request',
    agentId: 'main',
    id,
    kind: 'approval',
    toolCallId,
    request: { toolName, action: 'run', display: {} },
    time: t,
  }),
  resolved: (id, t) => ({ type: 'interaction.resolved', agentId: 'main', id, response: {}, time: t }),
  mode: (mode, t) => ({ type: 'permission.set_mode', mode, time: t }),
};

function derive(records, now, idleMs = IDLE) {
  const acc = W.createWireAcc();
  for (const r of records) W.observeWireRecord(acc, r);
  return W.deriveWireStatus(acc, { now, idleMs });
}

// --- CLI fixture ------------------------------------------------------------------

function cliSession(home, n, { wd = 'wd_demo-app_000000000000', state = {}, wire, mtime, agents } = {}) {
  const dir = path.join(home, 'sessions', wd, `session_${uuid(n)}`);
  const at = mtime ?? Date.now();
  writeJson(
    path.join(dir, 'state.json'),
    {
      id: `session_${uuid(n)}`,
      version: 2,
      title: `Synthetic task ${n}`,
      titleKind: 'generated',
      lastPrompt: 'synthetic prompt',
      createdAt: at - 10 * MIN,
      updatedAt: at,
      archived: false,
      cwd: '/Users/you/code/demo-app',
      agents: { main: { type: 'main' } },
      custom: {},
      ...state,
    },
    at
  );
  if (wire) writeLines(path.join(dir, 'agents', 'main', 'wire.jsonl'), wire, at);
  for (const [name, records] of Object.entries(agents ?? {})) {
    writeLines(path.join(dir, 'agents', name, 'wire.jsonl'), records, at);
  }
  return dir;
}

// --- desktop fixture --------------------------------------------------------------

function desktopFixture(root, spec = {}) {
  const agent = path.join(root, 'kimi-agent');
  const daimon = path.join(root, 'daimon-share', 'daimon');
  const now = Date.now();
  writeJson(path.join(agent, 'conversation-statuses.json'), spec.statuses ?? {});
  if (spec.titles) writeJson(path.join(agent, 'conversation-titles.json'), spec.titles);
  if (spec.archive) writeJson(path.join(agent, 'conversation-archive.json'), spec.archive);
  if (spec.unread) writeJson(path.join(agent, 'conversation-unread.json'), spec.unread);
  if (spec.projects) writeJson(path.join(agent, 'conversation-projects.json'), spec.projects);
  const context = {};
  for (const [key, at] of Object.entries(spec.times ?? {})) {
    context[key] = { contextUsage: 0.25, model: 'k3', updatedAt: new Date(at).toISOString() };
  }
  writeJson(path.join(agent, 'conversation-context-usage.json'), context);
  const generation = spec.generation ?? 'gen-1';
  if (spec.daemon !== 'none') {
    writeJson(path.join(daimon, 'agents', 'main', 'runner.lock', 'owner.json'), {
      schemaVersion: 1,
      pid: 999_999,
      hostname: 'FAKE-HOST',
      generationId: generation,
      heartbeatAt: new Date(spec.daemon === 'dead' ? now - 20 * MIN : now - 10_000).toISOString(),
    });
  }
  writeJson(path.join(daimon, 'agents', 'main', 'runner.state.json'), {
    schemaVersion: 1,
    daemonGeneration: { generationId: spec.runnerGeneration ?? generation, hostname: 'FAKE-HOST' },
    lifecycleStatus: 'running',
    control: { endpoint: { auth: { token: FAKE_TOKEN } } },
    kernel: { status: 'active' },
    activeOperations: spec.operations ?? [],
    activeKernelTurns: spec.turns ?? [],
    activePendingInteractions: spec.interactions ?? [],
    recentKernelEvents: [],
    updatedAt: new Date(now).toISOString(),
  });
  for (const [n, kernel] of Object.entries(spec.kernel ?? {})) {
    const dir = path.join(daimon, 'runtime', 'kimi-code', 'home', 'sessions', 'wd_tasks_000000000000', `conv-${String(n).padStart(16, '0')}`);
    writeJson(path.join(dir, 'state.json'), {
      createdAt: new Date(now - 30 * MIN).toISOString(),
      updatedAt: new Date(kernel.updatedAt ?? now).toISOString(),
      title: kernel.title ?? 'synthetic first prompt',
      isCustomTitle: false,
      custom: {
        sessionKind: 'conversation',
        conversationKey: convKey(Number(n)),
        workTag: kernel.workTag ?? 'normal',
        workspacePath: '/Users/you/Documents/kimi/tasks/demo',
      },
      workDir: '/Users/you/Documents/kimi/tasks/demo',
    });
    if (kernel.wire) writeLines(path.join(dir, 'agents', 'main', 'wire.jsonl'), kernel.wire);
  }
  // a title-generation kernel session: never a task
  const ctitle = path.join(daimon, 'runtime', 'kimi-code', 'home', 'sessions', 'wd_tasks_000000000000', `ctitle-${uuid(99)}`);
  writeJson(path.join(ctitle, 'state.json'), { title: 'title job', custom: { sessionKind: 'conversation-title' } });
  return { agent, daimon };
}

function sqliteRows(root, rows) {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite?.DatabaseSync) return false;
  const dir = path.join(root, 'daimon-share', 'daimon', 'agents', 'main', 'sessions', 'hosted-logical');
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'conversations.sqlite'));
  db.exec(`CREATE TABLE conversations (agent_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
    title TEXT NOT NULL, title_status TEXT NOT NULL, work_tag TEXT, workspace_path TEXT,
    first_user_text TEXT, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (agent_id, conversation_key))`);
  const insert = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run('main', row.key, row.title, 'generated', row.workTag ?? 'normal', '/Users/you/Documents/kimi/tasks/demo', 'synthetic first prompt', row.updatedAt);
  }
  db.close();
  return true;
}

async function scan({ codeHome, desktopDir, logger, filters = [''], window = IDLE }) {
  const source = new Src.KimiSessionSource({
    codeHome: codeHome ?? path.join(empty, 'no-cli'),
    desktopDir: desktopDir ?? path.join(empty, 'no-desktop'),
    onChange: () => undefined,
    logger,
  });
  source.setFilters(filters);
  source.setRunningWindow(window);
  await source.rescan();
  source.stop();
  return source;
}

function face(status, lang = 'en', now = Date.now()) {
  return View.buildSessionView(status, { lang, showProject: true, now, productName: 'Kimi Code' });
}

// ===================================================================================

describe('journal (wire 1.5)', () => {
  const now = Date.now();
  const t = m => now - m * MIN;
  const start = [R.meta('1.5'), R.prompt(t(3)), R.step(t(3))];

  test('a running tool call is working, with the tool named', () => {
    const s = derive([...start, R.call('tc1', 'Bash', { command: 'npm test\nmore' }, t(2))], now);
    assert.equal(s.state, 'working');
    assert.equal(s.tool, 'Bash: npm test');
    assert.equal(s.since, t(3));
  });

  test('Kimi tool arguments: path, url', () => {
    assert.equal(W.describeKimiTool('Read', { file_path: '/Users/you/code/a/parser.ts' }), 'Read: parser.ts');
    const s = derive([...start, R.call('tc1', 'FetchURL', { url: 'https://example.com/x' }, t(2))], now);
    assert.equal(s.tool, 'FetchURL: example.com');
    const r = derive([...start, R.call('tc1', 'Read', { path: '/Users/you/code/a/main.ts' }, t(2))], now);
    assert.equal(r.tool, 'Read: main.ts');
  });

  test('an open question waits for the user, with its text and options', () => {
    const s = derive([...start, R.call('tc1', 'AskUserQuestion', {}, t(2)), R.ask('ia1', 'Which database?', t(2))], now);
    assert.equal(s.state, 'question');
    assert.equal(s.confident, true);
    assert.equal(s.question, 'Which database?');
    assert.deepEqual(s.options, ['Yes', 'No']);
    assert.equal(s.since, t(2));
  });

  test('ExitPlanMode approval is a plan; other approvals ask for permission', () => {
    assert.equal(derive([...start, R.approve('ia1', 'ExitPlanMode', 'tc1', t(1))], now).state, 'plan');
    const s = derive([...start, R.call('tc1', 'Bash', { command: 'rm -rf build' }, t(2)), R.approve('ia1', 'Bash', 'tc1', t(2))], now);
    assert.equal(s.state, 'permission');
    assert.equal(s.confident, true);
    assert.equal(s.tool, 'Bash: rm -rf build');
  });

  test('a resolved approval goes back to working', () => {
    const s = derive([...start, R.call('tc1', 'Bash', {}, t(2)), R.approve('ia1', 'Bash', 'tc1', t(2)), R.resolved('ia1', t(1))], now);
    assert.equal(s.state, 'working');
  });

  test('turn ends: completed, with a trailing question, cancelled, failed', () => {
    assert.equal(derive([...start, R.text('All tests pass.', t(1)), R.ended('completed', t(1))], now).state, 'done');
    const asked = derive([...start, R.text('Done. Shall I also update the docs?', t(1)), R.ended('completed', t(1))], now);
    assert.equal(asked.state, 'done');
    assert.equal(asked.hasQuestion, true);
    assert.equal(face(asked).label, 'Asked you');
    assert.equal(derive([...start, R.cancel(t(1)), R.ended('cancelled', t(1))], now).state, 'interrupted');
    const failed = derive([...start, R.ended('failed', t(1), 'Rate limit exceeded')], now);
    assert.equal(failed.state, 'error');
    assert.equal(failed.detail, 'Rate limit exceeded');
    assert.equal(derive([...start, R.ended('blocked', t(1))], now).state, 'error');
  });

  test('a cancelled queued prompt does not stop the turn', () => {
    assert.equal(derive([...start, R.cancel(t(1), 'queued')], now).state, 'working');
  });

  test('time decay: done goes idle after idleMinutes, working after 30 min', () => {
    const old = m => now - m * MIN;
    assert.equal(derive([R.meta(), R.prompt(old(20)), R.ended('completed', old(20))], now).state, 'idle');
    assert.equal(derive([R.meta(), R.prompt(old(20)), R.ended('completed', old(20))], now, 60 * MIN).state, 'done');
    assert.equal(derive([R.meta(), R.prompt(old(40)), R.step(old(40))], now).state, 'idle');
    assert.equal(derive([R.meta(), R.prompt(old(40)), R.ask('q', 'Go?', old(40))], now).state, 'question');
  });

  test('no turn at all is idle', () => {
    assert.equal(derive([R.meta()], now).state, 'idle');
  });
});

describe('journal (older wire 1.x, desktop kernel)', () => {
  const now = Date.now();
  const t = m => now - m * MIN;
  const start = [R.meta('1.4'), R.prompt(t(3)), R.step(t(3))];

  test('step.end end_turn without open tools is done', () => {
    assert.equal(derive([...start, R.text('Finished.', t(1)), R.stepEnd('end_turn', t(1))], now).state, 'done');
  });

  test('tool_use with all results in: the model is working', () => {
    assert.equal(derive([...start, R.call('a', 'Bash', {}, t(2)), R.stepEnd('tool_use', t(2)), R.result('a', t(1))], now).state, 'working');
  });

  test('interrupted and error steps', () => {
    assert.equal(derive([...start, R.stepEnd('interrupted', t(1))], now).state, 'interrupted');
    assert.equal(derive([...start, R.stepEnd('error', t(1))], now).state, 'error');
  });

  test('a stalled call in manual mode is probably a permission prompt', () => {
    const records = [R.meta('1.4'), R.mode('manual', t(5)), R.prompt(t(3)), R.step(t(3)), R.call('a', 'Bash', { command: 'make' }, t(2))];
    const s = derive(records, now);
    assert.equal(s.state, 'permission');
    assert.equal(s.confident, false);
    assert.equal(face(s).label, 'Approval?');
    const yolo = [R.meta('1.4'), R.mode('yolo', t(5)), R.prompt(t(3)), R.call('a', 'Bash', {}, t(2))];
    assert.equal(derive(yolo, now).state, 'working');
    // wire 1.5 records approvals: never a guess
    const v15 = [R.meta('1.5'), R.mode('manual', t(5)), R.prompt(t(3)), R.call('a', 'Bash', {}, t(2))];
    assert.equal(derive(v15, now).state, 'working');
  });

  test('protocol versions compare numerically', () => {
    assert.equal(W.protocolOf('1.5'), 1005);
    assert.ok(W.protocolOf('1.10') > W.protocolOf('1.9'));
    assert.equal(W.protocolOf('x'), null);
  });

  test('invalid lines are skipped without throwing', () => {
    const acc = W.createWireAcc();
    W.observeWireLines(acc, `{"type":"turn.prompt","time":${t(1)}}\nnot json ${FAKE_TOKEN}\n{"type":`);
    assert.equal(acc.sawTurn, true);
  });
});

describe('Kimi Code CLI sessions', () => {
  test('states, titles and projects from the session folders', async () => {
    const home = tmp('cli');
    const now = Date.now();
    const t = m => now - m * MIN;
    cliSession(home, 1, { wire: [R.meta(), R.prompt(t(2)), R.step(t(2)), R.call('a', 'Bash', { command: 'npm test' }, t(1))], mtime: t(1) });
    cliSession(home, 2, {
      wd: 'wd_other_111111111111',
      state: { cwd: '/Users/you/code/other', title: '', lastPrompt: 'Make the parser test pass on CI' },
      wire: [R.meta(), R.prompt(t(5)), R.ended('completed', t(4))],
      mtime: t(4),
    });
    const source = await scan({ codeHome: home });
    const list = source.listRunning('', now, IDLE);
    assert.equal(list.length, 2);
    assert.equal(list[0].group, 'working');
    assert.equal(list[0].status.title, 'Synthetic task 1');
    assert.equal(list[0].status.project, 'demo-app');
    assert.equal(list[1].group, 'done');
    assert.equal(list[1].status.title, 'Make the parser test pass on CI', 'lastPrompt when no title');
    assert.equal(list[1].status.project, 'other');
    const pick = source.getStatus('', now, IDLE);
    assert.equal(pick.status.state, 'working');
    assert.equal(pick.others, 0);
  });

  test('attention wins over a more recent working session; others are counted', async () => {
    const home = tmp('cli');
    const now = Date.now();
    const t = m => now - m * MIN;
    cliSession(home, 1, { wire: [R.meta(), R.prompt(t(1)), R.step(t(1))], mtime: t(1) });
    cliSession(home, 2, { wire: [R.meta(), R.prompt(t(9)), R.ask('q', 'Deploy now?', t(8))], mtime: t(8) });
    cliSession(home, 3, { wire: [R.meta(), R.prompt(t(3)), R.step(t(3))], mtime: t(3) });
    const source = await scan({ codeHome: home });
    const pick = source.getStatus('', now, IDLE);
    assert.equal(pick.status.state, 'question');
    assert.equal(pick.status.question, 'Deploy now?');
    assert.equal(pick.others, 2);
    const groups = source.listRunning('', now, IDLE).map(r => r.group);
    assert.deepEqual(groups, ['attention', 'working', 'working']);
    const view = face(pick.status, 'zh');
    assert.equal(view.label, '待回答');
    assert.equal(view.tone, 'attention');
  });

  test('archived and child sessions are hidden; idle ones are not listed', async () => {
    const home = tmp('cli');
    const now = Date.now();
    const t = m => now - m * MIN;
    cliSession(home, 1, { state: { archived: true }, wire: [R.meta(), R.prompt(t(1))], mtime: t(1) });
    cliSession(home, 2, { state: { custom: { child_session_kind: 'child' } }, wire: [R.meta(), R.prompt(t(1))], mtime: t(1) });
    cliSession(home, 3, { wire: [R.meta(), R.prompt(t(50)), R.ended('completed', t(50))], mtime: t(50) });
    const source = await scan({ codeHome: home });
    assert.deepEqual(source.listRunning('', now, IDLE), []);
    const pick = source.getStatus('', now, IDLE);
    assert.equal(pick.status.state, 'idle');
    assert.equal(pick.status.title, 'Synthetic task 3');
  });

  test('state.json lastTurnReason ends a turn the journal tail does not', async () => {
    const home = tmp('cli');
    const now = Date.now();
    const t = m => now - m * MIN;
    cliSession(home, 1, {
      state: { lastTurnReason: 'cancelled', updatedAt: t(1) },
      wire: [R.meta(), R.prompt(t(3)), R.step(t(3))],
      mtime: t(1),
    });
    const source = await scan({ codeHome: home });
    assert.equal(source.getStatus('', now, IDLE).status.state, 'interrupted');
  });

  test('a sub-agent waiting for approval shows on the session', async () => {
    const home = tmp('cli');
    const now = Date.now();
    const t = m => now - m * MIN;
    cliSession(home, 1, {
      wire: [R.meta(), R.prompt(t(3)), R.call('a', 'Agent', { description: 'Review code' }, t(3))],
      agents: { 'agent-0': [R.meta(), R.prompt(t(3)), R.call('b', 'Bash', { command: 'git push' }, t(2)), R.approve('ia', 'Bash', 'b', t(2))] },
      mtime: t(2),
    });
    const source = await scan({ codeHome: home });
    const s = source.getStatus('', now, IDLE).status;
    assert.equal(s.state, 'permission');
    assert.equal(s.tool, 'Bash: git push');
  });

  test('project filter: part of the path, spaces match dashes', async () => {
    const home = tmp('cli');
    const now = Date.now();
    cliSession(home, 1, { wire: [R.meta(), R.prompt(now - MIN)], mtime: now - MIN });
    cliSession(home, 2, { wd: 'wd_other_111111111111', state: { cwd: '/Users/you/code/other' }, wire: [R.meta(), R.prompt(now - MIN)], mtime: now - MIN });
    const source = await scan({ codeHome: home, filters: ['demo app', 'OTHER'] });
    assert.equal(source.getStatus('demo app', now, IDLE).status.project, 'demo-app');
    assert.equal(source.getStatus('OTHER', now, IDLE).status.project, 'other');
    assert.equal(source.getStatus('missing', now, IDLE).status, null);
    assert.equal(F.matchesFilter('', ['x']), true);
    assert.equal(F.matchesFilter('项目', ['/Users/you/项目/a']), true);
  });

  test('a session without a journal falls back to state.json', async () => {
    const home = tmp('cli');
    const now = Date.now();
    cliSession(home, 1, { state: { lastTurnReason: 'failed', updatedAt: now - MIN }, mtime: now - MIN });
    const source = await scan({ codeHome: home });
    assert.equal(source.getStatus('', now, IDLE).status.state, 'error');
  });
});

describe('Kimi desktop (Kimi Work) tasks', () => {
  test('statuses map to working, done, error; titles and projects', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    desktopFixture(root, {
      statuses: { [convKey(1)]: 'running', [convKey(2)]: 'completed', [convKey(3)]: 'blocked' },
      titles: { [convKey(2)]: 'Renamed by the user' },
      projects: { [convKey(3)]: '/Users/you/work/launch-plan' },
      times: { [convKey(1)]: now - MIN, [convKey(2)]: now - 2 * MIN, [convKey(3)]: now - 3 * MIN },
      kernel: { 1: { title: 'Kernel title one' }, 3: { title: 'Kernel title three' } },
    });
    const source = await scan({ desktopDir: root });
    const list = source.listRunning('', now, IDLE);
    assert.deepEqual(list.map(r => r.group), ['working', 'stopped', 'done']);
    assert.deepEqual(list.map(r => r.status.title), ['Kernel title one', 'Kernel title three', 'Renamed by the user']);
    assert.equal(list[0].status.project, 'Kimi Work');
    assert.equal(list[1].status.project, 'launch-plan');
    assert.equal(list[1].status.state, 'error');
    const pick = source.getStatus('', now, IDLE);
    assert.equal(pick.status.state, 'working');
    assert.equal(source.getStatus('launch', now, IDLE).status.state, 'error');
    assert.equal(source.getStatus('kimi work', now, IDLE).status.state, 'working');
  });

  test('sqlite titles beat kernel titles; user renames beat both', async (t) => {
    const root = tmp('desktop');
    const now = Date.now();
    desktopFixture(root, {
      statuses: { [convKey(1)]: 'completed', [convKey(2)]: 'completed' },
      titles: { [convKey(2)]: 'User title' },
      times: { [convKey(1)]: now - MIN, [convKey(2)]: now - 2 * MIN },
      kernel: { 1: { title: 'Kernel title' }, 2: { title: 'Kernel title two' } },
    });
    if (!sqliteRows(root, [
      { key: convKey(1), title: 'Generated title', updatedAt: now - MIN },
      { key: convKey(2), title: 'Generated title two', updatedAt: now - 2 * MIN },
    ])) {
      t.skip('node:sqlite not available');
      return;
    }
    const source = await scan({ desktopDir: root });
    assert.equal(source.desktop.sqliteOk, true);
    const titles = source.listRunning('', now, IDLE).map(r => r.status.title);
    assert.deepEqual(titles, ['Generated title', 'User title']);
  });

  test('a dead daemon turns "running" into stopped', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    desktopFixture(root, { daemon: 'dead', statuses: { [convKey(1)]: 'running' }, times: { [convKey(1)]: now - MIN } });
    const source = await scan({ desktopDir: root });
    const s = source.getStatus('', now, IDLE).status;
    assert.equal(s.state, 'interrupted');
    assert.equal(s.confident, false);
    assert.equal(face(s).label, 'Stopped');
  });

  test('a pending question in the daemon waits for the user', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    desktopFixture(root, {
      statuses: { [convKey(1)]: 'running', [convKey(2)]: 'running' },
      times: { [convKey(1)]: now - 5 * MIN, [convKey(2)]: now - MIN },
      operations: [{ operationId: 'op-1', kind: 'kernel_turn', conversationKey: convKey(1), turnId: '3', startedAt: new Date(now - 6 * MIN).toISOString() }],
      turns: [{ operationId: 'op-1', sessionKind: 'conversation', conversationKey: convKey(1), turnId: '3', startedAt: new Date(now - 6 * MIN).toISOString() }],
      interactions: [{ operationId: 'op-3', interactionKind: 'question', turnId: '3', toolName: 'AskUserQuestion', startedAt: new Date(now - 4 * MIN).toISOString() }],
    });
    const source = await scan({ desktopDir: root });
    const pick = source.getStatus('', now, IDLE);
    assert.equal(pick.status.state, 'question');
    assert.equal(pick.status.sessionId, convKey(1));
    assert.equal(pick.others, 1);
  });

  test('an external tool wait is still working; old daemon state is ignored', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    desktopFixture(root, {
      statuses: { [convKey(1)]: 'running' },
      times: { [convKey(1)]: now - MIN },
      turns: [{ operationId: 'op-1', conversationKey: convKey(1), turnId: '1', startedAt: new Date(now - 2 * MIN).toISOString() }],
      interactions: [{ operationId: 'op-2', interactionKind: 'external_tool', turnId: '1' }],
    });
    let source = await scan({ desktopDir: root });
    assert.equal(source.getStatus('', now, IDLE).status.state, 'working');
    assert.equal(source.getStatus('', now, IDLE).status.since, now - 2 * MIN);

    const stale = tmp('desktop');
    desktopFixture(stale, {
      runnerGeneration: 'gen-0',
      statuses: { [convKey(1)]: 'completed' },
      times: { [convKey(1)]: now - MIN },
      turns: [{ conversationKey: convKey(1), turnId: '1' }],
      interactions: [{ interactionKind: 'question', turnId: '1' }],
    });
    source = await scan({ desktopDir: stale });
    assert.equal(source.getStatus('', now, IDLE).status.state, 'done');
  });

  test('the kernel journal adds the running tool and trailing questions', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    const t = m => now - m * MIN;
    desktopFixture(root, {
      statuses: { [convKey(1)]: 'running', [convKey(2)]: 'completed' },
      times: { [convKey(1)]: t(1), [convKey(2)]: t(2) },
      kernel: {
        1: { wire: [R.meta('1.4'), R.prompt(t(3)), R.step(t(3)), R.call('a', 'WebSearch', { query: 'synthetic query' }, t(1))] },
        2: { wire: [R.meta('1.4'), R.prompt(t(4)), R.text('Want me to send it?', t(2)), R.stepEnd('end_turn', t(2))] },
      },
    });
    const source = await scan({ desktopDir: root });
    const list = source.listRunning('', now, IDLE);
    assert.equal(list[0].status.tool, 'WebSearch: synthetic query');
    assert.equal(list[0].status.since, t(3));
    assert.equal(list[1].status.hasQuestion, true);
    assert.equal(face(list[1].status).label, 'Asked you');
  });

  test('unread results stay done; archived and automation tasks are left out', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    desktopFixture(root, {
      statuses: { [convKey(1)]: 'completed', [convKey(2)]: 'completed', [convKey(3)]: 'running', [convKey(4)]: 'completed' },
      unread: [convKey(1)],
      archive: { [convKey(3)]: { title: 'x', archivedAt: '', project: '' } },
      times: { [convKey(1)]: now - 60 * MIN, [convKey(2)]: now - 60 * MIN, [convKey(3)]: now - MIN, [convKey(4)]: now - MIN },
      kernel: { 4: { workTag: 'cron' } },
    });
    const source = await scan({ desktopDir: root });
    const list = source.listRunning('', now, IDLE);
    assert.deepEqual(list.map(r => r.status.sessionId), [convKey(1)]);
    const withCron = source.listRunning('', now, IDLE, { includeAutomations: true });
    assert.deepEqual(withCron.map(r => r.status.sessionId).sort(), [convKey(1), convKey(4)]);
  });
});

describe('merged sources and key settings', () => {
  test('source auto merges, desktop and cli pick one', async () => {
    const home = tmp('cli');
    const root = tmp('desktop');
    const now = Date.now();
    cliSession(home, 1, { wire: [R.meta(), R.prompt(now - 2 * MIN), R.step(now - 2 * MIN)], mtime: now - 2 * MIN });
    desktopFixture(root, { statuses: { [convKey(1)]: 'completed' }, times: { [convKey(1)]: now - MIN } });
    const source = await scan({ codeHome: home, desktopDir: root });
    assert.equal(source.listRunning('', now, IDLE).length, 2);
    assert.equal(source.getStatus('', now, IDLE).status.state, 'done', 'most recent first');
    assert.equal(source.getStatus('', now, IDLE, { source: 'cli' }).status.state, 'working');
    assert.equal(source.getStatus('', now, IDLE, { source: 'desktop' }).status.state, 'done');
    assert.deepEqual(Src.keyOptions({ source: 'bogus' }), { source: 'auto', automations: false });
  });

  test('notices: nothing installed, Kimi Work never opened, no sessions yet', async () => {
    let source = await scan({});
    assert.equal(source.notice().label.en, 'Not installed');
    assert.equal(source.notice().text.zh, '请先安装 Kimi Code');
    const root = tmp('desktop-unused');
    source = await scan({ desktopDir: root });
    assert.equal(source.notice().text.en, 'Open Kimi Work');
    const home = tmp('cli-empty');
    source = await scan({ codeHome: home });
    assert.equal(source.notice(), null);
    assert.equal(source.getStatus('', Date.now(), IDLE).status, null);
  });

  test('notices follow the key source setting', async () => {
    // only the Kimi app, never used: a cli key asks for Kimi Code
    const root = tmp('desktop-only');
    let source = await scan({ desktopDir: root });
    assert.equal(source.notice({ source: 'cli' }).text.en, 'Install Kimi Code');
    assert.equal(source.notice({ source: 'desktop' }).text.en, 'Open Kimi Work');
    assert.equal(source.notice({ source: 'auto' }).text.en, 'Open Kimi Work');
    // only Kimi Code: a desktop key asks for the app
    const home = tmp('cli-only');
    source = await scan({ codeHome: home });
    assert.equal(source.notice({ source: 'desktop' }).label.en, 'Not installed');
    assert.equal(source.notice({ source: 'desktop' }).text.zh, '请先安装 Kimi App');
    assert.equal(source.notice({ source: 'cli' }), null);
    assert.equal(source.notice({}), null);
  });

  test('describe answers the settings page', async () => {
    const home = tmp('cli');
    cliSession(home, 1, { wire: [R.meta(), R.prompt(Date.now() - MIN)], mtime: Date.now() - MIN });
    const config = { kimiDir: home, kimiDesktopDir: path.join(empty, 'none') };
    const reply = await S.sessionProvider.describe('', config, { source: 'auto', idleMinutes: 15 });
    assert.equal(reply.success, true);
    assert.equal(reply.state, 'working');
    assert.equal(reply.project, 'demo-app');
    assert.equal(reply.title, 'Synthetic task 1');
    assert.match(reply.projectsDir, /sessions/);
    const none = await S.sessionProvider.describe('', { kimiDir: path.join(empty, 'x'), kimiDesktopDir: path.join(empty, 'y') });
    assert.equal(none.success, false);
    assert.equal(none.notice.label.en, 'Not installed');
    assert.equal(S.sessionProvider.location(config).split(path.delimiter)[0], home);
  });

  test('daemon secrets and file contents never reach logs or replies', async () => {
    const root = tmp('desktop');
    const now = Date.now();
    const { daimon, agent } = desktopFixture(root, { statuses: { [convKey(1)]: 'running' }, times: { [convKey(1)]: now - MIN } });
    const logs = [];
    const logger = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    let source = await scan({ desktopDir: root, logger });
    const pick = source.getStatus('', now, IDLE);
    assert.equal(pick.status.state, 'working');
    // corrupt files: unreadable, but nothing quoted anywhere
    fs.writeFileSync(path.join(daimon, 'agents', 'main', 'runner.state.json'), `{"control":{"token":"${FAKE_TOKEN}"`);
    fs.writeFileSync(path.join(agent, 'conversation-statuses.json'), `{${FAKE_TOKEN}`);
    source = await scan({ desktopDir: root, logger });
    const reply = await S.sessionProvider.describe('', { kimiDesktopDir: root, kimiDir: path.join(empty, 'none') });
    const everything = JSON.stringify([logs, reply, source.listRunning('', now, IDLE), source.getStatus('', now, IDLE)]);
    assert.ok(!everything.includes(FAKE_TOKEN));
    assert.ok(!everything.includes('FAKE-HOST'));
    assert.ok(!everything.includes(empty), 'no local paths in logs or statuses');
    const info = D.runnerInfo({ control: { endpoint: { auth: { token: FAKE_TOKEN } } } });
    assert.ok(!JSON.stringify([...Object.entries(info)]).includes(FAKE_TOKEN));
  });
});

describe('live updates', () => {
  test('a started source reports changes as journals and stores change', async () => {
    const home = tmp('cli');
    const root = tmp('desktop');
    const now = Date.now();
    const file = path.join(cliSession(home, 1, { wire: [R.meta(), R.prompt(now - MIN), R.step(now - MIN)] }), 'agents', 'main', 'wire.jsonl');
    const { agent } = desktopFixture(root, { statuses: { [convKey(1)]: 'running' }, times: { [convKey(1)]: now - 2 * MIN } });
    let changes = 0;
    const source = S.sessionProvider.create({
      location: S.sessionProvider.location({ kimiDir: home, kimiDesktopDir: root }),
      config: { kimiDir: home, kimiDesktopDir: root },
      onChange: () => changes++,
    });
    const waitFor = async (check, what) => {
      for (let i = 0; i < 150; i++) {
        if (check()) return;
        await sleep(50);
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    try {
      source.start();
      source.setFilters(['']);
      source.setRunningWindow(IDLE);
      await waitFor(() => changes > 0, 'the first scan');
      assert.equal(source.getStatus('', Date.now(), IDLE, { source: 'cli' }).status.state, 'working');
      fs.appendFileSync(file, JSON.stringify(R.ended('completed', Date.now())) + '\n');
      await waitFor(() => source.getStatus('', Date.now(), IDLE, { source: 'cli' }).status.state === 'done', 'the CLI turn end');
      writeJson(path.join(agent, 'conversation-statuses.json'), { [convKey(1)]: 'blocked' });
      await waitFor(() => source.getStatus('', Date.now(), IDLE, { source: 'desktop' }).status.state === 'error', 'the desktop status');
      const count = changes;
      source.stop();
      fs.appendFileSync(file, JSON.stringify(R.prompt(Date.now())) + '\n');
      await sleep(600);
      assert.equal(changes, count, 'no onChange after stop()');
    } finally {
      source.stop();
    }
  });
});

describe('Session Status key with the Kimi provider', () => {
  function pngSize(dataUrl) {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }

  test('faces draw at every width and a press shows the running list', async () => {
    const home = tmp('cli');
    const now = Date.now();
    for (let n = 1; n <= 4; n++) {
      cliSession(home, n, { wire: [R.meta(), R.prompt(now - n * MIN), R.step(now - n * MIN)], mtime: now - n * MIN });
    }
    const config = { kimiDir: home, kimiDesktopDir: path.join(empty, 'none') };
    const cid = Kit.keyCid('kimi', 'session');
    const sent = [];
    let chain = Promise.resolve();
    const keys = new SessionKeys({
      enqueue: task => (chain = chain.then(task).catch(() => undefined)),
      send: async (_serial, key, image) => sent.push([key.uid, image]),
      isOffline: () => false,
      keyWidth: key => key.width,
      bgColor: () => undefined,
      loadConfig: async () => config,
      provider: { cid, brand: KIMI_BRAND, sessions: S.sessionProvider },
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        await chain;
        await sleep(25);
      }
    };
    try {
      const keyList = [60, 120, 240, 360].map(width => ({ uid: width, cid, width, data: { lang: 'en', source: 'auto' } }));
      await keys.alive(SERIAL, keyList);
      await settle();
      const widths = new Set(sent.map(([uid, image]) => pngSize(image)[0] === uid && uid));
      assert.deepEqual([...widths].sort((a, b) => a - b), [60, 120, 240, 360]);
      const before = sent.length;
      await keys.press(SERIAL, keyList[2]);
      await settle();
      assert.ok(sent.length > before, 'the list is drawn after a press');
      const description = await keys.message({ data: 'session-status', cid, filter: '', settings: { source: 'cli' } });
      assert.equal(description.state, 'working');
      assert.equal(description.others, 3);
    } finally {
      await keys.dead(SERIAL, []);
    }
  });
});

// ===================================================================================

describe('Kimi New Session launcher', () => {
  const HOME = '/Users/you';
  const request = (data = {}, extra = {}) => ({
    data,
    rawFolder: data.folder ?? '',
    folder: data.folder ? path.join(HOME, data.folder.replace(/^~\//, '')) : null,
    home: HOME,
    platform: 'darwin',
    ...extra,
  });
  const launcher = (files, env = {}) => NS.createKimiLauncher({ exists: file => files.includes(file), env });
  const CLI = '/Users/you/.kimi-code/bin/kimi';
  const APP = '/Applications/Kimi.app';

  test('auto: folder + CLI opens a terminal in the folder', () => {
    const target = launcher([CLI, APP]).target(request({ folder: '~/code/demo-app' }));
    assert.deepEqual(target, { kind: 'terminal', command: [CLI], cwd: '/Users/you/code/demo-app' });
  });

  test('auto: no folder opens Kimi Work in the app', () => {
    assert.deepEqual(launcher([CLI, APP]).target(request()), { kind: 'url', url: 'kimi-work://open' });
    assert.deepEqual(
      launcher(['/Users/you/Library/Application Support/kimi-desktop']).target(request({ folder: '~/x' })),
      { kind: 'url', url: 'kimi-work://open' },
      'folder without CLI: the app'
    );
  });

  test('auto: CLI only opens a terminal in the home folder', () => {
    assert.deepEqual(launcher([CLI]).target(request()), { kind: 'terminal', command: [CLI], cwd: null });
  });

  test('cliMode adds --continue or --plan', () => {
    assert.deepEqual(launcher([CLI]).target(request({ cliMode: 'continue' })).command, [CLI, '--continue']);
    assert.deepEqual(launcher([CLI]).target(request({ cliMode: 'plan', target: 'cli' })).command, [CLI, '--plan']);
    assert.deepEqual(NS.launchOptions({}), { target: 'auto', cliMode: 'new' });
  });

  test('nothing installed: a ProviderError, forced CLI falls back to PATH', () => {
    assert.throws(() => launcher([]).target(request()), e => e instanceof Kit.ProviderError && e.code === 'not-installed');
    assert.throws(() => launcher([CLI]).target(request({ target: 'desktop' })), Kit.ProviderError);
    assert.deepEqual(launcher([]).target(request({ target: 'cli' })).command, ['kimi']);
    assert.deepEqual(launcher(['/Users/you/.kimi-code']).target(request()).command, ['kimi'], 'CLI home without a known program');
  });

  test('program search: KIMI_INSTALL_DIR first, npm folders, never the legacy shim', () => {
    const custom = '/opt/kimi/bin/kimi';
    assert.equal(launcher([custom, CLI], { KIMI_INSTALL_DIR: '/opt/kimi' }).target(request({ target: 'cli' })).command[0], custom);
    assert.equal(launcher(['/opt/homebrew/bin/kimi']).target(request({ target: 'cli' })).command[0], '/opt/homebrew/bin/kimi');
    assert.equal(launcher(['/Users/you/.local/bin/kimi']).target(request({ target: 'cli' })).command[0], 'kimi');
    const win = NS.cliCandidates('C:\\Users\\you', 'win32', { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' });
    assert.equal(win[0], 'C:\\Users\\you\\.kimi-code\\bin\\kimi.exe');
    assert.ok(win.includes('C:\\Users\\you\\AppData\\Roaming\\npm\\kimi.cmd'));
  });

  test('program search: the kimiDir setting stands in for KIMI_CODE_HOME', () => {
    const custom = '/Users/you/kimi-home/bin/kimi';
    const config = { kimiDir: '~/kimi-home' };
    assert.equal(launcher([custom]).target(request({ target: 'cli' }, { config })).command[0], custom);
    // the setting's folder without a program: kimi on the terminal's PATH
    assert.deepEqual(
      launcher(['/Users/you/kimi-home']).target(request({}, { config })).command,
      ['kimi']
    );
    // no setting: the default home only
    assert.equal(launcher([custom]).target(request({ target: 'cli' }, { config: {} })).command[0], 'kimi');
  });

  test('the real launcher only builds a target (nothing is opened)', async () => {
    try {
      const target = await NS.newSessionLauncher.target(request({ target: 'cli' }));
      assert.equal(target.kind, 'terminal');
    } catch (error) {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
    }
  });

  test('the key opens the target through the stubs and shows errors', async () => {
    const cid = Kit.keyCid('kimi', 'newsession');
    const opened = [];
    const sent = [];
    let chain = Promise.resolve();
    const make = files =>
      new NewSessionKeys({
        enqueue: task => (chain = chain.then(task).catch(() => undefined)),
        send: async (_s, key, image) => sent.push([key.uid, image]),
        isOffline: () => false,
        keyWidth: key => key.width,
        bgColor: () => undefined,
        provider: { cid, brand: KIMI_BRAND, launcher: launcher(files) },
        launch: async url => opened.push(['url', url]),
        run: async command => opened.push(['run', command]),
        terminal: async (command, cwd) => opened.push(['terminal', command, cwd]),
        home: HOME,
        platform: 'darwin',
        timings: { openingMs: 5, errorMs: 5, debounceMs: 0 },
      });
    let keys = make([CLI, APP]);
    const key = { uid: 1, cid, width: 120, data: { folder: '~/code/demo-app', lang: 'en' } };
    await keys.alive(SERIAL, [key]);
    assert.equal(await keys.press(SERIAL, key), true);
    assert.deepEqual(opened.pop(), ['terminal', [CLI], '/Users/you/code/demo-app']);
    const noFolder = { uid: 2, cid, width: 120, data: { lang: 'zh' } };
    await keys.alive(SERIAL, [noFolder]);
    assert.equal(await keys.press(SERIAL, noFolder), true);
    assert.deepEqual(opened.pop(), ['url', 'kimi-work://open']);
    await keys.dead(SERIAL, []);
    keys = make([]);
    await keys.alive(SERIAL, [key]);
    assert.equal(await keys.press(SERIAL, key), false);
    assert.equal(opened.length, 0);
    await keys.dead(SERIAL, []);
    assert.equal(NS.newSessionLauncher.strings.error.en, 'Kimi not found');
    assert.equal(NS.newSessionLauncher.strings.error.zh, '未找到 Kimi');
  });

  test('a terminal target becomes a quoted script, never shell text', async () => {
    const writes = [];
    const runs = [];
    const open = Launch.createTerminalOpener({
      platform: 'darwin',
      tmpDir: '/tmp/fake',
      writeFile: async (file, data, mode) => writes.push({ file, data, mode }),
      run: async command => runs.push(command),
      unlink: async () => undefined,
    });
    const target = launcher([CLI]).target(request({ folder: "~/it's here", cliMode: 'plan' }));
    await open(target.command, target.cwd);
    assert.equal(writes.length, 1);
    assert.match(writes[0].data, /cd -- '\/Users\/you\/it'\\''s here'/);
    assert.match(writes[0].data, /exec '\/Users\/you\/\.kimi-code\/bin\/kimi' '--plan'/);
    assert.equal(runs[0].file, '/usr/bin/open');
  });
});
