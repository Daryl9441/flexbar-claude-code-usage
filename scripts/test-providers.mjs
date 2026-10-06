// Tests for the provider layer shared by every AI provider: key ids and the
// manifest, the provider kit (errors, marks, statuses), the generic usage,
// session and new-session key groups, and the command/terminal launchers.
// Run against the tsc output (see `npm run test:providers`). Nothing here
// opens a link, starts a program or makes a network request: launchers,
// execFile and file writes are stubs. All values are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const build =
  process.env.PROVIDERS_TEST_BUILD ?? path.join(root, '.test-build-providers');
const req = p => require(path.join(build, p));
const Kit = req('providers/kit.js');
const { UsageKeys } = req('usageKey.js');
const SK = req('sessionKey.js');
const NK = req('newSessionKey.js');
const L = req('launch.js');
const R = req('render.js');
const U = req('usage.js');
const SR = req('sessionRender.js');
const V = req('sessionView.js');
const { KIMI_BRAND } = req('providers/kimi/brand.js');
const { GEMINI_BRAND } = req('providers/gemini/brand.js');
const { CLAUDE_BRAND } = req('providers/claude/brand.js');
const ClaudeFace = req('providers/claude/usageFace.js');
const D = req('usageDualRender.js');
const KimiPaths = req('providers/kimi/paths.js');
const GeminiPaths = req('providers/gemini/paths.js');

globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};

const SERIAL = 'FAKE-DEVICE-1';
const HOME = '/Users/you';
const PLUGIN = 'dev.sese.flexbar_claude_code_usage';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Drawing hooks that record every image, with a settle() for the queue. */
function host(overrides = {}) {
  const sent = [];
  const warnings = [];
  let chain = Promise.resolve();
  const deps = {
    enqueue: task => (chain = chain.then(task).catch(() => undefined)),
    send: async (serialNumber, key, image) =>
      sent.push({ serialNumber, uid: key.uid, image }),
    isOffline: () => false,
    keyWidth: key => key.width,
    bgColor: () => undefined,
    loadConfig: async () => ({}),
    pollIntervalMs: () => 3_600_000,
    logger: {
      info: () => undefined,
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => warnings.push(a.join(' ')),
    },
    ...overrides,
  };
  return {
    deps,
    sent,
    warnings,
    last: uid => sent.filter(s => s.uid === uid).at(-1)?.image,
    settle: async () => {
      let last;
      do {
        last = chain;
        await last;
        await sleep(2);
      } while (last !== chain);
    },
  };
}

// --- ids and manifest ----------------------------------------------------------

const EXPECTED_CIDS = [
  `${PLUGIN}.usage`,
  `${PLUGIN}.session`,
  `${PLUGIN}.newsession`,
  `${PLUGIN}.kimi_usage`,
  `${PLUGIN}.kimi_session`,
  `${PLUGIN}.kimi_newsession`,
  `${PLUGIN}.gemini_usage`,
  `${PLUGIN}.gemini_session`,
  `${PLUGIN}.gemini_newsession`,
];

