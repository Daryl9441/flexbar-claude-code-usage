// Tests for the New Session key: deep link building, opener selection,
// press handling (debounce, feedback, failure) and a render smoke test, run
// against the tsc output (see `npm run test:newsession`). No test starts a
// real process: every launcher and execFile here is a stub. Paths are
// placeholders.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.NEWSESSION_TEST_BUILD ?? path.join(here, '..', '.test-build');
const N = require(path.join(build, 'newSession.js'));
const K = require(path.join(build, 'newSessionKey.js'));
const R = require(path.join(build, 'newSessionRender.js'));
const O = require(path.join(build, 'openUrl.js'));
const { loadImage } = require('@napi-rs/canvas');

const HOME = '/Users/you';
const CID = 'dev.sese.flexbar_claude_code_usage.newsession';
const SERIAL = 'FAKE-DEVICE-1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const folderOf = url => new URL(url).searchParams.get('folder');

// --- deep link ---------------------------------------------------------------

describe('buildNewSessionUrl', () => {
  test('no folder lets the app choose', () => {
    assert.equal(
      N.buildNewSessionUrl('', HOME),
      'claude://code/new?source=url_external'
    );
    assert.equal(
      N.buildNewSessionUrl(undefined, HOME),
      'claude://code/new?source=url_external'
    );
    assert.equal(
      N.buildNewSessionUrl('   ', HOME),
      'claude://code/new?source=url_external'
    );
    assert.equal(
      N.buildNewSessionUrl(null, HOME),
      'claude://code/new?source=url_external'
    );
  });

  test('an absolute folder is passed as is', () => {
    const url = N.buildNewSessionUrl('/Users/you/work/demo', HOME);
    assert.equal(
      url,
      'claude://code/new?folder=%2FUsers%2Fyou%2Fwork%2Fdemo&source=url_external'
    );
    assert.equal(folderOf(url), '/Users/you/work/demo');
  });

  test('~ expands to the home folder', () => {
    assert.equal(folderOf(N.buildNewSessionUrl('~', HOME)), HOME);
    assert.equal(
      folderOf(N.buildNewSessionUrl('~/work/demo', HOME)),
      '/Users/you/work/demo'
    );
    assert.equal(
      N.buildNewSessionUrl('~/work/demo/', HOME),
      'claude://code/new?folder=%2FUsers%2Fyou%2Fwork%2Fdemo&source=url_external'
    );
  });

  test('relative paths resolve against the home folder', () => {
    assert.equal(
      folderOf(N.buildNewSessionUrl('work/demo', HOME)),
      '/Users/you/work/demo'
    );
    assert.equal(
      folderOf(N.buildNewSessionUrl('/Users/you/work/../demo', HOME)),
      '/Users/you/demo'
    );
  });

  test('spaces and shell characters are encoded', () => {
    const dir = "/Users/you/My Projects/a&b #1 $(x) 'q'";
    const url = N.buildNewSessionUrl(dir, HOME);
    assert.ok(!url.includes(' '), url);
    assert.ok(url.includes('My+Projects'), url);
    assert.equal(folderOf(url), dir);
    assert.equal(new URL(url).searchParams.get('source'), 'url_external');
  });

  test('CJK folder names are percent-encoded UTF-8', () => {
    const url = N.buildNewSessionUrl('~/工作/客户端 重构', HOME);
    assert.match(url, /^[\x21-\x7e]+$/);
    assert.ok(url.includes(encodeURIComponent('客户端')), url);
    assert.equal(folderOf(url), '/Users/you/工作/客户端 重构');
  });

  test('quotes around a pasted path are dropped', () => {
    assert.equal(
      folderOf(N.buildNewSessionUrl('"/Users/you/My Projects"', HOME)),
      '/Users/you/My Projects'
    );
    assert.equal(
      folderOf(N.buildNewSessionUrl("  '~/demo'  ", HOME)),
      '/Users/you/demo'
    );
  });

  test('the key face shows the folder name', () => {
    assert.equal(N.folderName('~/work/demo-app/', HOME), 'demo-app');
    assert.equal(N.folderName('~', HOME), 'you');
    assert.equal(N.folderName('/', HOME), '/');
    assert.equal(N.folderName('', HOME), null);
  });

  test('settings and view texts', () => {
    const en = N.newSessionSettings({ folder: '~/demo' }, HOME);
    assert.deepEqual(en, { folder: '~/demo', folderName: 'demo', lang: 'en' });
    assert.deepEqual(N.buildNewSessionView('ready', en), {
      state: 'ready',
      title: 'New Session',
      subtitle: 'demo',
    });
    assert.equal(N.buildNewSessionView('opening', en).title, 'Opening…');
    assert.deepEqual(N.buildNewSessionView('error', en), {
      state: 'error',
      title: 'Claude app not found',
      subtitle: null,
    });
    const zh = N.newSessionSettings({ lang: 'zh', folder: null }, HOME);
    assert.deepEqual(zh, { folder: '', folderName: null, lang: 'zh' });
    assert.equal(N.buildNewSessionView('ready', zh).title, '新建会话');
    assert.equal(N.buildNewSessionView('opening', zh).title, '正在打开…');
    assert.equal(N.buildNewSessionView('error', zh).title, '未找到 Claude App');
  });
});

