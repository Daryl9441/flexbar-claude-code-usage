// Tests for the Grok Bot session key and the open-app launcher. Fixtures are
// synthetic files under a temp directory. Process checks are stubbed, so a
// test never signals a real pid. Nothing is sent anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-session-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.GROKBOT_SESSION_TEST_BUILD ??
  path.join(here, '..', '.test-build-grokbot-session');
const req = file => require(path.join(build, file));
const S = req('providers/grokbot/session.js');
const Scan = req('providers/grokbot/sessionScan.js');
const B32 = req('providers/grokbot/base32.js');
const N = req('providers/grokbot/newSession.js');
const P = req('providers/grokbot/paths.js');
const Kit = req('providers/kit.js');

const NOW = Date.parse('2026-10-15T00:00:00.000Z');
const RECENT = NOW - 60_000;
const OLD = NOW - 24 * 60 * 60_000;
const PROMPT = 'SYNTHETIC-PROMPT-TEST';
const APP_PID = 4242;
const DAEMON_PID = 4343;

let n = 0;
function tmp(name) {
  const dir = path.join(root, `${name}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSlice(dir, key, value) {
  const folder = path.join(dir, P.PERSISTENCE_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${B32.encodeBase32(key)}.blob`);
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, value })
  );
  return file;
}

function roster(dir, rows) {
  writeSlice(
    dir,
    'sand.client.slice.account.account-TEST.roster.last-roster',
    { rows }
  );
}

function transcript(dir, botId, entries) {
  writeSlice(
    dir,
    `sand.client.slice.account.account-TEST.transcript.replicas.${botId}`,
    { entries }
  );
}

function provider(dir, { pidAlive = () => false, platform = 'linux' } = {}) {
  return S.createGrokbotSessionProvider({
    home: '/Users/you',
    platform,
    env: {},
    pidAlive,
    now: () => NOW,
  });
}

function configFor(dir) {
  return { grokbotDir: dir, grokbotDataRoot: path.join(dir, 'data-root') };
}

