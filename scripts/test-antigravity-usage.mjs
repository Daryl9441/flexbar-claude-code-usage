// Tests for the Antigravity usage source (src/providers/antigravity/usage.ts),
// run against the tsc output of `npm run test:antigravity-usage`
// (.test-build-antigravity-usage/).
// OWNER: the antigravity-usage implementer; replace the stub checks with
// fixture-driven tests. Rules: synthetic fixtures only (see CLAUDE.md), no
// network, no local RPC and no real process lookups (fetch, http/https,
// net and child_process are stubbed below; inject fakes instead), never read
// the real home folder (HOME points at an empty temp folder), build
// token-shaped strings (CSRF tokens, OAuth tokens) at runtime.
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

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-usage-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};
// nothing in these tests may reach a real Antigravity language server or
// start a program: every such call fails loudly
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
  process.env.ANTIGRAVITY_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-antigravity-usage');
const req = p => require(path.join(build, p));
const U = req('providers/antigravity/usage.js');
const Kit = req('providers/kit.js');
const { UsageKeys } = req('usageKey.js');
const { ANTIGRAVITY_BRAND } = req('providers/antigravity/brand.js');

const CONFIG = {
  antigravityDir: path.join(empty, 'gemini'),
  antigravityPath: path.join(empty, 'no-agy'),
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** [width, height] of a PNG data URL. */
function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe('Antigravity usage source contract', () => {
  test('exports usageSource', () => {
    assert.equal(typeof U.usageSource.fetch, 'function');
    assert.equal(typeof U.usageSource.defaultMetric, 'string');
  });

  test('without Antigravity data, fetch rejects with a ProviderError', async () => {
    await assert.rejects(U.usageSource.fetch(CONFIG), error => {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      return true;
    });
  });

  // stub behaviour: replace with the real source's checks
  test('stub: not installed without data folders, else not set up', async () => {
    await assert.rejects(U.usageSource.fetch(CONFIG), { code: 'not-installed' });
    const root = path.join(empty, 'installed');
    fs.mkdirSync(path.join(root, 'antigravity-cli'), { recursive: true });
    try {
      await assert.rejects(
        U.usageSource.fetch({ ...CONFIG, antigravityDir: root }),
        { code: 'not-configured' }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the key draws a 60px face from that, without network', async () => {
    const cid = Kit.keyCid('antigravity', 'usage');
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
      provider: { cid, brand: ANTIGRAVITY_BRAND, source: U.usageSource },
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
