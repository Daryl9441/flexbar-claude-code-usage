// Saving plugin settings must reach DeepSeek and the Moonshot balance without
// a process restart. Fetch is stubbed. Token-shaped strings are built at
// runtime and must never show up in a log line.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.PLUGIN_CONFIG_TEST_BUILD ??
  path.join(here, '..', '.test-build-plugin-config');
const req = file => require(path.join(build, file));
const Cache = req('pluginConfig.js');
const { UsageKeys } = req('usageKey.js');
const Deepseek = req('providers/deepseek/usage.js');
const { DEEPSEEK_BRAND } = req('providers/deepseek/brand.js');
const Kit = req('providers/kit.js');

const KEY = ['sk-', 'FAKE', 'deepseek', '0001'].join('');
const OTHER = ['sk-', 'FAKE', 'deepseek', '0002'].join('');
const MOON = ['sk-', 'FAKE', 'moonshot', '0001'].join('');
const SERIAL = 'FAKE-DEVICE-1';

globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};

function jsonResponse(body) {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
  };
}

const BALANCE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

function assertClean(lines) {
  const text = lines.join('\n');
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(OTHER), false);
  assert.equal(text.includes(MOON), false);
}

describe('plugin config cache', () => {
  test('a save is visible to the next read, including a key the event left out', async () => {
    let stored = { pollInterval: 180 };
    let reads = 0;
    const cache = Cache.createPluginConfigCache(async () => {
      reads += 1;
      return stored;
    });
    assert.deepEqual(await cache.load(), { pollInterval: 180 });
    assert.equal(reads, 1);

    stored = {
      pollInterval: 180,
      deepseekApiKey: KEY,
      moonshotApiKey: MOON,
      moonshotSite: 'global',
    };
    // The settings event names the new interval and blanks the password
    // fields. config.json already has both keys.
    const saved = await cache.updated({
      config: { pollInterval: 60, deepseekApiKey: '', moonshotApiKey: '   ' },
    });
    assert.equal(saved.pollInterval, 60);
    assert.equal(saved.deepseekApiKey, KEY);
    assert.equal(saved.moonshotApiKey, MOON);
    assert.equal(saved.moonshotSite, 'global');
    assert.equal(await cache.load(), saved);
    assert.equal(reads, 2, 'the save reads the store again, then the copy is kept');
  });

  test('the event supplies a key the stored file does not have yet', async () => {
    let stored = { pollInterval: 180 };
    const cache = Cache.createPluginConfigCache(async () => stored);
    await cache.load();
    const saved = await cache.updated({
      deepseekApiKey: KEY,
      moonshotApiKey: MOON,
      moonshotSite: 'cn',
    });
    assert.equal(saved.deepseekApiKey, KEY);
    assert.equal(saved.moonshotApiKey, MOON);
    assert.equal(saved.pollInterval, 180);
    assert.equal(saved.moonshotSite, 'cn');
  });

  test('replacing a key still wins over the previous stored value', async () => {
    const stored = { deepseekApiKey: KEY };
    const cache = Cache.createPluginConfigCache(async () => stored);
    await cache.load();
    const saved = await cache.updated({ config: { deepseekApiKey: OTHER } });
    assert.equal(saved.deepseekApiKey, OTHER);
  });

  test('a status payload is not stored as the settings', async () => {
    const stored = { deepseekApiKey: KEY, pollInterval: 180 };
    const cache = Cache.createPluginConfigCache(async () => stored);
    const saved = await cache.updated({ status: 'success' });
    assert.equal(saved.deepseekApiKey, KEY);
    assert.equal(Object.hasOwn(saved, 'status'), false);
  });

  test('a getConfig that started before the save cannot restore the old settings', async () => {
    let calls = 0;
    let releaseStale;
    let releaseFresh;
    const cache = Cache.createPluginConfigCache(
      () =>
        new Promise(resolve => {
          calls += 1;
          if (calls === 1) {
            releaseStale = () => resolve({ pollInterval: 180 });
          } else {
            releaseFresh = () =>
              resolve({ pollInterval: 180, deepseekApiKey: KEY, moonshotApiKey: MOON });
          }
        })
    );
    const first = cache.load();
    const saved = cache.updated({ config: { pollInterval: 90 } });
    releaseFresh();
    const next = await saved;
    assert.equal(next.deepseekApiKey, KEY);
    assert.equal(next.moonshotApiKey, MOON);
    assert.equal(next.pollInterval, 90);
    releaseStale();
    await first;
    assert.equal((await cache.load()).deepseekApiKey, KEY);
    assert.equal(calls, 2);
  });

  test('a failed re-read is warned without the settings, and the event key is kept', async () => {
    const warnings = [];
    const cache = Cache.createPluginConfigCache(
      async () => {
        throw new Error('unreadable');
      },
      error => warnings.push(error)
    );
    const saved = await cache.updated({ config: { moonshotApiKey: MOON } });
    assert.equal(saved.moonshotApiKey, MOON);
    assert.deepEqual(
      warnings.map(error => error.message),
      ['unreadable']
    );
    assertClean(warnings.map(error => `${error}`));
  });
});

function keyGroup(source, loadConfig) {
  const cid = Kit.keyCid('deepseek', 'usage');
  const lines = [];
  let chain = Promise.resolve();
  const keys = new UsageKeys({
    enqueue: task => (chain = chain.then(task).catch(() => undefined)),
    send: async () => undefined,
    isOffline: () => false,
    keyWidth: key => key.width || 240,
    bgColor: () => undefined,
    loadConfig,
    pollIntervalMs: () => 3_600_000,
    logger: {
      info: () => undefined,
      warn: (...parts) => lines.push(parts.join(' ')),
      error: (...parts) => lines.push(parts.join(' ')),
    },
    provider: { cid, brand: DEEPSEEK_BRAND, source },
  });
  const settle = async () => {
    let last;
    do {
      last = chain;
      await last;
      await new Promise(resolve => setTimeout(resolve, 2));
    } while (last !== chain);
  };
  return { cid, keys, lines, settle };
}