describe('Grok Bot session files', () => {
  test('base32 names round-trip the way the app names slice files', () => {
    const key = 'sand.client.slice.account.account-TEST.roster.last-roster';
    assert.equal(B32.decodeBase32(B32.encodeBase32(key)), key);
    assert.equal(B32.decodeBase32('not base32!'), null);
  });

  test('a missing install is a notice, and no pid is checked', async () => {
    const dir = path.join(root, 'does-not-exist');
    let checked = false;
    const described = await provider(dir, {
      pidAlive: () => {
        checked = true;
        return true;
      },
    }).describe('', { grokbotDir: dir, grokbotDataRoot: `${dir}-root` }, {});
    assert.equal(described.success, false);
    assert.equal(described.notice.label.en, 'Not installed');
    assert.equal(checked, false);
  });

  test('a bot waiting for you is Question, and chat text stays off the key', async () => {
    const dir = tmp('waiting');
    roster(dir, [
      {
        id: 'bot-TEST-1',
        name: 'Example Bot',
        awaitingUserResponse: true,
        lastActivityAt: RECENT,
      },
    ]);
    transcript(dir, 'bot-TEST-1', [
      {
        kind: 'message',
        role: 'user',
        timestampMs: RECENT,
        content: PROMPT,
        requestId: 'req-TEST-1',
      },
    ]);
    const described = await provider(dir).describe('example', configFor(dir), {
      lang: 'en',
    });
    assert.equal(described.success, true);
    assert.equal(described.state, 'question');
    assert.equal(described.title, 'Example Bot');
    assert.equal(JSON.stringify(described).includes(PROMPT), false);

    const source = provider(dir).create({
      location: dir,
      config: configFor(dir),
      onChange() {},
    });
    await source.rescan();
    const { status, others } = source.getStatus('example', NOW, 15 * 60_000, {
      lang: 'zh',
    });
    assert.equal(status.state, 'question');
    assert.equal(status.question, '等待你的回复');
    assert.equal(JSON.stringify(status).includes(PROMPT), false);
    assert.equal(others, 0);
    source.stop();
  });

  test('recent bots are Done, old ones drop out, and a transcript time fills a gap', async () => {
    const dir = tmp('done');
    roster(dir, [
      { id: 'bot-TEST-1', name: 'Recent Bot', lastActivityAt: RECENT },
      { id: 'bot-TEST-2', name: 'Old Bot', lastActivityAt: OLD },
      { id: 'bot-TEST-3', name: 'Timed Bot' },
    ]);
    transcript(dir, 'bot-TEST-3', [
      { kind: 'send-message', timestampMs: RECENT, message: { content: PROMPT } },
    ]);
    const source = provider(dir).create({
      location: dir,
      config: configFor(dir),
      onChange() {},
    });
    await source.rescan();
    const running = source.listRunning('', NOW, 15 * 60_000, {});
    const titles = running.map(item => item.status.title);
    assert.deepEqual(titles.sort(), ['Recent Bot', 'Timed Bot']);
    assert.ok(running.every(item => item.status.state === 'done'));
    assert.equal(JSON.stringify(running).includes(PROMPT), false);
    source.stop();
  });

  test('a live marker is Idle and local work is Working, unless live detection is off', async () => {
    const dir = tmp('live');
    const dataRoot = path.join(dir, 'data-root');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dir, P.SESSION_MARKER),
      JSON.stringify({
        pid: APP_PID,
        appVersion: '0.0.0-test',
        startedAtMs: NOW - 5 * 60_000,
        aliveAtMs: NOW,
        crashSeen: false,
      })
    );
    fs.writeFileSync(
      path.join(dataRoot, P.DAEMON_FILE),
      JSON.stringify({ pid: DAEMON_PID, inflightCount: 2 })
    );
    roster(dir, [
      { id: 'bot-TEST-1', name: 'Example Bot', awaitingUserResponse: true },
    ]);
    const pidAlive = pid => pid === APP_PID || pid === DAEMON_PID;
    const session = provider(dir, { pidAlive });
    const described = await session.describe('', configFor(dir), { lang: 'en' });
    assert.equal(described.state, 'question');
    assert.equal(described.others, 1);

    const source = session.create({
      location: dir,
      config: configFor(dir),
      onChange() {},
    });
    await source.rescan();
    const running = source.listRunning('', NOW, 15 * 60_000, { lang: 'en' });
    assert.equal(running[0].status.state, 'question');
    const local = running.find(item => item.status.sessionId === 'local-exec');
    assert.equal(local.status.state, 'working');
    assert.equal(local.status.detail, '2 local tasks');
    const app = running.find(item => item.status.sessionId === 'app');
    assert.equal(app.status.state, 'idle');
    assert.equal(app.status.title, 'Grok Bot');

    const quiet = source.getStatus('', NOW, 15 * 60_000, {
      liveDetection: false,
    });
    assert.equal(quiet.status.state, 'question');
    assert.equal(quiet.others, 0);
    source.stop();
  });

  test('a dead pid and a symlink slice are ignored', async () => {
    const dir = tmp('dead');
    fs.writeFileSync(
      path.join(dir, P.SESSION_MARKER),
      JSON.stringify({ pid: APP_PID, startedAtMs: NOW })
    );
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(
      outside,
      JSON.stringify({
        schemaVersion: 1,
        value: { rows: [{ id: 'bot-TEST-9', name: 'Linked Bot' }] },
      })
    );
    const folder = path.join(dir, P.PERSISTENCE_DIR);
    fs.mkdirSync(folder, { recursive: true });
    const key = 'sand.client.slice.account.account-TEST.roster.last-roster';
    fs.symlinkSync(outside, path.join(folder, `${B32.encodeBase32(key)}.blob`));
    fs.writeFileSync(path.join(folder, 'broken.blob'), '{');
    const snapshot = await Scan.scanGrokbot({
      userDataDir: dir,
      dataRoot: path.join(dir, 'no-root'),
      appCandidates: [],
      exists: fs.existsSync,
      pidAlive: () => false,
      checkPids: true,
    });
    assert.equal(snapshot.installed, true);
    assert.equal(snapshot.appRunning, false);
    assert.equal(snapshot.bots.length, 0);
  });

  test('the source reports one change after it starts', async () => {
    const dir = tmp('watch');
    let changes = 0;
    const source = provider(dir).create({
      location: dir,
      config: configFor(dir),
      onChange() {
        changes += 1;
      },
    });
    source.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    source.stop();
    assert.equal(changes >= 1, true);
  });
});

describe('Grok Bot open launcher', () => {
  test('opens the documented activation link when the app is installed', () => {
    const launcher = N.createGrokbotLauncher({
      exists: file => file === '/Applications/Grok Bot.app',
    });
    assert.equal(launcher.subtitle({}, null, 'en'), 'Opens the app');
    assert.equal(launcher.strings.ready.en, 'Open Grok Bot');
    const target = launcher.target({
      data: {},
      rawFolder: '',
      folder: null,
      home: '/Users/you',
      platform: 'darwin',
      config: {},
    });
    assert.deepEqual(target, { kind: 'url', url: 'grokbot://app/v1/open' });
  });

  test('refuses to open anything when Grok Bot is not on this computer', () => {
    const launcher = N.createGrokbotLauncher({ exists: () => false });
    assert.throws(
      () =>
        launcher.target({
          data: {},
          rawFolder: '',
          folder: null,
          home: '/Users/you',
          platform: 'darwin',
          config: {},
        }),
      error => error instanceof Kit.ProviderError && error.code === 'not-installed'
    );
  });
});