describe('key ids and manifest', () => {
  const pluginDir = path.join(root, `${PLUGIN}.plugin`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')
  );
  // the manifest's per-language strings (en, zh-CN)
  const { local: locales } = manifest;

  test('keyCid keeps Claude ids and prefixes the others', () => {
    const cids = ['claude', 'kimi', 'gemini'].flatMap(p =>
      ['usage', 'session', 'newsession'].map(k => Kit.keyCid(p, k))
    );
    assert.deepEqual(cids, EXPECTED_CIDS);
    assert.equal(SK.SESSION_CID, `${PLUGIN}.session`);
    assert.equal(NK.NEW_SESSION_CID, `${PLUGIN}.newsession`);
  });

  test('the key library lists every key in order, each with a UI file', () => {
    const children = manifest.keyLibrary.children;
    assert.deepEqual(
      children.map(c => c.cid),
      EXPECTED_CIDS
    );
    for (const child of children) {
      const ui = child.cid.split('.').pop();
      assert.ok(
        fs.existsSync(path.join(pluginDir, 'ui', `${ui}.vue`)),
        `ui/${ui}.vue`
      );
      assert.equal(typeof child.data, 'object', child.cid);
    }
  });

  test('every title and tip has English and Chinese strings', () => {
    const lookup = (strings, ref) =>
      ref
        .replace(/^\$/, '')
        .split('.')
        .reduce((node, part) => node?.[part], strings);
    for (const lang of ['en', 'zh-CN']) {
      const strings = locales[lang];
      for (const ref of [
        manifest.keyLibrary.title,
        ...manifest.keyLibrary.children.flatMap(c => [c.title, c.tip]),
      ]) {
        const text = lookup(strings, ref);
        assert.equal(typeof text, 'string', `${lang} ${ref}`);
        assert.ok(text.trim(), `${lang} ${ref}`);
      }
    }
    assert.equal(locales.en.PluginName, 'AI Coding Usage');
    assert.equal(locales['zh-CN'].PluginName, 'AI 编程用量');
  });

  test('every string a settings page names has English and Chinese text', () => {
    const lookup = (strings, ref) =>
      ref.split('.').reduce((node, part) => node?.[part], strings);
    let refs = 0;
    for (const file of fs.readdirSync(path.join(pluginDir, 'ui'))) {
      const source = fs.readFileSync(path.join(pluginDir, 'ui', file), 'utf8');
      const named = [
        // $t("Group.UI.name") and $t(`Group.UI.${…}`) with a { key: "name" } table
        ...[...source.matchAll(/\$t\(\s*["'](\w+\.UI\.\w+)["']/g)].map(m => m[1]),
        ...[...source.matchAll(/\$t\(\s*`(\w+)\.UI\.\$\{/g)].flatMap(m =>
          [...source.matchAll(/\bkey: "(\w+)"/g)].map(k => `${m[1]}.UI.${k[1]}`)
        ),
      ];
      for (const ref of new Set(named)) {
        refs++;
        for (const lang of ['en', 'zh-CN']) {
          const text = lookup(locales[lang], ref);
          assert.equal(typeof text, 'string', `${file}: ${lang} ${ref}`);
          assert.ok(text.trim(), `${file}: ${lang} ${ref}`);
        }
      }
    }
    assert.ok(refs > 50, `${refs} strings`);
  });
});

// --- kit -----------------------------------------------------------------------

describe('provider kit', () => {
  test('errorKeyText words every code in both languages', () => {
    const codes = [
      'not-installed',
      'not-configured',
      'unsupported',
      'no-credentials',
      'unauthorized',
      'rate-limited',
      'network',
      'parse',
    ];
    for (const lang of ['en', 'zh']) {
      for (const code of codes) {
        const text = Kit.errorKeyText(
          new Kit.ProviderError(code, 'detail for the log'),
          KIMI_BRAND,
          lang
        );
        assert.ok(text.title && text.message, `${lang} ${code}`);
        assert.ok(!text.message.includes('detail for the log'));
      }
    }
    assert.deepEqual(
      Kit.errorKeyText(new Kit.ProviderError('http', 'Failed with HTTP 503'), KIMI_BRAND),
      { title: 'Usage error', message: 'HTTP 503' }
    );
    const custom = new Kit.ProviderError('unsupported', 'x', {
      keyText: {
        en: { title: 'Personal login', message: 'Not supported' },
        zh: { title: '个人账号', message: '已不支持' },
      },
    });
    assert.equal(Kit.errorKeyText(custom, GEMINI_BRAND, 'zh').title, '个人账号');
    // anything else: product name and a credential-free message
    const secret = ['sk-', 'ant-', 'x'.repeat(30)].join('');
    const plain = Kit.errorKeyText(new Error(`boom ${secret}`), GEMINI_BRAND);
    assert.equal(plain.title, 'Gemini CLI');
    assert.ok(!plain.message.includes(secret));
  });

  test('lockoutSeconds only for rate limits', () => {
    assert.equal(
      Kit.lockoutSeconds(
        new Kit.ProviderError('rate-limited', 'x', { retryAfterSeconds: 42 })
      ),
      42
    );
    assert.equal(
      Kit.lockoutSeconds(new Kit.ProviderError('rate-limited', 'x')),
      300
    );
    assert.equal(Kit.lockoutSeconds(new Kit.ProviderError('network', 'x')), null);
    assert.equal(Kit.lockoutSeconds(new Error('x')), null);
  });

  test('markOptions: Clawd is opt-in, other marks opt-out', () => {
    assert.deepEqual(Kit.markOptions(CLAUDE_BRAND, {}), { showClawd: false });
    assert.deepEqual(Kit.markOptions(CLAUDE_BRAND, { showClawd: true }), {
      showClawd: true,
    });
    assert.equal(Kit.markOptions(KIMI_BRAND, {}).mark, KIMI_BRAND.mark);
    assert.deepEqual(Kit.markOptions(KIMI_BRAND, { showMark: false }), {
      showClawd: false,
    });
    assert.equal(Kit.brandMark(CLAUDE_BRAND), undefined);
  });

  test('makeStatus and runningItem build what the list needs', () => {
    const status = Kit.makeStatus({ state: 'question', title: 'Pick a plan' });
    assert.equal(status.confident, true);
    assert.deepEqual(status.options, []);
    assert.equal(status.title, 'Pick a plan');
    const fromTone = Kit.runningItem({ title: 'Demo task', tone: 'working', at: 5 });
    assert.equal(fromTone.group, 'working');
    assert.equal(fromTone.status.title, 'Demo task');
    assert.equal(fromTone.at, 5);
    assert.equal(Kit.runningItem({ title: 'x', tone: 'error' }).group, 'stopped');
    assert.equal(Kit.runningItem({ title: 'x', tone: 'idle' }).group, 'done');
    assert.equal(Kit.runningItem({ title: null, status }).group, 'attention');
    const rows = V.buildListView([fromTone, Kit.runningItem({ title: null })], {
      lang: 'en',
      width: 240,
      page: 0,
    }).rows;
    assert.deepEqual(rows, [
      { tone: 'working', title: 'Demo task' },
      { tone: 'done', title: 'Untitled session' },
    ]);
  });

  test('staticSessionSource reports once after start, never after stop', async () => {
    let changes = 0;
    const notice = Kit.unavailableNotice('not-installed', KIMI_BRAND);
    assert.deepEqual(notice.text, {
      en: 'Install Kimi Code',
      zh: '请先安装 Kimi Code',
    });
    const source = Kit.staticSessionSource({ onChange: () => changes++ }, notice);
    source.start();
    await sleep(5);
    assert.equal(changes, 1);
    assert.deepEqual(source.getStatus('', Date.now(), 1), {
      status: null,
      others: 0,
    });
    assert.deepEqual(source.listRunning('', Date.now(), 1), []);
    assert.equal(source.notice(), notice);
    source.stop();
    await source.rescan();
    assert.equal(changes, 1);
  });
});

// --- data folders --------------------------------------------------------------

describe('data folders', () => {
  test('expandHome and resolveDir', () => {
    assert.equal(Kit.expandHome('~', HOME), HOME);
    assert.equal(Kit.expandHome('~/a b', HOME), '/Users/you/a b');
    assert.equal(Kit.expandHome(' "~/q" ', HOME), '/Users/you/q');
    assert.equal(Kit.expandHome('/abs', HOME), '/abs');
    assert.equal(Kit.resolveDir('~/x', '/env', '/fb', HOME), '/Users/you/x');
    assert.equal(Kit.resolveDir('  ', '/env', '/fb', HOME), '/env');
    assert.equal(Kit.resolveDir(undefined, '', '/fb', HOME), '/fb');
    assert.equal(Kit.resolveDir('rel', undefined, '/fb', HOME), '/Users/you/rel');
  });

  test('Kimi: setting, then environment, then the default', () => {
    assert.equal(KimiPaths.kimiCodeHome({}, {}, HOME), '/Users/you/.kimi-code');
    assert.equal(
      KimiPaths.kimiCodeHome({}, { KIMI_CODE_HOME: '/opt/kc' }, HOME),
      '/opt/kc'
    );
    assert.equal(
      KimiPaths.kimiCodeHome({ kimiDir: '~/k' }, { KIMI_CODE_HOME: '/opt/kc' }, HOME),
      '/Users/you/k'
    );
    assert.equal(
      KimiPaths.kimiDesktopDir({}, 'darwin', {}, HOME),
      '/Users/you/Library/Application Support/kimi-desktop'
    );
    assert.equal(
      KimiPaths.kimiDesktopDir({}, 'linux', {}, HOME),
      '/Users/you/.config/kimi-desktop'
    );
    assert.equal(
      KimiPaths.kimiDesktopDir({ kimiDesktopDir: '~/kd' }, 'darwin', {}, HOME),
      '/Users/you/kd'
    );
  });

  test('Gemini: setting, then $GEMINI_CLI_HOME/.gemini, then ~/.gemini', () => {
    assert.equal(GeminiPaths.geminiHome({}, {}, HOME), '/Users/you/.gemini');
    assert.equal(
      GeminiPaths.geminiHome({}, { GEMINI_CLI_HOME: '/srv/g' }, HOME),
      '/srv/g/.gemini'
    );
    assert.equal(
      GeminiPaths.geminiHome({ geminiDir: '~/g' }, { GEMINI_CLI_HOME: '/srv/g' }, HOME),
      '/Users/you/g'
    );
    assert.equal(GeminiPaths.geminiPathSetting({}, HOME), null);
    assert.equal(
      GeminiPaths.geminiPathSetting({ geminiPath: '~/bin/gemini' }, HOME),
      '/Users/you/bin/gemini'
    );
  });
});

// --- usage keys ----------------------------------------------------------------

const RESETS_AT = '2026-10-05T15:12:00.000Z';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

function usageKeys(source, overrides = {}) {
  const h = host(overrides);
  const cid = Kit.keyCid('kimi', 'usage');
  const keys = new UsageKeys({
    ...h.deps,
    provider: { cid, brand: KIMI_BRAND, source },
  });
  const key = (uid, data = {}, width = 240) => ({ uid, cid, width, data });
  return { ...h, keys, key, cid };
}

async function withClock(now, fn) {
  const real = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

describe('UsageKeys', () => {
  const metrics = [
    { id: '5h', label: '5 hours', percent: 30, resetsAt: RESETS_AT },
    { id: 'weekly', label: 'Weekly', percent: 70, resetsAt: RESETS_AT },
  ];
  const meter = (snapshot, width = 240, data = {}) =>
    R.renderUsageKey(width, snapshot, {
      showResetTime: data.showResetTime !== false,
      ...Kit.markOptions(KIMI_BRAND, data),
      bgColor: undefined,
      dropVersion: true,
    });
  const message = (title, text, width = 240, accent = KIMI_BRAND.accent) =>
    R.renderMessageKey(width, title, text, {
      accent,
      mark: KIMI_BRAND.mark,
      markColor: KIMI_BRAND.accent,
    });
  // error faces word the problem in the status colours, not the accent
  const amber = (title, text) => message(title, text, 240, V.TONE_COLORS.attention);
  const red = (title, text) => message(title, text, 240, V.TONE_COLORS.error);

  test('draws the chosen metric, the first one by default', async () => {
    await withClock(NOW, async () => {
      let fetches = 0;
      const t = usageKeys({
        defaultMetric: '',
        fetch: async () => {
          fetches++;
          return metrics;
        },
      });
      try {
        await t.keys.alive(SERIAL, [
          t.key(1),
          t.key(2, { metric: 'weekly', showMark: false }, 180),
          { uid: 3, cid: `${PLUGIN}.usage`, width: 240 },
        ]);
        await t.settle();
        assert.equal(fetches, 1);
        assert.deepEqual(
          [...new Set(t.sent.map(s => s.uid))].sort(),
          [1, 2],
          'only its own cid'
        );
        assert.equal(t.last(1), await meter(metrics[0]));
        assert.equal(
          t.last(2),
          await meter(metrics[1], 180, { metric: 'weekly', showMark: false })
        );
        // an unknown metric says so instead of showing another one
        await t.keys.alive(SERIAL, [t.key(1, { metric: 'monthly' })]);
        await t.settle();
        assert.equal(t.last(1), message('Kimi Code', 'No data for this limit'));
      } finally {
        t.keys.stop();
      }
    });
  });

  test('missingText words a metric the fetch did not return', async () => {
    await withClock(NOW, async () => {
      const asked = [];
      const t = usageKeys({
        defaultMetric: '',
        fetch: async () => metrics,
        missingText: (id, lang) => {
          asked.push([id, lang]);
          if (id === 'broken') throw new Error('boom');
          if (id !== 'monthly') return null;
          return lang === 'zh'
            ? { title: '未登录', message: '请运行 kimi login' }
            : { title: 'Not logged in', message: 'Run kimi login' };
        },
      });
      try {
        await t.keys.alive(SERIAL, [
          t.key(1, { metric: 'monthly' }),
          t.key(2, { metric: 'monthly', lang: 'zh' }),
          t.key(3, { metric: 'extra' }),
          t.key(4, { metric: 'broken' }),
          t.key(5),
        ]);
        await t.settle();
        assert.equal(t.last(1), message('Not logged in', 'Run kimi login'));
        assert.equal(t.last(2), message('未登录', '请运行 kimi login'));
        // null and a throwing hook keep the generic face
        assert.equal(t.last(3), message('Kimi Code', 'No data for this limit'));
        assert.equal(t.last(4), message('Kimi Code', 'No data for this limit'));
        // never asked for a metric that is there
        assert.equal(t.last(5), await meter(metrics[0]));
        assert.ok(asked.every(([id]) => id !== '5h'));
      } finally {
        t.keys.stop();
      }
    });
  });

  test('substituteMetric draws another metric for one the fetch did not return', async () => {
    await withClock(NOW, async () => {
      const info = [];
      const asked = [];
      const t = usageKeys(
        {
          defaultMetric: '',
          fetch: async () => metrics,
          substituteMetric: (id, list) => {
            asked.push(id);
            if (id === 'broken') throw new Error('boom');
            if (id === 'bogus') return 'not-a-metric';
            if (id === 'context') return null;
            return list[1].id;
          },
          missingText: id =>
            id === 'context' ? { title: 'No context data', message: 'Use Kimi Work first' } : null,
        },
        {
          logger: { info: (...a) => info.push(a.join(' ')), warn: () => undefined, error: () => undefined },
        }
      );
      const notOnPlan = () => info.filter(line => line.includes('is not on this plan'));
      try {
        const keys = [
          t.key(1, { metric: 'monthly' }),
          t.key(2, { metric: 'context' }),
          t.key(3, { metric: 'broken' }),
          t.key(4, { metric: 'bogus' }),
          t.key(5, { metric: '5h' }),
          t.key(6, { metric: 'odd\nid' }, 120),
          t.key(7),
        ];
        await t.keys.alive(SERIAL, keys);
        await t.settle();
        // the stand-in is drawn like a key set to it, chip and all
        assert.equal(t.last(1), await meter(metrics[1]));
        assert.equal(t.last(6), await meter(metrics[1], 120));
        // null, a throwing hook or an id that was not fetched: missingText
        assert.equal(t.last(2), message('No context data', 'Use Kimi Work first'));
        assert.equal(t.last(3), message('Kimi Code', 'No data for this limit'));
        assert.equal(t.last(4), message('Kimi Code', 'No data for this limit'));
        // never asked for a metric that is there, or for the default
        assert.equal(t.last(5), await meter(metrics[0]));
        assert.equal(t.last(7), await meter(metrics[0]));
        assert.deepEqual(asked.sort(), ['bogus', 'broken', 'context', 'monthly', 'odd\nid']);
        // the key's setting is left alone
        assert.equal(keys[0].data.metric, 'monthly');
        assert.ok(
          info.includes(
            `Kimi usage keys alive on ${SERIAL}: uid=1 width=240 metric=monthly, ` +
              'uid=2 width=240 metric=context, uid=3 width=240 metric=broken, ' +
              'uid=4 width=240 metric=bogus, uid=5 width=240 metric=5h, ' +
              'uid=6 width=120 metric=odd?id, uid=7 width=240 metric=default'
          ),
          info.join('\n')
        );

        // one line per key and change, not one per redraw
        await t.keys.drawAll();
        await t.keys.alive(SERIAL, keys);
        await t.settle();
        const first = [
          "Kimi usage key uid=1: limit 'monthly' is not on this plan; showing weekly",
          "Kimi usage key uid=6: limit 'odd?id' is not on this plan; showing weekly",
        ];
        assert.deepEqual(notOnPlan(), first);

        // set to a metric that is there, then back: logged again
        await t.keys.alive(SERIAL, [t.key(1, { metric: '5h' })]);
        await t.settle();
        assert.equal(t.last(1), await meter(metrics[0]));
        await t.keys.alive(SERIAL, [t.key(1, { metric: 'monthly' })]);
        await t.settle();
        assert.deepEqual(notOnPlan(), [...first, first[0]]);
        // a key that left the page is forgotten: back on it, logged again
        await t.keys.dead(SERIAL, [t.key(1)]);
        await t.keys.alive(SERIAL, [t.key(1, { metric: 'monthly' })]);
        await t.settle();
        assert.deepEqual(notOnPlan(), [...first, first[0], first[0]]);
      } finally {
        t.keys.stop();
      }
    });
  });

  test('errors show the code text; Loading… before the first result', async () => {
    let fail = new Kit.ProviderError('not-installed', 'no Kimi Code home');
    const t = usageKeys({
      defaultMetric: '',
      fetch: async () => {
        throw fail;
      },
      minFetchGapMs: 0,
    });
    try {
      await t.keys.alive(SERIAL, [t.key(1), t.key(2, { lang: 'zh' })]);
      await t.settle();
      const firstDraws = t.sent.filter(s => s.uid === 1).map(s => s.image);
      assert.equal(firstDraws[0], message('Kimi Code', 'Loading…'));
      assert.equal(t.last(1), amber('Not installed', 'Install Kimi Code'));
      assert.equal(t.last(2), amber('未安装', '请先安装 Kimi Code'));
      assert.match(t.warnings.join('\n'), /Failed to fetch Kimi usage: ProviderError: no Kimi Code home/);
      // a custom errorText wins
      fail = new Error('anything');
      t.keys['deps'].provider.source.errorText = () => ({
        title: 'Custom',
        message: 'Text',
      });
      await t.keys.press(SERIAL, t.key(1));
      await t.settle();
      assert.equal(t.last(1), red('Custom', 'Text'));
    } finally {
      t.keys.stop();
    }
  });

  test('a rate limit locks out fetching and counts down on the key', async () => {
    let fetches = 0;
    let fail = true;
    const t = usageKeys({
      defaultMetric: '',
      minFetchGapMs: 0,
      fetch: async () => {
        fetches++;
        if (fail) {
          throw new Kit.ProviderError('rate-limited', 'slow down', {
            retryAfterSeconds: 600,
          });
        }
        return metrics;
      },
    });
    try {
      await withClock(NOW, async () => {
        await t.keys.alive(SERIAL, [t.key(1)]);
        await t.settle();
        assert.equal(fetches, 1);
        assert.equal(t.last(1), amber('Rate limited', 'Resumes in 10m'));
        // presses during the lockout do not fetch
        await t.keys.press(SERIAL, t.key(1));
        await t.settle();
        assert.equal(fetches, 1);
        const reply = await t.keys.message({ data: 'usage-status' });
        assert.deepEqual(reply, {
          success: false,
          error: 'Rate limited, retry in 10m',
        });
      });
      // after the lockout the next press fetches again
      fail = false;
      await withClock(NOW + 601_000, async () => {
        await t.keys.press(SERIAL, t.key(1));
        await t.settle();
      });
      assert.equal(fetches, 2);
    } finally {
      t.keys.stop();
    }
  });

  test('Chinese keys: chip texts and countdowns in Chinese', async () => {
    const t = usageKeys({
      defaultMetric: '',
      minFetchGapMs: 0,
      fetch: async () => metrics,
      metricLabel: (metric, lang) => (lang === 'zh' && metric.id === '5h' ? '5小时' : metric.label),
    });
    try {
      await withClock(NOW, async () => {
        await t.keys.alive(SERIAL, [t.key(1, { lang: 'zh' }), t.key(2)]);
        await t.settle();
        const zh = await R.renderUsageKey(240, { ...metrics[0], label: '5小时' }, {
          showResetTime: true,
          ...Kit.markOptions(KIMI_BRAND, {}),
          bgColor: undefined,
          lang: 'zh',
          dropVersion: true,
        });
        assert.equal(t.last(1), zh);
        assert.equal(t.last(2), await meter(metrics[0]));
      });
    } finally {
      t.keys.stop();
    }
    await withClock(NOW, async () => {
      const at = new Date(NOW + (2 * 60 + 15) * 60_000).toISOString();
      assert.equal(U.formatTimeUntilReset(at, 'zh'), '2小时15分');
      assert.equal(U.resetsText(U.formatTimeUntilReset(at, 'zh'), 'zh'), '2小时15分后重置');
      const soon = new Date(NOW + 15 * 60_000).toISOString();
      assert.equal(U.formatTimeUntilReset(soon, 'zh'), '15分钟');
      assert.equal(U.resetsText(U.formatTimeUntilReset(at), 'en'), 'Resets 2h 15m');
      const days = new Date(NOW + (4 * 24 + 3) * 3_600_000).toISOString();
      assert.equal(U.formatTimeUntilReset(days, 'zh'), '4天3小时');
      assert.equal(U.resetsText(U.formatTimeUntilReset(new Date(NOW - 1).toISOString(), 'zh'), 'zh'), '即将重置');
    });
  });

  test('keepLastOnError keeps the meter; the default clears it', async () => {
    for (const keep of [true, false]) {
      let fail = false;
      const t = usageKeys({
        defaultMetric: '',
        minFetchGapMs: 0,
        keepLastOnError: () => keep,
        fetch: async () => {
          if (fail) throw new Kit.ProviderError('network', 'offline');
          return metrics;
        },
      });
      try {
        await withClock(NOW, async () => {
          await t.keys.alive(SERIAL, [t.key(1)]);
          await t.settle();
          fail = true;
          await t.keys.press(SERIAL, t.key(1));
          await t.settle();
          assert.equal(
            t.last(1),
            keep
              ? await meter(metrics[0])
              : red('Network error', 'Check your connection')
          );
        });
      } finally {
        t.keys.stop();
      }
    }
  });

  test('a face that throws is logged and left out', async () => {
    await withClock(NOW, async () => {
      const secret = ['sk-', 'ant-', 'z'.repeat(30)].join('');
      const t = usageKeys({
        defaultMetric: 'both',
        fetch: async () => metrics,
        face: ({ metric }) => {
          if (metric === 'weekly') {
            return Promise.reject(new Error(`async face broke, ${secret}`));
          }
          throw new Error(`face broke, ${secret}`);
        },
      });
      try {
        await t.keys.alive(SERIAL, [
          t.key(1),
          t.key(2, { metric: '5h' }),
          t.key(3, { metric: 'weekly' }),
        ]);
        await t.settle();
        // a view without a metric of its own says so, single limits get
        // the meter, and nothing keeps showing "Loading…"
        assert.equal(t.last(1), message('Kimi Code', 'No data for this limit'));
        assert.equal(t.last(2), await meter(metrics[0]));
        assert.equal(t.last(3), await meter(metrics[1]));
        const log = t.warnings.join('\n');
        assert.match(log, /Kimi usage key face failed: face broke/);
        assert.match(log, /Kimi usage key face failed: async face broke/);
        assert.doesNotMatch(log, /Could not draw key/);
        assert.ok(!log.includes(secret), log);
      } finally {
        t.keys.stop();
      }
    });
  });

  test('settings messages list metrics or the log-safe error', async () => {
    const ok = usageKeys({ defaultMetric: '', fetch: async () => metrics });
    assert.deepEqual(await ok.keys.message({ data: 'usage-status' }), {
      success: true,
      metrics,
    });
    assert.equal(await ok.keys.message({ data: 'session-status' }), undefined);
    const secret = ['sk-', 'ant-', 'y'.repeat(30)].join('');
    const bad = usageKeys({
      defaultMetric: '',
      fetch: async () => {
        throw new Error(`token ${secret} rejected`);
      },
    });
    const reply = await bad.keys.message({ data: 'usage-status' });
    assert.equal(reply.success, false);
    assert.ok(!reply.error.includes(secret), reply.error);
    const own = usageKeys({
      defaultMetric: '',
      fetch: async () => metrics,
      describe: async (config, data) => ({
        success: true,
        saw: config.kimiDir,
        data,
      }),
    });
    assert.deepEqual(
      await own.keys.message({
        data: 'usage-status',
        config: { kimiDir: '~/k' },
        settings: { metric: 'weekly' },
      }),
      { success: true, saw: '~/k', data: { metric: 'weekly' } }
    );
  });
});

// --- session keys --------------------------------------------------------------

describe('SessionKeys with another provider', () => {
  test('shows the notice, the status, and the running list', async () => {
    const cid = Kit.keyCid('gemini', 'session');
    let notice = Kit.unavailableNotice('not-configured', GEMINI_BRAND);
    let status = null;
    const running = [Kit.runningItem({ title: 'Write tests', tone: 'attention' })];
    let onChange = null;
    const seen = {};
    const sessions = {
      location: config => config.geminiDir ?? '/Users/you/.gemini',
      create: options => {
        seen.location = options.location;
        onChange = options.onChange;
        return {
          start: () => setImmediate(options.onChange),
          stop: () => undefined,
          rescan: async () => options.onChange(),
          setFilters: filters => (seen.filters = filters),
          setRunningWindow: ms => (seen.window = ms),
          getStatus: (_f, _n, _i, data) => {
            seen.statusData = data;
            return { status, others: 0 };
          },
          listRunning: (_f, _n, _i, data) => {
            seen.listData = data;
            return running;
          },
          notice: data => {
            seen.noticeData = data;
            return notice;
          },
        };
      },
      describe: async (filter, _config, data) => ({
        success: false,
        projectsDir: null,
        state: null,
        project: null,
        title: null,
        others: 0,
        filter,
        data,
      }),
    };
    const h = host();
    const keys = new SK.SessionKeys({
      ...h.deps,
      provider: { cid, brand: GEMINI_BRAND, sessions },
    });
    const key = {
      uid: 1,
      cid,
      width: 240,
      data: { projectFilter: 'Demo', idleMinutes: 5, lang: 'en' },
    };
    const face = view =>
      SR.renderSessionKey(240, view, {
        ...Kit.markOptions(GEMINI_BRAND, key.data),
        bgColor: undefined,
      });
    try {
      await keys.alive(SERIAL, [key, { uid: 2, cid: SK.SESSION_CID }]);
      await sleep(10);
      await h.settle();
      assert.equal(seen.location, '/Users/you/.gemini');
      assert.deepEqual(seen.filters, ['Demo']);
      assert.equal(seen.window, 5 * 60_000);
      assert.deepEqual([...new Set(h.sent.map(s => s.uid))], [1]);
      assert.equal(
        h.last(1),
        await face(V.buildNoticeView(notice, 'en'))
      );

      // no notice: the usual "No sessions" face names the product
      notice = null;
      onChange();
      await h.settle();
      assert.equal(
        h.last(1),
        await face(
          V.buildSessionView(null, {
            lang: 'en',
            showProject: true,
            now: Date.now(),
            productName: 'Gemini CLI',
          })
        )
      );
      const view = V.buildSessionView(null, {
        lang: 'en',
        showProject: true,
        now: 0,
        productName: 'Gemini CLI',
      });
      assert.equal(view.text, 'Start Gemini CLI');

      // a status wins over the notice
      notice = Kit.unavailableNotice('not-installed', GEMINI_BRAND);
      status = Kit.makeStatus({ state: 'working', title: 'Write tests' });
      onChange();
      await h.settle();
      assert.equal(
        h.last(1),
        await face(
          V.buildSessionView(status, {
            lang: 'en',
            showProject: true,
            now: Date.now(),
            productName: 'Gemini CLI',
          })
        )
      );

      // a press opens the running list, with the brand edge
      await keys.press(SERIAL, key);
      await h.settle();
      assert.equal(
        h.last(1),
        await SR.renderSessionList(
          240,
          V.buildListView(running, { lang: 'en', width: 240, page: 0 }),
          { markColor: GEMINI_BRAND.accent }
        )
      );
      // the key's settings reach the source and the settings page reply
      assert.deepEqual(seen.statusData, key.data);
      assert.deepEqual(seen.listData, key.data);
      assert.deepEqual(seen.noticeData, key.data, 'notice() gets the key settings');
      assert.deepEqual(
        await keys.message({
          data: 'session-status',
          filter: 'x',
          settings: { source: 'cli' },
        }),
        {
          success: false,
          projectsDir: null,
          state: null,
          project: null,
          title: null,
          others: 0,
          filter: 'x',
          data: { source: 'cli' },
        }
      );
    } finally {
      await keys.dead(SERIAL, []);
    }
  });

  test('a provider that throws shows an error face instead of crashing', async () => {
    const cid = Kit.keyCid('kimi', 'session');
    const h = host();
    const keys = new SK.SessionKeys({
      ...h.deps,
      provider: {
        cid,
        brand: KIMI_BRAND,
        sessions: {
          location: () => {
            throw new Error('bad location');
          },
          create: () => {
            throw new Error('bad source');
          },
          describe: async () => ({}),
        },
      },
    });
    try {
      await keys.alive(SERIAL, [{ uid: 1, cid, width: 120, data: {} }]);
      await sleep(10);
      await h.settle();
      assert.equal(h.sent.length >= 1, true);
      assert.match(h.warnings.join('\n'), /Kimi session keys: could not start/);
      // drawn red, like a session in the error state
      const broken = V.buildNoticeView(
        {
          label: { en: 'Error', zh: '出错' },
          text: { en: 'Could not read sessions', zh: '无法读取会话' },
          tone: 'error',
        },
        'en'
      );
      assert.equal(broken.tone, 'error');
      assert.equal(
        h.last(1),
        await SR.renderSessionKey(120, broken, Kit.markOptions(KIMI_BRAND, {}))
      );
    } finally {
      await keys.dead(SERIAL, []);
    }
  });
});

// --- Claude's log lines ----------------------------------------------------------

describe('Claude keys keep their log wording', () => {
  test('usage: "Usage keys alive", "Usage endpoint rate limited"', async () => {
    const info = [];
    const warn = [];
    const h = host({
      logger: { info: (...a) => info.push(a.join(' ')), warn: (...a) => warn.push(a.join(' ')), error: () => undefined },
    });
    const cid = Kit.keyCid('claude', 'usage');
    const keys = new UsageKeys({
      ...h.deps,
      provider: {
        cid,
        brand: CLAUDE_BRAND,
        source: {
          defaultMetric: 'session',
          minFetchGapMs: 0,
          fetch: async () => {
            throw new Kit.ProviderError('rate-limited', 'slow down', { retryAfterSeconds: 60 });
          },
        },
      },
    });
    try {
      await keys.alive(SERIAL, [{ uid: 1, cid, width: 240, data: {} }]);
      await h.settle();
      assert.ok(info.includes(`Usage keys alive on ${SERIAL}: uid=1 width=240 metric=default`), info.join('\n'));
      assert.ok(warn.includes('Usage endpoint rate limited, backing off for 60s'), warn.join('\n'));
    } finally {
      keys.stop();
    }
  });

  test('sessions: "Session keys: watching <claudeDir>/projects"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-log-test-'));
    const info = [];
    const h = host({
      loadConfig: async () => ({ claudeDir: dir }),
      logger: { info: (...a) => info.push(a.join(' ')), warn: () => undefined, error: () => undefined },
    });
    const keys = new SK.SessionKeys({ ...h.deps });
    try {
      await keys.alive(SERIAL, [{ uid: 1, cid: SK.SESSION_CID, width: 240, data: {} }]);
      assert.ok(info.includes(`Session keys: watching ${path.join(dir, 'projects')}`), info.join('\n'));
    } finally {
      await keys.dead(SERIAL, []);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Claude Usage: the dual face -------------------------------------------------

describe("Claude Usage key: 5 hours + weekly (remaining)", () => {
  const session = {
    id: 'session',
    label: 'Session',
    tag: '5h',
    percent: 30,
    resetsAt: RESETS_AT,
  };
  const weekly = {
    id: 'weekly',
    label: 'Weekly',
    tag: '7d',
    percent: 85,
    resetsAt: '2026-10-08T12:00:00.000Z',
  };
  const model = {
    id: 'weekly_model',
    label: 'Opus',
    percent: 10,
    resetsAt: RESETS_AT,
  };

  function claudeKeys(metrics, overrides = {}) {
    const h = host(overrides);
    const cid = Kit.keyCid('claude', 'usage');
    const keys = new UsageKeys({
      ...h.deps,
      provider: {
        cid,
        brand: CLAUDE_BRAND,
        source: {
          defaultMetric: ClaudeFace.DUAL_METRIC,
          face: ClaudeFace.claudeUsageFace,
          fetch: async () => metrics,
        },
      },
    });
    const key = (uid, data = {}, width = 120) => ({ uid, cid, width, data });
    return { ...h, keys, key };
  }

  test('is the default and draws exactly what renderDualUsageKey draws', async () => {
    await withClock(NOW, async () => {
      const t = claudeKeys([session, weekly, model]);
      try {
        await t.keys.alive(SERIAL, [
          t.key(1),
          t.key(2, { metric: 'dual', showResetTime: false }, 240),
          t.key(3, { metric: 'dual', showClawd: true }, 60),
        ]);
        await t.settle();
        assert.equal(ClaudeFace.DUAL_METRIC, 'dual');
        assert.equal(
          t.last(1),
          D.renderDualUsageKey(120, session, weekly, { showResetTime: true })
        );
        assert.equal(
          t.last(2),
          D.renderDualUsageKey(240, session, weekly, { showResetTime: false })
        );
        // the dual face has no Clawd
        assert.equal(
          t.last(3),
          D.renderDualUsageKey(60, session, weekly, { showResetTime: true })
        );
      } finally {
        t.keys.stop();
      }
    });
  });

  test("uses the key's own background colour", async () => {
    await withClock(NOW, async () => {
      const t = claudeKeys([session, weekly], { bgColor: () => '#f5f5f4' });
      try {
        await t.keys.alive(SERIAL, [t.key(1)]);
        await t.settle();
        assert.equal(
          t.last(1),
          D.renderDualUsageKey(120, session, weekly, {
            showResetTime: true,
            bgColor: '#f5f5f4',
          })
        );
      } finally {
        t.keys.stop();
      }
    });
  });

  test('one missing limit is a muted row, both missing say so', async () => {
    await withClock(NOW, async () => {
      const t = claudeKeys([weekly]);
      try {
        await t.keys.alive(SERIAL, [t.key(1)]);
        await t.settle();
        assert.equal(
          t.last(1),
          D.renderDualUsageKey(120, null, weekly, { showResetTime: true })
        );
      } finally {
        t.keys.stop();
      }
      const none = claudeKeys([model]);
      try {
        await none.keys.alive(SERIAL, [none.key(1), none.key(2, {}, 240)]);
        await none.settle();
        assert.equal(
          none.last(1),
          R.renderMessageKey(120, 'Claude Code', 'No data for these limits')
        );
        assert.equal(
          none.last(2),
          R.renderMessageKey(240, 'Claude Code', 'No data for these limits', {
            accent: CLAUDE_BRAND.accent,
          })
        );
      } finally {
        none.keys.stop();
      }
    });
  });

  test('a single limit stays the used-% meter, with its short tag', async () => {
    await withClock(NOW, async () => {
      const t = claudeKeys([session, weekly, model]);
      try {
        await t.keys.alive(SERIAL, [
          t.key(1, { metric: 'session' }),
          t.key(2, { metric: 'weekly', showClawd: true }, 240),
          t.key(3, { metric: 'weekly_model' }, 240),
        ]);
        await t.settle();
        assert.equal(
          t.last(1),
          await R.renderUsageKey(120, session, {
            showResetTime: true,
            showClawd: false,
          })
        );
        assert.equal(
          t.last(2),
          await R.renderUsageKey(240, weekly, {
            showResetTime: true,
            showClawd: true,
          })
        );
        assert.equal(
          t.last(3),
          await R.renderUsageKey(240, model, {
            showResetTime: true,
            showClawd: false,
          })
        );
      } finally {
        t.keys.stop();
      }
    });
  });

  test('model chips keep their version on narrow keys', async () => {
    await withClock(NOW, async () => {
      const sonnet = { ...model, label: 'Claude 3.7 Sonnet' };
      const t = claudeKeys([session, weekly, sonnet]);
      try {
        await t.keys.alive(SERIAL, [
          t.key(1, { metric: 'weekly_model' }, 180),
          t.key(2, { metric: 'weekly_model', showClawd: true }, 240),
        ]);
        await t.settle();
        for (const [uid, width, showClawd] of [
          [1, 180, false],
          [2, 240, true],
        ]) {
          const options = { showResetTime: true, showClawd };
          assert.equal(t.last(uid), await R.renderUsageKey(width, sonnet, options));
          // "3.7 Sonnet", not the "Sonnet" other providers' chips would show
          assert.notEqual(
            t.last(uid),
            await R.renderUsageKey(width, sonnet, { ...options, dropVersion: true }),
            `${width}`
          );
        }
      } finally {
        t.keys.stop();
      }
    });
  });

  test('the face only answers for the dual metric', () => {
    const request = metric => ({
      metric,
      metrics: [session, weekly],
      width: 120,
      showResetTime: true,
      lang: 'en',
      data: {},
    });
    for (const metric of ['session', 'weekly', 'weekly_model', '', '5h']) {
      assert.equal(ClaudeFace.claudeUsageFace(request(metric)), null, metric);
    }
    assert.equal(typeof ClaudeFace.claudeUsageFace(request('dual')).image, 'string');
  });
});

// --- provider identity at every width --------------------------------------------

describe('narrow keys still name their provider', () => {
  const snapshot = { label: 'Weekly', percent: 64, resetsAt: null };
  const usage = (brand, width) =>
    R.renderUsageKey(width, snapshot, {
      showResetTime: true,
      ...Kit.markOptions(brand, {}),
    });
  const session = (brand, width) =>
    SR.renderSessionKey(
      width,
      V.buildSessionView(Kit.makeStatus({ state: 'working', title: 'Write tests' }), {
        lang: 'en',
        showProject: false,
        now: 0,
      }),
      Kit.markOptions(brand, {})
    );
  const list = (brand, width) =>
    SR.renderSessionList(
      width,
      V.buildListView([Kit.runningItem({ title: 'Write tests', tone: 'working' })], {
        lang: 'en',
        width,
        page: 0,
      }),
      { markColor: Kit.markOptions(brand, {}).markColor }
    );

  test('usage, session and list faces differ per provider at 120 px', async () => {
    for (const render of [usage, session, list]) {
      const faces = await Promise.all([CLAUDE_BRAND, KIMI_BRAND, GEMINI_BRAND].map(b => render(b, 120)));
      assert.equal(new Set(faces).size, 3, render.name);
    }
    // Claude's faces keep their look (no mark, no edge)
    assert.equal(
      await usage(CLAUDE_BRAND, 120),
      await R.renderUsageKey(120, snapshot, { showResetTime: true, showClawd: false })
    );
  });

  test('message faces too narrow for the mark get the brand edge', () => {
    const face = brand =>
      R.renderMessageKey(80, 'Not installed', 'Install it', {
        accent: V.TONE_COLORS.attention,
        mark: Kit.brandMark(brand),
        markColor: brand.accent,
      });
    assert.notEqual(face(KIMI_BRAND), face(GEMINI_BRAND));
  });

  test('model chips drop the version before they are cut', async () => {
    const chip = (label, width) =>
      R.renderUsageKey(width, { label, percent: 40, resetsAt: null }, {
        showResetTime: false,
        ...Kit.markOptions(GEMINI_BRAND, {}),
        dropVersion: true,
      });
    for (const width of [120, 180]) {
      assert.equal(await chip('2.5 Flash Lite', width), await chip('Flash Lite', width), `${width}`);
    }
    // in full where it fits
    assert.notEqual(await chip('2.5 Flash Lite', 460), await chip('Flash Lite', 460));
  });
});

// --- new session keys ----------------------------------------------------------

describe('NewSessionKeys with another provider', () => {
  function newSessionKeys(target, strings, hostOverrides = {}, extra = {}) {
    const cid = Kit.keyCid('kimi', 'newsession');
    const calls = [];
    const views = [];
    const h = host(hostOverrides);
    const keys = new NK.NewSessionKeys({
      ...h.deps,
      provider: {
        cid,
        brand: KIMI_BRAND,
        launcher: { appName: 'Kimi', strings, target, ...extra },
      },
      launch: async url => calls.push(['url', url]),
      run: async command => calls.push(['run', command]),
      terminal: async (command, cwd) => calls.push(['terminal', command, cwd]),
      render: (width, view, options) => {
        views.push({ width, ...view, ...options });
        return `data:image/png;base64,${views.length}`;
      },
      home: HOME,
      platform: 'darwin',
      timings: { openingMs: 5, errorMs: 5, debounceMs: 0 },
    });
    const key = (uid, data = {}) => ({ uid, cid, width: 120, data });
    return { keys, calls, views, key, h };
  }

  test('url, command and terminal targets go to their opener', async () => {
    const requests = [];
    const targets = [
      { kind: 'url', url: 'kimi-work://open' },
      { kind: 'command', file: '/usr/bin/true', args: ['a'], cwd: '/tmp' },
      { kind: 'terminal', command: ['kimi', '--plan'], cwd: null },
    ];
    const t = newSessionKeys(request => {
      requests.push(request);
      return targets[requests.length - 1];
    });
    await t.keys.alive(SERIAL, [t.key(1, { folder: '~/work/demo' })]);
    for (let i = 0; i < 3; i++) {
      assert.equal(await t.keys.press(SERIAL, t.key(1, { folder: '~/work/demo' })), true);
    }
    assert.deepEqual(t.calls, [
      ['url', 'kimi-work://open'],
      ['run', { file: '/usr/bin/true', args: ['a'], cwd: '/tmp' }],
      ['terminal', ['kimi', '--plan'], null],
    ]);
    assert.deepEqual(requests[0], {
      data: { folder: '~/work/demo' },
      rawFolder: '~/work/demo',
      folder: '/Users/you/work/demo',
      home: HOME,
      platform: 'darwin',
      config: {},
    });
    // the face uses Kimi's look and default texts
    assert.deepEqual(t.views[0], {
      width: 120,
      state: 'ready',
      title: 'New Session',
      subtitle: 'demo',
      bgColor: undefined,
      accent: KIMI_BRAND.accent,
      mark: KIMI_BRAND.mark,
    });
  });

  test('a failing target shows the provider error text', async () => {
    const t = newSessionKeys(
      () => {
        throw new Kit.ProviderError('not-installed', 'no kimi binary');
      },
      { error: { en: 'Kimi not found', zh: '未找到 Kimi' } }
    );
    await t.keys.alive(SERIAL, [t.key(1, { lang: 'zh' })]);
    assert.equal(await t.keys.press(SERIAL, t.key(1, { lang: 'zh' })), false);
    await t.h.settle();
    assert.deepEqual(
      t.views.map(v => v.title),
      ['新建会话', '正在打开…', '未找到 Kimi']
    );
    assert.deepEqual(t.calls, []);
    assert.match(t.h.warnings.join('\n'), /could not open Kimi: no kimi binary/);
  });

  test('a launcher error with its own key text names the problem', async () => {
    const t = newSessionKeys(request => {
      const keyText =
        request.data.kind === 'one'
          ? { title: 'Gemini CLI not found', message: 'Install it' }
          : {
              en: { title: 'Folder not found', message: '' },
              zh: { title: '未找到文件夹', message: '' },
            };
      throw new Kit.ProviderError('not-installed', 'missing', { keyText });
    });
    await t.keys.alive(SERIAL, [t.key(1, { kind: 'one' }), t.key(2, { lang: 'zh' })]);
    assert.equal(await t.keys.press(SERIAL, t.key(1, { kind: 'one' })), false);
    assert.equal(await t.keys.press(SERIAL, t.key(2, { lang: 'zh' })), false);
    await t.h.settle();
    const titles = t.views.map(v => v.title);
    assert.ok(titles.includes('Gemini CLI not found'), titles.join(' | '));
    assert.ok(titles.includes('未找到文件夹'), titles.join(' | '));
    // back to the normal face once the error has been shown
    await sleep(20);
    await t.h.settle();
    assert.deepEqual(t.views.slice(-2).map(v => v.title).sort(), ['New Session', '新建会话']);
  });

  test('a launcher that needs them gets the global settings with each press', async () => {
    const requests = [];
    const target = request => {
      requests.push(request);
      return { kind: 'url', url: 'kimi-work://open' };
    };
    const needs = { needsConfig: true };
    const t = newSessionKeys(
      target,
      undefined,
      { loadConfig: async () => ({ kimiDir: '~/kimi-home', geminiPath: '/opt/gemini' }) },
      needs
    );
    await t.keys.alive(SERIAL, [t.key(1)]);
    assert.equal(await t.keys.press(SERIAL, t.key(1)), true);
    assert.deepEqual(requests[0].config, {
      kimiDir: '~/kimi-home',
      geminiPath: '/opt/gemini',
    });
    // a config that cannot be loaded is an empty one, not a failed press
    const failing = newSessionKeys(
      target,
      undefined,
      { loadConfig: async () => { throw new Error('no config'); } },
      needs
    );
    await failing.keys.alive(SERIAL, [failing.key(1)]);
    assert.equal(await failing.keys.press(SERIAL, failing.key(1)), true);
    assert.deepEqual(requests[1].config, {});
    // nor does a config that never comes hold the press up for long
    const hanging = newSessionKeys(
      target,
      undefined,
      { loadConfig: () => new Promise(() => undefined), configWaitMs: 20 },
      needs
    );
    await hanging.keys.alive(SERIAL, [hanging.key(1)]);
    assert.equal(await hanging.keys.press(SERIAL, hanging.key(1)), true);
    assert.deepEqual(requests[2].config, {});
    assert.deepEqual(hanging.calls, [['url', 'kimi-work://open']]);
  });

  test('a launcher that needs no settings never waits for them (Claude)', async () => {
    let loads = 0;
    const t = newSessionKeys(
      () => ({ kind: 'url', url: 'claude://code/new?source=url_external' }),
      undefined,
      {
        loadConfig: () => {
          loads++;
          return new Promise(() => undefined);
        },
      }
    );
    await t.keys.alive(SERIAL, [t.key(1)]);
    assert.equal(await t.keys.press(SERIAL, t.key(1)), true);
    assert.equal(loads, 0);
    assert.deepEqual(t.calls, [['url', 'claude://code/new?source=url_external']]);
  });

  test('the launcher can name what a folderless target opens', async () => {
    const t = newSessionKeys(
      () => ({ kind: 'url', url: 'kimi-work://open' }),
      undefined,
      {},
      {
        subtitle: (data, folder, lang) =>
          data.target === 'desktop' ? (lang === 'zh' ? '应用' : 'App') : folder,
      }
    );
    await t.keys.alive(SERIAL, [
      t.key(1, { folder: '~/work/demo', target: 'desktop' }),
      t.key(2, { folder: '~/work/demo', target: 'desktop', lang: 'zh' }),
      t.key(3, { folder: '~/work/demo' }),
    ]);
    await t.h.settle();
    assert.deepEqual(
      t.views.map(v => v.subtitle),
      ['App', '应用', 'demo']
    );
  });

  test('without a home folder in the deps, launchers get the user\'s', async () => {
    const requests = [];
    const h = host();
    const keys = new NK.NewSessionKeys({
      ...h.deps,
      provider: {
        cid: Kit.keyCid('kimi', 'newsession'),
        brand: KIMI_BRAND,
        launcher: {
          appName: 'Kimi',
          target: request => {
            requests.push(request);
            return { kind: 'url', url: 'kimi-work://open' };
          },
        },
      },
      launch: async () => undefined,
      render: () => 'data:image/png;base64,0',
      timings: { openingMs: 5, errorMs: 5, debounceMs: 0 },
    });
    const key = { uid: 1, cid: Kit.keyCid('kimi', 'newsession'), width: 120, data: {} };
    await keys.alive(SERIAL, [key]);
    assert.equal(await keys.press(SERIAL, key), true);
    assert.equal(requests[0].home, os.homedir());
  });

  test('default texts name the provider', () => {
    const strings = NK.newSessionStrings({
      cid: 'x',
      brand: GEMINI_BRAND,
      launcher: { appName: 'Gemini CLI', target: () => null },
    });
    assert.deepEqual(strings.en, {
      ready: 'New Session',
      opening: 'Opening…',
      error: 'Gemini not available',
    });
    assert.equal(strings.zh.error, 'Gemini 不可用');
    assert.equal(NK.newSessionStrings(NK.CLAUDE_NEW_SESSION_KEYS).en.error, 'Claude app not found');
  });
});

// --- launchers -----------------------------------------------------------------

describe('command and terminal launchers', () => {
  test('shellQuote and the .command script quote every word', () => {
    assert.equal(L.shellQuote("it's"), `'it'\\''s'`);
    const script = L.commandScript(
      ['/opt/tools/kimi', '--plan'],
      "/Users/you/my app's $(dir)"
    );
    assert.equal(
      script,
      [
        '#!/bin/sh',
        'rm -f -- "$0"',
        `cd -- '/Users/you/my app'\\''s $(dir)' || { echo 'Folder not found'; exit 1; }`,
        `exec '/opt/tools/kimi' '--plan'`,
        '',
      ].join('\n')
    );
    assert.equal(
      L.commandScript(['gemini'], null),
      `#!/bin/sh\nrm -f -- "$0"\nexec 'gemini'\n`
    );
  });

  test('terminalCommand per platform', () => {
    assert.deepEqual(L.terminalCommand(['kimi'], '/w', 'darwin', '/t/x.command'), {
      file: '/usr/bin/open',
      args: ['-a', 'Terminal', '/t/x.command'],
    });
    assert.deepEqual(L.terminalCommand(['gemini', '-y'], 'C:\\w', 'win32'), {
      file: 'cmd.exe',
      args: ['/d', '/c', 'start', '', 'cmd.exe', '/k', 'gemini', '-y'],
      cwd: 'C:\\w',
    });
    assert.deepEqual(L.terminalCommand(['kimi'], null, 'linux'), {
      file: 'x-terminal-emulator',
      args: ['-e', 'kimi'],
    });
    assert.throws(() => L.terminalCommand([], null, 'linux'));
  });

  test('Windows: a word cmd.exe would act on is refused, its path never quoted', () => {
    for (const program of [
      'C:\\tools\\A&B\\npm\\gemini.cmd',
      'C:\\Users\\you\\%TEMP%\\kimi.exe',
      'C:\\Program Files (x86)\\Gemini\\gemini.cmd',
      'C:\\tools\\a|b\\kimi.exe',
      'C:\\tools\\a^b\\kimi.exe',
    ]) {
      assert.throws(
        () => L.terminalCommand([program, '-y'], 'C:\\w', 'win32'),
        error => {
          assert.match(error.message, /cmd\.exe/);
          assert.ok(!error.message.includes('C:\\'), error.message);
          return true;
        }
      );
    }
    // a space alone is fine: libuv quotes the word
    assert.equal(
      L.terminalCommand(['C:\\Program Files\\nodejs\\gemini.cmd'], null, 'win32').args.at(-1),
      'C:\\Program Files\\nodejs\\gemini.cmd'
    );
  });

  test('the macOS opener writes a private script and opens it in Terminal', async () => {
    const writes = [];
    const runs = [];
    const unlinks = [];
    let fail = false;
    const open = L.createTerminalOpener({
      platform: 'darwin',
      tmpDir: '/tmp/fake',
      writeFile: async (file, data, mode) => writes.push({ file, data, mode }),
      unlink: async file => unlinks.push(file),
      run: async command => {
        runs.push(command);
        if (fail) throw new Error('open failed');
      },
    });
    await open(['kimi'], '/Users/you/work');
    assert.equal(writes.length, 1);
    assert.match(writes[0].file, /^\/tmp\/fake\/flexbar-[0-9a-f]{16}\.command$/);
    assert.equal(writes[0].mode, 0o700);
    assert.equal(writes[0].data, L.commandScript(['kimi'], '/Users/you/work'));
    assert.deepEqual(runs, [
      { file: '/usr/bin/open', args: ['-a', 'Terminal', writes[0].file] },
    ]);
    fail = true;
    await assert.rejects(open(['kimi'], null), /open failed/);
    assert.deepEqual(unlinks, [writes[1].file]);
  });

  test('a script Terminal never ran is removed later', async () => {
    const unlinks = [];
    const open = L.createTerminalOpener({
      platform: 'darwin',
      tmpDir: '/tmp/fake',
      writeFile: async () => undefined,
      unlink: async file => {
        unlinks.push(file);
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
      run: async () => undefined,
      cleanupMs: 10,
    });
    await open(['kimi'], null);
    assert.deepEqual(unlinks, []);
    await sleep(40);
    assert.equal(unlinks.length, 1);
    assert.match(unlinks[0], /^\/tmp\/fake\/flexbar-[0-9a-f]{16}\.command$/);
  });

  test('leftover scripts are swept, nothing else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flexbar-sweep-test-'));
    try {
      const now = Date.now();
      const put = (name, ageMs) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, '#!/bin/sh\n');
        const t = (now - ageMs) / 1000;
        fs.utimesSync(file, t, t);
      };
      put('flexbar-0123456789abcdef.command', 5 * 60_000);
      put('flexbar-fedcba9876543210.command', 1_000);
      put('flexbar-notours.command', 5 * 60_000);
      put('other.command', 5 * 60_000);
      assert.equal(await L.sweepTerminalScripts(dir, 60_000, now), 1);
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        'flexbar-fedcba9876543210.command',
        'flexbar-notours.command',
        'other.command',
      ]);
      assert.equal(await L.sweepTerminalScripts(path.join(dir, 'missing')), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('other platforms run the terminal command directly', async () => {
    const runs = [];
    const open = L.createTerminalOpener({
      platform: 'linux',
      run: async command => runs.push(command),
      writeFile: async () => assert.fail('no script on Linux'),
    });
    await open(['gemini'], '/home/you/w');
    assert.deepEqual(runs, [
      { file: 'x-terminal-emulator', args: ['-e', 'gemini'], cwd: '/home/you/w' },
    ]);
  });

  test('the command runner uses execFile and keeps arguments out of errors', async () => {
    const calls = [];
    const run = L.createCommandRunner({
      settleMs: 1_000,
      execFile: (file, args, options, callback) => {
        calls.push({ file, args, options });
        const error = Object.assign(new Error('failed'), { code: 2 });
        callback(error, '', `cannot open /Users/you/secret-project here\n`);
      },
    });
    await assert.rejects(
      run({ file: '/usr/bin/open', args: ['/Users/you/secret-project'], cwd: '/Users/you' }),
      error => {
        assert.equal(error.message, 'open failed (2): cannot open … here');
        return true;
      }
    );
    assert.deepEqual(calls[0].options, { windowsHide: true, cwd: '/Users/you' });
    const ok = L.createCommandRunner({
      settleMs: 1_000,
      execFile: (file, args, options, callback) => callback(null, '', ''),
    });
    await ok({ file: 'x', args: [] });
  });
});