// --- opener ------------------------------------------------------------------

const URL_A = 'claude://code/new?folder=%2FUsers%2Fyou%2Fa+b&source=url_external';

describe('openCommand', () => {
  test('macOS uses /usr/bin/open', () => {
    assert.deepEqual(O.openCommand(URL_A, 'darwin'), {
      file: '/usr/bin/open',
      args: [URL_A],
    });
  });
  test('Windows uses the URL protocol handler', () => {
    assert.deepEqual(O.openCommand(URL_A, 'win32'), {
      file: 'rundll32',
      args: ['url.dll,FileProtocolHandler', URL_A],
    });
  });
  test('Linux and others use xdg-open', () => {
    for (const platform of ['linux', 'freebsd']) {
      assert.deepEqual(O.openCommand(URL_A, platform), {
        file: 'xdg-open',
        args: [URL_A],
      });
    }
  });
});

/** An execFile stub that records calls and answers like the real one. */
function fakeExecFile(outcome = {}) {
  const calls = [];
  const fn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (outcome.hang) return {};
    setImmediate(() =>
      callback(outcome.error ?? null, '', outcome.stderr ?? '')
    );
    return {};
  };
  fn.calls = calls;
  return fn;
}

describe('createLauncher', () => {
  test('runs the opener once without a shell', async () => {
    const execFile = fakeExecFile();
    const launch = O.createLauncher({ platform: 'darwin', execFile });
    await launch(URL_A);
    assert.deepEqual(execFile.calls, [
      { file: '/usr/bin/open', args: [URL_A], options: { windowsHide: true } },
    ]);
  });

  test('a failing opener rejects without echoing the folder', async () => {
    const error = Object.assign(new Error(`Command failed: open ${URL_A}`), {
      code: 1,
    });
    const execFile = fakeExecFile({
      error,
      stderr: `No application knows how to open URL ${URL_A} (Error -10814)\n`,
    });
    const launch = O.createLauncher({ platform: 'darwin', execFile });
    await assert.rejects(launch(URL_A), err => {
      assert.ok(err instanceof O.OpenUrlError);
      assert.equal(err.code, 1);
      assert.match(err.message, /^\/usr\/bin\/open failed \(1\): No app/);
      assert.ok(err.message.includes('claude://code/new'), err.message);
      assert.ok(!err.message.includes('Users'), err.message);
      return true;
    });
  });

  test('a missing opener is reported as not found', async () => {
    const error = Object.assign(new Error('spawn xdg-open ENOENT'), {
      code: 'ENOENT',
    });
    const launch = O.createLauncher({
      platform: 'linux',
      execFile: fakeExecFile({ error }),
    });
    await assert.rejects(launch(URL_A), /^OpenUrlError: xdg-open not found$/);
  });

  test('an opener that keeps running counts as launched', async () => {
    const execFile = fakeExecFile({ hang: true });
    const launch = O.createLauncher({
      platform: 'linux',
      execFile,
      settleMs: 20,
    });
    await launch(URL_A);
    assert.equal(execFile.calls.length, 1);
  });
});

// --- key ---------------------------------------------------------------------

function makeKeys(overrides = {}) {
  const sent = [];
  const views = [];
  const warnings = [];
  const launches = [];
  let clock = 1_000_000;
  let chain = Promise.resolve();
  const deps = {
    enqueue: task => {
      chain = chain.then(task).catch(() => undefined);
      return chain;
    },
    send: async (serialNumber, key, image) => {
      sent.push({ serialNumber, uid: key.uid, image });
    },
    isOffline: () => false,
    keyWidth: key => Number(key.width) || 120,
    bgColor: key => key.style?.bgColor,
    logger: { info: () => undefined, warn: (...a) => warnings.push(a.join(' ')) },
    launch: async url => {
      launches.push(url);
    },
    render: (width, view, options) => {
      views.push({ width, ...view, ...options });
      return `data:image/png;base64,${views.length}`;
    },
    now: () => clock,
    home: HOME,
    timings: { openingMs: 40, errorMs: 80, debounceMs: 1_000 },
    ...overrides,
  };
  const keys = new K.NewSessionKeys(deps);
  return {
    keys,
    sent,
    views,
    warnings,
    launches,
    tick: ms => {
      clock += ms;
    },
    settle: () => chain,
  };
}

