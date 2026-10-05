// Tests for the Kimi session source and New Session launcher
// (src/providers/kimi/session.ts, newSession.ts), run against the tsc output
// of `npm run test:kimi-session` (.test-build-kimi-session/).
// OWNER: the kimi-session implementer; replace the stub checks with fixture-
// driven tests. Rules: synthetic fixtures only (see CLAUDE.md), never read
// the real home folder (HOME points at an empty temp folder), never open a
// link, a terminal or an app: every launcher below is a stub.
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
for (const name of ['KIMI_CODE_HOME', 'KIMI_SHARE_DIR']) delete process.env[name];
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
const NS = req('providers/kimi/newSession.js');
const Kit = req('providers/kit.js');
const { SessionKeys } = req('sessionKey.js');
const { NewSessionKeys } = req('newSessionKey.js');
const { KIMI_BRAND } = req('providers/kimi/brand.js');

const CONFIG = { kimiDir: path.join(empty, 'kimi-code'), kimiDesktopDir: path.join(empty, 'kimi-desktop') };
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

describe('Kimi session provider contract', () => {
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

  test('describe answers the settings page', async () => {
    const reply = await S.sessionProvider.describe('', CONFIG);
    assert.equal(reply.success, false);
    for (const field of ['projectsDir', 'state', 'project', 'title', 'others']) {
      assert.ok(field in reply, field);
    }
  });

  test('the key draws a 60px face', async () => {
    const cid = Kit.keyCid('kimi', 'session');
    const hooks = drawHooks();
    const keys = new SessionKeys({
      ...hooks.deps,
      provider: { cid, brand: KIMI_BRAND, sessions: S.sessionProvider },
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

describe('Kimi New Session launcher contract', () => {
  test('a press builds a target or fails with a ProviderError, launching nothing real', async () => {
    const cid = Kit.keyCid('kimi', 'newsession');
    const hooks = drawHooks();
    const opened = [];
    const keys = new NewSessionKeys({
      ...hooks.deps,
      provider: { cid, brand: KIMI_BRAND, launcher: NS.newSessionLauncher },
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
      });
      assert.ok(['url', 'command', 'terminal'].includes(target.kind));
    } catch (error) {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
    }
  });
});