describe('usage keys after a settings save', () => {
  test('DeepSeek fetches the saved key inside the gap, and test-connection does too', async () => {
    const headers = [];
    const lines = [];
    let stored = { pollInterval: 180 };
    const cache = Cache.createPluginConfigCache(
      async () => stored,
      error => lines.push(`${error}`)
    );
    const source = Deepseek.createDeepseekUsageSource({
      fetch: async (_url, init) => {
        headers.push(init.headers.Authorization);
        return jsonResponse(BALANCE);
      },
    });
    const group = keyGroup(source, () => cache.load());
    try {
      await group.keys.alive(SERIAL, [
        { uid: 1, cid: group.cid, width: 240, data: {} },
      ]);
      await group.settle();
      assert.equal(headers.length, 0);
      assert.ok(
        group.lines.some(line =>
          line.includes('Failed to fetch DeepSeek usage: No DeepSeek API key is set')
        )
      );

      stored = { pollInterval: 60, deepseekApiKey: KEY, moonshotApiKey: MOON };
      const saved = await cache.updated({
        config: { pollInterval: 60, deepseekApiKey: '' },
      });
      await group.keys.configure(saved);
      await group.settle();
      assert.deepEqual(headers, [`Bearer ${KEY}`]);

      const tested = await group.keys.message({ data: 'test-connection' });
      assert.equal(tested.success, true);
      assert.deepEqual(headers, [`Bearer ${KEY}`, `Bearer ${KEY}`]);

      const typed = await group.keys.message({
        data: 'test-connection',
        config: { deepseekApiKey: OTHER },
      });
      assert.equal(typed.success, true);
      assert.equal(headers[2], `Bearer ${OTHER}`);
      assertClean([...group.lines, ...lines]);
    } finally {
      group.keys.stop();
    }
  });

  test('the Moonshot balance key reaches fetch and test-connection without a restart', async () => {
    const seen = [];
    let stored = {};
    const cache = Cache.createPluginConfigCache(async () => stored);
    const source = {
      defaultMetric: 'api',
      minFetchGapMs: 30_000,
      fetch: async config => {
        seen.push(['fetch', config.moonshotApiKey ?? '']);
        return [{ id: 'api', label: 'API', percent: 0, resetsAt: null }];
      },
      describe: async config => {
        seen.push(['describe', config.moonshotApiKey ?? '']);
        return { success: Boolean(config.moonshotApiKey), metrics: [] };
      },
    };
    const group = keyGroup(source, () => cache.load());
    try {
      await group.keys.alive(SERIAL, [
        { uid: 1, cid: group.cid, width: 240, data: { metric: 'api' } },
      ]);
      await group.settle();
      assert.deepEqual(seen, [['fetch', '']]);

      stored = { moonshotApiKey: MOON, moonshotSite: 'global' };
      const saved = await cache.updated({ config: { moonshotSite: 'global' } });
      await group.keys.configure(saved);
      await group.settle();
      assert.deepEqual(seen[1], ['fetch', MOON]);

      const tested = await group.keys.message({ data: 'test-connection' });
      assert.equal(tested.success, true);
      assert.deepEqual(seen[2], ['describe', MOON]);
      assertClean(group.lines);
    } finally {
      group.keys.stop();
    }
  });

  test('an unchanged save stays inside the fetch gap', async () => {
    const seen = [];
    const config = { pollInterval: 180 };
    const source = {
      defaultMetric: '',
      minFetchGapMs: 30_000,
      fetch: async configSeen => {
        seen.push(configSeen);
        return [{ id: 'api', label: 'API', percent: 0, resetsAt: null }];
      },
    };
    const group = keyGroup(source, async () => config);
    try {
      await group.keys.alive(SERIAL, [
        { uid: 1, cid: group.cid, width: 240, data: {} },
      ]);
      await group.settle();
      await group.keys.configure(config);
      await group.settle();
      assert.equal(seen.length, 1);
    } finally {
      group.keys.stop();
    }
  });

  test('a save during an in-flight fetch is used by the next request', async () => {
    const seen = [];
    let release;
    let hang = false;
    const source = {
      defaultMetric: '',
      minFetchGapMs: 30_000,
      fetch: config => {
        seen.push(config.moonshotApiKey ?? '');
        if (hang) {
          hang = false;
          return new Promise(resolve => {
            release = () =>
              resolve([{ id: 'api', label: 'API', percent: 0, resetsAt: null }]);
          });
        }
        return Promise.resolve([
          { id: 'api', label: 'API', percent: 0, resetsAt: null },
        ]);
      },
    };
    const group = keyGroup(source, async () => ({}));
    try {
      await group.keys.alive(SERIAL, [
        { uid: 1, cid: group.cid, width: 240, data: {} },
      ]);
      await group.settle();
      hang = true;
      group.keys.lastFetchAt = 0;
      const first = group.keys.refresh();
      const saved = group.keys.configure({ moonshotApiKey: MOON });
      for (let i = 0; i < 20 && seen.length < 2; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(seen.length, 2);
      release();
      await first;
      await saved;
      await group.settle();
      assert.deepEqual(seen, ['', '', MOON]);
      assertClean(group.lines);
    } finally {
      group.keys.stop();
    }
  });
});
