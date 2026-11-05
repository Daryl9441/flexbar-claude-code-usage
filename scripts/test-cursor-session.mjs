// Tests for the Cursor session key and the open-app key. Composer rows are
// synthetic. The sqlite reader is exercised only when node:sqlite exists,
// and it must not return message text. Nothing is launched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-session-test-'));
const build =
  process.env.CURSOR_SESSION_TEST_BUILD ??
  path.join(here, '..', '.test-build-cursor-session');
const req = file => require(path.join(build, file));
const S = req('providers/cursor/session.js');
const Scan = req('providers/cursor/sessionScan.js');
const N = req('providers/cursor/newSession.js');
const P = req('providers/cursor/paths.js');

const HOME = '/Users/you';
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const CHAT_MARKER = ['PLANTED', 'CHAT', 'TEXT'].join('-');
const DB = path.join(root, 'state.vscdb');

function row(extra = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Fix the meter',
    status: 'none',
    updatedAt: NOW - 60_000,
    mode: 'agent',
    project: '/Users/you/demo',
    conversation: CHAT_MARKER,
    text: CHAT_MARKER,
    ...extra,
  };
}

function provider(readRows, exists = () => true) {
  return S.createCursorSessionProvider({
    home: HOME,
    platform: 'darwin',
    env: {},
    now: () => NOW,
    exists,
    readRows,
  });
}

describe('Cursor composer rows', () => {
  test('metadata becomes a chat, and message fields are dropped', () => {
    assert.equal(Scan.COMPOSER_SQL.includes('conversation'), false);
    assert.equal(Scan.COMPOSER_SQL.includes('bubbleId'), false);
    assert.match(Scan.COMPOSER_SQL, /json_extract\(value, '\$\.name'\)/);
    const [composer] = Scan.composersFromRows([
      row(),
      row({
        id: 'child',
        parentId: '00000000-0000-4000-8000-000000000001',
        name: 'subagent',
      }),
      row({ id: 'old-archived', archived: 1, name: 'archived chat' }),
    ]);
    assert.equal(composer.name, 'Fix the meter');
    assert.equal(composer.project, 'demo');
    assert.equal(composer.mode, 'agent');
    assert.equal(composer.generating, false);
    assert.equal(JSON.stringify(composer).includes(CHAT_MARKER), false);
    assert.equal(
      Scan.composersFromRows([row({ subagent: true })]).length,
      0
    );
  });

  test('generating and a waiting status are kept even when the timestamp is old', () => {
    const rows = Scan.composersFromRows([
      row({
        id: 'gen',
        status: 'none',
        generatingCount: 1,
        updatedAt: NOW - 24 * 60 * 60_000,
        name: 'Still running',
      }),
      row({
        id: 'ask',
        status: 'awaiting_user',
        updatedAt: NOW - 24 * 60 * 60_000,
        name: 'Need a choice',
        mode: 'chat',
      }),
    ]);
    assert.equal(rows[0].id, 'ask');
    assert.equal(rows[0].awaiting, true);
    assert.equal(rows[1].generating, true);
  });
});

describe('Cursor session provider', () => {
  const sessions = provider(async () => [
    row({ id: 'ask', status: 'awaiting_user', name: 'Need a choice' }),
    row({ id: 'gen', generatingCount: 2, name: 'Still running' }),
    row({ id: 'old', updatedAt: NOW - 2 * 60 * 60_000, name: 'Yesterday' }),
  ]);

  test('Question outranks Working, and an idle chat leaves the key', async () => {
    const described = await sessions.describe('', { cursorStateDb: DB });
    assert.equal(described.success, true);
    assert.equal(described.state, 'question');
    assert.equal(described.title, 'Need a choice');
    assert.equal(described.others, 1);
    assert.equal(described.projectsDir, DB);
    assert.equal(JSON.stringify(described).includes(CHAT_MARKER), false);

    const filtered = await sessions.describe('running', { cursorStateDb: DB });
    assert.equal(filtered.title, 'Still running');
    assert.equal(filtered.state, 'working');

    const quiet = await sessions.describe('Yesterday', { cursorStateDb: DB });
    assert.equal(quiet.success, false);
    assert.equal(quiet.notice, null);
  });

  test('a missing install is a notice, and an unreadable database says so', async () => {
    const missing = provider(async () => [], () => false);
    const none = await missing.describe('', {});
    assert.equal(none.success, false);
    assert.equal(none.notice.label.en, 'Not installed');

    const broken = provider(async () => {
      throw new Error(`sqlite ${CHAT_MARKER}`);
    });
    const failed = await broken.describe('', { cursorStateDb: DB });
    assert.equal(failed.notice.label.en, 'Cannot read chats');
    assert.equal(JSON.stringify(failed).includes(CHAT_MARKER), false);
  });

  test('a running source reports one change and then stops', async () => {
    fs.writeFileSync(DB, '');
    let changes = 0;
    const source = provider(async () => [row({ generatingCount: 1 })]).create({
      location: DB,
      config: { cursorStateDb: DB },
      onChange: () => {
        changes += 1;
      },
    });
    source.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    const status = source.getStatus('', NOW, 15 * 60_000, {});
    assert.equal(status.status.state, 'working');
    assert.equal(status.status.detail, 'Agent');
    assert.ok(changes >= 1);
    source.stop();
  });
});

