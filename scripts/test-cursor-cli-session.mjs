// Agent CLI (~/.cursor/chats/<hash>/<id>/meta.json) sessions in the Cursor Sessions key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, '..', '.test-build-cursor-session');
const S = require(path.join(build, 'providers/cursor/session.js'));
const Scan = require(path.join(build, 'providers/cursor/sessionScan.js'));
const Cli = require(path.join(build, 'providers/cursor/cliScan.js'));

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const ID = '1f26e990-93d4-444a-8c0e-6affe4489760';
const SECRET = ['PLANTED', 'STORE', 'KEY'].join('-');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cli-test-'));
  const dir = path.join(home, '.cursor', 'chats', '5f2a14c9d79bb69c019635a188b7773e', ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, createdAtMs: NOW - 120_000, updatedAtMs: NOW - 60_000,
    hasConversation: true, cwd: '/Users/you/work/writer-technical',
  }));
  fs.writeFileSync(path.join(dir, 'store.db'), SECRET);
  fs.mkdirSync(path.join(home, '.cursor', 'chats', 'abcdef12', 'not-a-uuid'), { recursive: true });
  return home;
}

describe('Cursor Agent CLI sessions', () => {
  test('reads only meta.json and labels rows as Agent CLI', async () => {
    const home = fakeHome();
    const rows = await Cli.readCliRows(path.join(home, '.cursor', 'chats'));
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes(SECRET), false);
    const [c] = Cli.cliComposersFromRows(rows);
    assert.equal(c.id, ID);
    assert.equal(c.name, 'Agent CLI');
    assert.equal(c.source, 'cli');
    assert.equal(c.project, 'writer-technical');
    assert.equal(c.generating, false);
  });

  test('missing chats dir yields nothing', async () => {
    assert.deepEqual(await Cli.readCliRows('/nonexistent/x/chats'), []);
  });

  test('merge dedupes by id, app composer wins', () => {
    const app = [{ id: ID, name: 'App', project: null, mode: 'agent', awaiting: false, generating: true, at: 1 }];
    const cli = Cli.cliComposersFromRows([{ id: ID, updatedAtMs: NOW }, { id: '00000000-0000-4000-8000-000000000009', updatedAtMs: NOW }]);
    const merged = Scan.mergeComposers(app, cli);
    assert.equal(merged.length, 2);
    assert.equal(merged.find(m => m.id === ID).name, 'App');
  });

  test('CLI session shows in the Cursor Sessions key with no app database', async () => {
    const home = fakeHome();
    const p = S.createCursorSessionProvider({
      home, platform: 'darwin', env: {}, now: () => NOW,
      exists: f => f.startsWith(home) && fs.existsSync(f) ? true : f === '/Applications/Cursor.app',
    });
    const d = await p.describe('', null, { idleMinutes: 30 });
    assert.equal(d.success, true);
    assert.equal(d.title, 'Agent CLI');
    assert.equal(d.project, 'writer-technical');
  });

  test('stubbed readRows without readCliRows keeps CLI scan off', async () => {
    const home = fakeHome();
    const p = S.createCursorSessionProvider({
      home, platform: 'darwin', env: {}, now: () => NOW, exists: () => true, readRows: async () => [],
    });
    const d = await p.describe('', null, { idleMinutes: 30 });
    assert.equal(d.success, false);
  });

  test('ps parsing: --resume id and --workspace with spaces; worker-server ignored', () => {
    const ps = [
      ' 101 /Users/you/.local/bin/agent --use-system-ca /x/index.js --resume ' + ID + ' --workspace /a b',
      ' 102 /Users/you/.local/bin/agent --use-system-ca /x/index.js --workspace /Users/you/My Work/out --model m -p',
      ' 103 /x/node /x/index.js worker-server',
      ' 104 /usr/bin/vim --workspace /nope',
    ].join('\n');
    const live = Cli.parseAgentProcesses(ps);
    assert.deepEqual([...live.resumeIds], [ID]);
    assert.deepEqual([...live.workspaces], ['/Users/you/My Work/out']);
  });

  test('live process makes the session working; workspace picks newest for that cwd', () => {
    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const rows = [
      { id: ID, updatedAtMs: NOW - 5000, cwd: '/r' },
      { id: A, updatedAtMs: NOW - 9000, cwd: '/w/' },
      { id: B, updatedAtMs: NOW - 1000, cwd: '/w' },
    ];
    const live = Cli.parseAgentProcesses(` 1 /h/.local/bin/cursor-agent --resume=${ID}\n 2 /h/.local/bin/agent --workspace /w -p`);
    const out = Object.fromEntries(Cli.cliComposersFromRows(rows, live).map(c => [c.id, c.generating]));
    assert.deepEqual(out, { [ID]: true, [A]: false, [B]: true });
    assert.equal(Cli.cliComposersFromRows(rows).some(c => c.generating), false);
  });

  test('key shows working while alive, done once gone, done when ps fails', async () => {
    const home = fakeHome();
    const mk = listProcesses => S.createCursorSessionProvider({
      home, platform: 'darwin', env: {}, now: () => NOW, listProcesses,
      exists: f => f.startsWith(home) && fs.existsSync(f) ? true : f === '/Applications/Cursor.app',
    });
    const data = { idleMinutes: 30 };
    assert.equal((await mk(async () => ` 9 /u/.local/bin/agent --resume ${ID}`).describe('', null, data)).state, 'working');
    assert.equal((await mk(async () => '').describe('', null, data)).state, 'done');
    assert.equal((await mk(async () => { throw new Error('x'); }).describe('', null, data)).state, 'done');
  });
});