const key = (uid, data = {}, extra = {}) => ({
  uid,
  cid: CID,
  width: 120,
  data: { folder: '', ...data },
  ...extra,
});

describe('NewSessionKeys', () => {
  test('alive draws its own keys only, once', async () => {
    const t = makeKeys();
    await t.keys.alive(SERIAL, [
      key(1),
      { uid: 2, cid: 'dev.sese.flexbar_claude_code_usage.usage' },
      key(3, { lang: 'zh' }),
    ]);
    assert.deepEqual(
      t.sent.map(s => s.uid),
      [1, 3]
    );
    assert.deepEqual(
      t.views.map(v => v.title),
      ['New Session', '新建会话']
    );
    await t.keys.redraw();
    await sleep(60);
    assert.equal(t.sent.length, 2, 'no periodic or repeated draws');
  });

  test('alive again repaints (the page was reloaded)', async () => {
    const t = makeKeys();
    await t.keys.alive(SERIAL, [key(1)]);
    await t.keys.alive(SERIAL, [key(1, { folder: '~/demo' })]);
    assert.equal(t.sent.length, 2);
    assert.equal(t.views[1].subtitle, 'demo');
  });

  test('press launches the deep link once with the exact URL', async () => {
    const t = makeKeys();
    await t.keys.alive(SERIAL, [key(1, { folder: '~/My Projects/演示' })]);
    const launched = await t.keys.press(
      SERIAL,
      key(1, { folder: '~/My Projects/演示' })
    );
    assert.equal(launched, true);
    assert.deepEqual(t.launches, [
      'claude://code/new?folder=%2FUsers%2Fyou%2FMy+Projects%2F' +
        encodeURIComponent('演示') +
        '&source=url_external',
    ]);
  });

  test('press hands the URL to the platform opener', async () => {
    const execFile = fakeExecFile();
    const t = makeKeys({
      launch: O.createLauncher({ platform: 'win32', execFile }),
    });
    await t.keys.alive(SERIAL, [key(1)]);
    await t.keys.press(SERIAL, key(1));
    assert.deepEqual(execFile.calls, [
      {
        file: 'rundll32',
        args: [
          'url.dll,FileProtocolHandler',
          'claude://code/new?source=url_external',
        ],
        options: { windowsHide: true },
      },
    ]);
  });

  test('presses within a second are ignored', async () => {
    const t = makeKeys();
    await t.keys.alive(SERIAL, [key(1), key(2)]);
    assert.equal(await t.keys.press(SERIAL, key(1)), true);
    t.tick(400);
    assert.equal(await t.keys.press(SERIAL, key(1)), false);
    t.tick(599);
    assert.equal(await t.keys.press(SERIAL, key(1)), false);
    // another key is not affected
    assert.equal(await t.keys.press(SERIAL, key(2)), true);
    t.tick(1_000);
    assert.equal(await t.keys.press(SERIAL, key(1)), true);
    assert.equal(t.launches.length, 3);
  });

  test('a press shows "Opening…", then the normal face', async () => {
    const t = makeKeys();
    await t.keys.alive(SERIAL, [key(1, { folder: '~/demo' })]);
    await t.keys.press(SERIAL, key(1, { folder: '~/demo' }));
    await t.settle();
    assert.deepEqual(
      t.views.map(v => [v.state, v.title, v.subtitle]),
      [
        ['ready', 'New Session', 'demo'],
        ['opening', 'Opening…', 'demo'],
      ]
    );
    await sleep(150);
    await t.settle();
    assert.deepEqual(t.views.at(-1), {
      width: 120,
      state: 'ready',
      title: 'New Session',
      subtitle: 'demo',
      bgColor: undefined,
    });
    assert.equal(t.views.length, 3);
    assert.equal(t.warnings.length, 0);
  });

  test('a failed launch shows "Claude app not found" for a while', async () => {
    const t = makeKeys({
      launch: async () => {
        throw new O.OpenUrlError('/usr/bin/open failed (1): no handler', 1);
      },
      timings: { openingMs: 40, errorMs: 250 },
    });
    await t.keys.alive(SERIAL, [key(1, { lang: 'zh' })]);
    assert.equal(await t.keys.press(SERIAL, key(1, { lang: 'zh' })), false);
    await t.settle();
    assert.deepEqual(
      t.views.map(v => v.title),
      ['新建会话', '正在打开…', '未找到 Claude App']
    );
    assert.equal(t.warnings.length, 1);
    assert.match(t.warnings[0], /could not open the Claude app/);
    assert.ok(!t.warnings[0].includes('Users'), t.warnings[0]);
    // still showing the error after the "Opening…" time…
    await sleep(100);
    await t.settle();
    assert.equal(t.views.at(-1).state, 'error');
    // …and back to normal after the error time
    await sleep(250);
    await t.settle();
    assert.equal(t.views.at(-1).state, 'ready');
  });

  test('a press with a new width or color redraws at that size', async () => {
    const t = makeKeys({ timings: { openingMs: 10, errorMs: 10 } });
    await t.keys.alive(SERIAL, [key(1)]);
    await t.keys.press(
      SERIAL,
      key(1, {}, { width: 240, style: { bgColor: '#123456' } })
    );
    await sleep(30);
    await t.settle();
    assert.deepEqual(t.views.at(-1), {
      width: 240,
      state: 'ready',
      title: 'New Session',
      subtitle: null,
      bgColor: '#123456',
    });
    // a debounced press still picks up the new copy of the key
    await t.keys.press(SERIAL, key(1, {}, { width: 180 }));
    await t.settle();
    assert.equal(t.views.at(-1).width, 180);
    assert.equal(t.launches.length, 1);
  });

  test('dead keys and offline devices are not drawn', async () => {
    let offline = false;
    const t = makeKeys({ isOffline: () => offline });
    await t.keys.alive(SERIAL, [key(1), key(2)]);
    assert.equal(t.sent.length, 2);
    await t.keys.press(SERIAL, key(1));
    await t.keys.dead(SERIAL, [{ uid: 1 }]);
    await sleep(60);
    await t.settle();
    // only the "Opening…" draw happened before key 1 died
    assert.deepEqual(
      t.sent.map(s => s.uid),
      [1, 2, 1]
    );
    offline = true;
    await t.keys.alive(SERIAL, [key(2)]);
    assert.equal(t.sent.length, 3);
    await t.keys.dead(SERIAL, []);
    offline = false;
    await t.keys.redraw();
    assert.equal(t.sent.length, 3);
  });

  test('a rejected draw is logged, not thrown', async () => {
    const t = makeKeys({
      send: async () => {
        throw new Error('key is not alive');
      },
    });
    await t.keys.alive(SERIAL, [key(1)]);
    assert.equal(t.warnings.length, 1);
    assert.match(t.warnings[0], /Could not draw new session key 1/);
  });
});

