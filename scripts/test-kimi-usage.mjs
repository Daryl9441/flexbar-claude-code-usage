// Tests for the Kimi usage source (src/providers/kimi/usage.ts), run against
// the tsc output of `npm run test:kimi-usage` (.test-build-kimi-usage/).
// OWNER: the kimi-usage implementer; replace the stub checks with fixture-
// driven tests. Rules: synthetic fixtures only (see CLAUDE.md), no network
// (fetch is stubbed below), never read the real home folder (HOME points at
// an empty temp folder), build token-shaped strings at runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-test-'));
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
  process.env.KIMI_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-kimi-usage');
const req = p => require(path.join(build, p));
const U = req('providers/kimi/usage.js');
const Kit = req('providers/kit.js');
const { UsageKeys } = req('usageKey.js');
const { KIMI_BRAND } = req('providers/kimi/brand.js');

const CONFIG = { kimiDir: path.join(empty, 'kimi-code'), kimiDesktopDir: path.join(empty, 'kimi-desktop') };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** [width, height] of a PNG data URL. */
function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('Kimi usage source contract', () => {
  test('exports usageSource', () => {
    assert.equal(typeof U.usageSource.fetch, 'function');
    assert.equal(typeof U.usageSource.defaultMetric, 'string');
  });

  test('without Kimi data, fetch rejects with a ProviderError', async () => {
    await assert.rejects(U.usageSource.fetch(CONFIG), error => {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      return true;
    });
  });

  test('the key draws a 60px face from that, without network', async () => {
    const cid = Kit.keyCid('kimi', 'usage');
    const sent = [];
    let chain = Promise.resolve();
    const keys = new UsageKeys({
      enqueue: task => (chain = chain.then(task).catch(() => undefined)),
      send: async (_serial, key, image) => sent.push([key.uid, image]),
      isOffline: () => false,
      keyWidth: key => key.width,
      bgColor: () => undefined,
      loadConfig: async () => CONFIG,
      pollIntervalMs: () => 3_600_000,
      provider: { cid, brand: KIMI_BRAND, source: U.usageSource },
    });
    try {
      await keys.alive('FAKE-DEVICE-1', [
        { uid: 1, cid, width: 120, data: { metric: '' } },
        { uid: 2, cid, width: 60, data: { metric: '', lang: 'zh' } },
      ]);
      await chain;
      await sleep(5);
      await chain;
      assert.ok(sent.length >= 2);
      for (const [uid, image] of sent) {
        assert.deepEqual(pngSize(image), [uid === 1 ? 120 : 60, 60]);
      }
    } finally {
      keys.stop();
    }
  });
});