describe('Cursor state database reader', () => {
  test('a missing file is an empty roster, and a symlink is not followed', async () => {
    const missing = path.join(root, 'absent.vscdb');
    assert.deepEqual(await Scan.readComposerRows(missing), []);
    const target = path.join(root, 'real.vscdb');
    fs.writeFileSync(target, CHAT_MARKER);
    const link = path.join(root, 'linked.vscdb');
    fs.symlinkSync(target, link);
    await assert.rejects(
      () => Scan.readComposerRows(link),
      error => {
        assert.match(error.message, /could not be queried/);
        assert.equal(error.message.includes(CHAT_MARKER), false);
        return true;
      }
    );
  });

  test('sqlite returns composer metadata and not the message body', async t => {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite?.DatabaseSync) {
      t.skip('node:sqlite not available');
      return;
    }
    const file = path.join(root, 'composers.vscdb');
    const db = new sqlite.DatabaseSync(file);
    db.exec(
      'CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value TEXT)'
    );
    const payload = {
      name: 'Metadata only',
      status: 'generating',
      lastUpdatedAt: NOW,
      unifiedMode: 'agent',
      conversation: [{ text: CHAT_MARKER }],
      generatingBubbleIds: ['b1'],
    };
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'composerData:00000000-0000-4000-8000-000000000002',
      JSON.stringify(payload)
    );
    db.close();
    const walBefore = fs.existsSync(`${file}-wal`);
    const rows = await Scan.readComposerRows(file);
    assert.equal(fs.existsSync(`${file}-wal`), walBefore);
    assert.equal(JSON.stringify(rows).includes(CHAT_MARKER), false);
    const [composer] = Scan.composersFromRows(rows);
    assert.equal(composer.name, 'Metadata only');
    assert.equal(composer.generating, true);
    assert.equal(fs.existsSync(`${file}-wal`), false);
  });
});

describe('Open Cursor', () => {
  test('a press focuses the app and sends no prompt', () => {
    const launcher = N.createCursorLauncher({
      env: {},
      exists: file => file === '/Applications/Cursor.app',
    });
    const target = launcher.target({
      data: {},
      rawFolder: '',
      folder: null,
      home: HOME,
      platform: 'darwin',
      config: {},
    });
    assert.deepEqual(target, { kind: 'url', url: 'cursor://' });
    assert.equal(target.url.includes('prompt'), false);
    assert.equal(target.url.includes('?'), false);
    assert.equal(launcher.strings.ready.zh, '打开 Cursor');
    assert.equal(launcher.subtitle({}, null, 'en'), 'Opens the app');
  });

  test('a machine without Cursor fails before any URL is returned', () => {
    const launcher = N.createCursorLauncher({
      env: {},
      exists: () => false,
    });
    assert.throws(
      () =>
        launcher.target({
          data: {},
          rawFolder: '',
          folder: null,
          home: HOME,
          platform: 'darwin',
          config: {},
        }),
      error => {
        assert.equal(error.code, 'not-installed');
        assert.equal(error.extra.keyText.en.title, 'Cursor not found');
        return true;
      }
    );
  });
});