// --- render ------------------------------------------------------------------

async function decode(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  return loadImage(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

describe('renderNewSessionKey', () => {
  const settings = [
    N.newSessionSettings({ lang: 'en', folder: '' }, HOME),
    N.newSessionSettings({ lang: 'en', folder: '~/work/demo-app' }, HOME),
    N.newSessionSettings({ lang: 'zh', folder: '~/工作/演示' }, HOME),
  ];

  test('every state renders at the key size', async () => {
    for (const width of [60, 80, 100, 101, 120, 180, 240, 479.6]) {
      for (const s of settings) {
        for (const state of ['ready', 'opening', 'error']) {
          const view = N.buildNewSessionView(state, s);
          const img = await decode(R.renderNewSessionKey(width, view));
          assert.equal(img.width, Math.round(width));
          assert.equal(img.height, 60);
        }
      }
    }
  });

  test('the icon is Claude orange and the custom background is used', async () => {
    const { createCanvas } = require('@napi-rs/canvas');
    for (const width of [60, 120, 240]) {
      const view = N.buildNewSessionView('ready', settings[1]);
      const img = await decode(
        R.renderNewSessionKey(width, view, { bgColor: '#1d3b6e' })
      );
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      assert.deepEqual(pixel(0, 0), [0x1d, 0x3b, 0x6e, 255]);
      assert.deepEqual(pixel(width - 1, 59), [0x1d, 0x3b, 0x6e, 255]);
      // a point inside the circle, off the "+" arms
      const cx = width <= 100 ? width / 2 : width < 150 ? 21 : 28;
      assert.deepEqual(pixel(Math.round(cx - 6), 24), [0xd9, 0x77, 0x57, 255]);
    }
  });
});
