// Tests for the Antigravity session source and New Session launcher
// (src/providers/antigravity/session.ts, newSession.ts), run against the tsc
// output of `npm run test:antigravity-session`
// (.test-build-antigravity-session/).
// OWNER: the antigravity-session implementer; replace the stub checks with
// fixture-driven tests. Rules: synthetic fixtures only (see CLAUDE.md),
// never read the real home folder (HOME points at an empty temp folder),
// never open a link, a terminal or an app, never reach a real Antigravity
// language server or list real processes: every launcher below is a stub,
// and fetch, http/https, net and child_process fail loudly (inject fakes).
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
const Kit = req('providers/kit.js');
const { SessionKeys } = req('sessionKey.js');
const { NewSessionKeys } = req('newSessionKey.js');
const { ANTIGRAVITY_BRAND } = req('providers/antigravity/brand.js');

const CONFIG = {
  antigravityDir: path.join(empty, 'gemini'),
  antigravityPath: path.join(empty, 'no-agy'),
};
const SERIAL = 'FAKE-DEVICE-1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function drawHooks() {
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
      loadConfig: async () => CONFIG,
    },
  };
}

describe('Antigravity session provider contract', () => {
  test('a source reports a change after start and answers queries', async () => {
    const location = S.sessionProvider.location(CONFIG);
    assert.equal(typeof location, 'string');
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
    } finally {
      source.stop();
    }
  });

  // stub behaviour: replace with the real source's checks
  test('stub: the notice says not installed without data folders', async () => {
    const source = S.sessionProvider.create({
      location: S.sessionProvider.location(CONFIG),
      config: CONFIG,
      onChange: () => undefined,
    });
    assert.equal(source.notice().label.en, 'Not installed');
    assert.equal(source.notice().text.en, 'Install Antigravity');
    const root = path.join(empty, 'installed');
    fs.mkdirSync(path.join(root, 'antigravity'), { recursive: true });
    try {
      const reply = await S.sessionProvider.describe('', { antigravityDir: root });
      assert.equal(reply.notice.label.en, 'Not set up');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('describe answers the settings page', async () => {
    const reply = await S.sessionProvider.describe('', CONFIG);
    assert.equal(reply.success, false);
    for (const field of ['projectsDir', 'state', 'project', 'title', 'others']) {
      assert.ok(field in reply, field);
    }
  });

  test('the key draws a 60px face', async () => {
    const cid = Kit.keyCid('antigravity', 'session');
    const hooks = drawHooks();
    const keys = new SessionKeys({
      ...hooks.deps,
      provider: { cid, brand: ANTIGRAVITY_BRAND, sessions: S.sessionProvider },
    });
    try {
      await keys.alive(SERIAL, [
        { uid: 1, cid, width: 240, data: { lang: 'en' } },
        { uid: 2, cid, width: 60, data: { lang: 'zh' } },
      ]);
      await sleep(50);
      await hooks.settle();
      assert.ok(hooks.sent.length >= 2);
      for (const [uid, image] of hooks.sent) {
        assert.deepEqual(pngSize(image), [uid === 1 ? 240 : 60, 60]);
      }
    } finally {
      await keys.dead(SERIAL, []);
    }
  });
});

describe('Antigravity New Session launcher contract', () => {
  test('a press builds a target or fails with a ProviderError, launching nothing real', async () => {
    const cid = Kit.keyCid('antigravity', 'newsession');
    const hooks = drawHooks();
    const opened = [];
    const keys = new NewSessionKeys({
      ...hooks.deps,
      provider: { cid, brand: ANTIGRAVITY_BRAND, launcher: NS.newSessionLauncher },
      launch: async url => opened.push(['url', url]),
      run: async command => opened.push(['run', command]),
      terminal: async (command, cwd) => opened.push(['terminal', command, cwd]),
      home: '/Users/you',
      platform: 'darwin',
      timings: { openingMs: 5, errorMs: 5 },
    });
    const key = { uid: 1, cid, width: 120, data: { folder: '~/work/demo-app' } };
    await keys.alive(SERIAL, [key]);
    const launched = await keys.press(SERIAL, key);
    await hooks.settle();
    assert.equal(launched, opened.length === 1);
    assert.ok(hooks.sent.length >= 2);
    for (const [, image] of hooks.sent) {
      assert.deepEqual(pngSize(image), [120, 60]);
    }
    await keys.dead(SERIAL, []);
  });

  test('target() returns a LaunchTarget or throws a ProviderError', async () => {
    assert.equal(typeof NS.newSessionLauncher.appName, 'string');
    try {
      const target = await NS.newSessionLauncher.target({
        data: { folder: '' },
        rawFolder: '',
        folder: null,
        home: '/Users/you',
        platform: 'darwin',
        config: CONFIG,
      });
      assert.ok(['url', 'command', 'terminal'].includes(target.kind));
    } catch (error) {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
    }
  });
});
