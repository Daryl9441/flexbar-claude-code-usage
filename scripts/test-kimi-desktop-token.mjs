// Synthetic LevelDB fixtures only. No app, home profile or network is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-token-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { readDesktopAccessToken, decodeDesktopSnappy } = require(
  path.join(here, '..', '.test-build-kimi-desktop-token/providers/kimi/usageDesktopToken.js')
);
const NOW = Date.parse('2026-10-12T00:00:00.000Z');
const KEY = Buffer.from('_https://www.kimi.com\0\x01access_token');
let serial = 0;
const token = (exp = NOW / 1000 + 3600, label = 'synthetic') => [
  Buffer.from(JSON.stringify({ alg: 'TEST', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ exp, sub: ['TEST', label].join('-') })).toString('base64url'),
  Buffer.from('TEST-SIGNATURE').toString('base64url'),
].join('.');
const value = (text, utf16 = false) => Buffer.concat([
  Buffer.from([utf16 ? 0 : 1]),
  Buffer.from(text, utf16 ? 'utf16le' : 'utf8'),
]);
const put = (text, key = KEY) => ({ type: 1, key, value: value(text) });
const del = (key = KEY) => ({ type: 0, key });

function varint(n) {
  n = BigInt(n);
  const out = [];
  do {
    out.push(Number(n & 127n) | (n >= 128n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(out);
}
const slice = bytes => Buffer.concat([varint(bytes.length), bytes]);
const u32 = n => {
  const b = Buffer.alloc(4); b.writeUInt32LE(n); return b;
};
function internal(key, sequence, type = 1) {
  const tail = Buffer.alloc(8);
  tail.writeBigUInt64LE((BigInt(sequence) << 8n) | BigInt(type));
  return Buffer.concat([key, tail]);
}
function crc(bytes, type, first) {
  let c = 0xffffffff;
  for (const byte of first ? Buffer.concat([Buffer.from([type]), bytes]) : Buffer.concat([bytes, Buffer.from([type])])) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0x82f63b78 : 0);
  }
  c = (~c) >>> 0;
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
}
function log(records) {
  const fragments = [];
  let pos = 0;
  for (const record of records) {
    let consumed = 0;
    let first = true;
    do {
      const available = 32768 - pos % 32768;
      if (available < 7) {
        fragments.push(Buffer.alloc(available));
        pos += available;
        continue;
      }
      const size = Math.min(record.length - consumed, available - 7);
      const last = consumed + size === record.length;
      const type = first ? (last ? 1 : 2) : (last ? 4 : 3);
      const data = record.subarray(consumed, consumed + size);
      const header = Buffer.alloc(7);
      header.writeUInt32LE(crc(data, type, true));
      header.writeUInt16LE(size, 4);
      header[6] = type;
      fragments.push(header, data);
      pos += 7 + size;
      consumed += size;
      first = false;
    } while (consumed < record.length);
  }
  return Buffer.concat(fragments);
}
function batch(sequence, entries) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(BigInt(sequence));
  header.writeUInt32LE(entries.length, 8);
  return Buffer.concat([header, ...entries.flatMap(entry => [
    Buffer.from([entry.type]), slice(entry.key),
    ...(entry.type === 1 ? [slice(entry.value)] : []),
  ])]);
}
function block(entries, prefix = true) {
  const chunks = [];
  let previous = Buffer.alloc(0);
  for (const [key, val] of entries) {
    let shared = 0;
    if (prefix) while (shared < Math.min(previous.length, key.length) && previous[shared] === key[shared]) shared++;
    const delta = key.subarray(shared);
    chunks.push(varint(shared), varint(delta.length), varint(val.length), delta, val);
    previous = key;
  }
  return Buffer.concat([...chunks, u32(0), u32(1)]);
}
function snappyLiteral(bytes) {
  const n = bytes.length;
  if (n <= 60) return Buffer.concat([varint(n), Buffer.from([(n - 1) << 2]), bytes]);
  const count = n < 257 ? 1 : n < 65537 ? 2 : 3;
  const length = Buffer.alloc(count); length.writeUIntLE(n - 1, 0, count);
  return Buffer.concat([varint(n), Buffer.from([(59 + count) << 2]), length, bytes]);
}
function sst(dataEntries, { compressed = false, additionalBlocks = [] } = {}) {
  const pieces = [];
  const index = [];
  let offset = 0;
  const append = bytes => {
    const type = compressed ? 1 : 0;
    const data = compressed ? snappyLiteral(bytes) : bytes;
    const trailer = Buffer.concat([Buffer.from([type]), u32(crc(data, type, false))]);
    const handle = Buffer.concat([varint(offset), varint(data.length)]);
    pieces.push(data, trailer);
    offset += data.length + 5;
    return handle;
  };
  for (const entries of [dataEntries, ...additionalBlocks]) {
    const handle = append(block(entries));
    index.push([entries.at(-1)[0], handle]);
  }
  const meta = append(block([]));
  const indexHandle = append(block(index));
  const footer = Buffer.alloc(48);
  Buffer.concat([meta, indexHandle]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  pieces.push(footer);
  return Buffer.concat(pieces);
}
function version({ logNumber = 100, tables = [], deleted = [] } = {}) {
  return Buffer.concat([
    varint(1), slice(Buffer.from('leveldb.BytewiseComparator')),
    varint(2), varint(logNumber),
    ...deleted.flatMap(n => [varint(6), varint(0), varint(n)]),
    ...tables.flatMap(n => [varint(7), varint(0), varint(n), varint(123), slice(internal(KEY, 1)), slice(internal(KEY, 1))]),
  ]);
}
function store({ batches = [], tables = [], versions, extraFiles = {} } = {}) {
  const desktop = path.join(root, `case-${++serial}`, 'kimi-desktop');
  const dir = path.join(desktop, 'Local Storage', 'leveldb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(dir, 'MANIFEST-000001'), log(versions ?? [version({ tables: tables.map(([n]) => n) })]));
  fs.writeFileSync(path.join(dir, '000100.log'), log(batches));
  for (const [n, bytes] of tables) fs.writeFileSync(path.join(dir, `${String(n).padStart(6, '0')}.ldb`), bytes);
  for (const [name, bytes] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, name), bytes);
  return { desktop, dir, read: options => readDesktopAccessToken(desktop, { now: NOW, ...options }) };
}

test('current exact-origin log put returns only access_token', async () => {
  const expected = token();
  const fixture = store({ batches: [batch(10, [
    put(token(undefined, 'other'), Buffer.from('_https://other.example.com\0\x01access_token')),
    put('TEST-NOT-A-JWT', Buffer.from('_https://www.kimi.com\0\x01refresh_token')),
    put(expected),
  ])] });
  assert.deepEqual(await fixture.read(), { kind: 'valid', accessToken: expected, expiresAt: NOW / 1000 + 3600 });
});
test('newest sequence wins regardless of log file name or timestamp', async () => {
  const expected = token(undefined, 'new');
  const fixture = store({ batches: [batch(20, [put(expected)])], extraFiles: {
    '000101.log': log([batch(10, [put(token(undefined, 'old'))])]),
  } });
  assert.equal((await fixture.read()).accessToken, expected);
});
test('delete and empty latest put prevent older token revival', async () => {
  for (const change of [del(), put(''), put('null'), put('undefined')]) {
    const fixture = store({ batches: [batch(10, [put(token())]), batch(20, [change])] });
    assert.deepEqual(await fixture.read(), { kind: 'signed-out' });
  }
});
test('newest expired token never falls back to valid older token', async () => {
  const fixture = store({ batches: [batch(10, [put(token())]), batch(20, [put(token(NOW / 1000))])] });
  assert.deepEqual(await fixture.read(), { kind: 'expired' });
});
test('malformed current token fails closed instead of falling back', async () => {
  const fixture = store({ batches: [batch(10, [put(token())]), batch(20, [put('TEST-broken')])] });
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('other origin, subdomain and similarly named keys are ignored', async () => {
  const fixture = store({ batches: [batch(10, [
    put(token(), Buffer.from('_https://kimi.com\0\x01access_token')),
    put(token(), Buffer.from('_https://www.kimi.com.example.com\0\x01access_token')),
    put(token(), Buffer.from('_https://www.kimi.com\0\x01access_token_backup')),
  ])] });
  assert.deepEqual(await fixture.read(), { kind: 'missing' });
});
test('fragmented journal WriteBatch validates FULL/FIRST/MIDDLE/LAST', async () => {
  const expected = token();
  const fixture = store({ batches: [batch(10, [
    { type: 1, key: Buffer.from('TEST-padding'), value: Buffer.alloc(70_000, 88) }, put(expected),
  ])] });
  assert.equal((await fixture.read()).accessToken, expected);
});
test('unfinished trailing atomic append is ignored', async () => {
  const fixture = store({ batches: [batch(10, [put(token())])] });
  const partial = log([batch(20, [del()])]).subarray(0, 9);
  fs.appendFileSync(path.join(fixture.dir, '000100.log'), partial);
  assert.equal((await fixture.read()).kind, 'valid');
});
test('corrupt journal checksum rejects older readable token', async () => {
  const fixture = store({ batches: [batch(10, [put(token())]), batch(20, [del()])] });
  const file = path.join(fixture.dir, '000100.log');
  const data = fs.readFileSync(file); data[data.length - 1] ^= 1; fs.writeFileSync(file, data);
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('uncompressed and Snappy-compressed active SST values are read', async () => {
  for (const compressed of [false, true]) {
    const expected = token();
    const fixture = store({ tables: [[50, sst([[internal(KEY, 10), value(expected)]], { compressed })]] });
    assert.equal((await fixture.read()).accessToken, expected);
  }
});
test('prefix-compressed SST entries and newer journal tombstone compose', async () => {
  const data = sst([
    [internal(KEY, 20, 0), Buffer.alloc(0)],
    [internal(KEY, 10), value(token())],
  ]);
  const fixture = store({ tables: [[50, data]] });
  assert.deepEqual(await fixture.read(), { kind: 'signed-out' });
  fs.writeFileSync(path.join(fixture.dir, '000100.log'), log([batch(30, [put(token())])])) ;
  assert.equal((await fixture.read()).kind, 'valid');
});
test('all same-key versions across SST data-block boundary are considered', async () => {
  const fixture = store({ tables: [[50, sst(
    [[internal(KEY, 20, 0), Buffer.alloc(0)]],
    { additionalBlocks: [[[internal(KEY, 10), value(token())]]] }
  )]] });
  assert.deepEqual(await fixture.read(), { kind: 'signed-out' });
});
test('compacted/deleted table and obsolete journals never revive token', async () => {
  const fixture = store({ tables: [[50, sst([[internal(KEY, 10), value(token())]])]],
    versions: [version({ tables: [50] }), version({ deleted: [50] })],
    extraFiles: { '000050.log': log([batch(1000, [put(token())])]) },
  });
  assert.deepEqual(await fixture.read(), { kind: 'missing' });
});
test('UTF16 Chromium string encoding is supported', async () => {
  const expected = token();
  const fixture = store({ batches: [batch(10, [{ type: 1, key: KEY, value: value(expected, true) }])] });
  assert.equal((await fixture.read()).accessToken, expected);
});
test('missing store returns missing; malformed CURRENT cannot escape directory', async () => {
  assert.deepEqual(await readDesktopAccessToken(path.join(root, 'missing')), { kind: 'missing' });
  const fixture = store();
  fs.writeFileSync(path.join(fixture.dir, 'CURRENT'), '../TEST-outside\n');
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('symlink journal is rejected without reading its target', async () => {
  const fixture = store();
  const file = path.join(fixture.dir, '000100.log'); fs.unlinkSync(file);
  const outside = path.join(root, 'TEST-outside.log'); fs.writeFileSync(outside, log([batch(1, [put(token())])]));
  fs.symlinkSync(outside, file);
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('checksum failure, invalid footer and broken entry reject SST', async () => {
  for (const corrupt of [
    data => { data[1] ^= 1; },
    data => { data[data.length - 1] ^= 1; },
  ]) {
    const bytes = sst([[internal(KEY, 10), value(token())]]); corrupt(bytes);
    const fixture = store({ tables: [[50, bytes]], batches: [batch(1, [put(token())])] });
    assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
  }
});
test('file, read, record, block, entry and token budgets fail closed', async () => {
  const fixture = store({ batches: [batch(10, [put(token())])], tables: [[50, sst([[internal(KEY, 1), value(token())]])]] });
  for (const limits of [
    { maxFiles: 1 }, { maxReadBytes: 32 }, { maxFileBytes: 32 },
    { maxRecordBytes: 12 }, { maxBlockBytes: 16 }, { maxEntries: 1 }, { maxTokenBytes: 8 },
  ]) assert.deepEqual(await fixture.read({ limits }), { kind: 'unavailable' });
});
test('invalid batch count and unknown operation do not partially accept puts', async () => {
  for (const mutate of [
    data => data.writeUInt32LE(2, 8),
    data => { data[12] = 8; },
  ]) {
    const bytes = batch(10, [put(token())]); mutate(bytes);
    const fixture = store({ batches: [bytes] });
    assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
  }
});
test('conflicting versions with same sequence fail closed', async () => {
  const fixture = store({ batches: [batch(10, [put(token())]), batch(10, [del()])] });
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('sign-out appended after an earlier journal read fails closed', async () => {
  const fixture = store({ batches: [batch(10, [put(token())])], extraFiles: { '000101.log': Buffer.alloc(0) } });
  const promises = require('node:fs/promises');
  const original = promises.open;
  let injected = false;
  promises.open = async (...args) => {
    if (args[0] === path.join(fixture.dir, '000101.log') && !injected) {
      injected = true;
      fs.appendFileSync(path.join(fixture.dir, '000100.log'), log([batch(20, [del()])]));
    }
    return original(...args);
  };
  try {
    assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
    assert.equal(injected, true);
  } finally { promises.open = original; }
});
test('JWT missing/invalid expiry and invalid Chromium encoding fail closed', async () => {
  for (const bad of [
    value([Buffer.from('TEST').toString('base64url'), Buffer.from('{}').toString('base64url'), Buffer.from('TEST').toString('base64url')].join('.')),
    value([Buffer.from('TEST').toString('base64url'), Buffer.from('{"exp":"TEST"}').toString('base64url'), Buffer.from('TEST').toString('base64url')].join('.')),
    Buffer.from([2, 65]), Buffer.from([0, 65]),
  ]) {
    const fixture = store({ batches: [batch(10, [{ type: 1, key: KEY, value: bad }])] });
    assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
  }
});
test('malformed prefix entry with valid checksum fails closed', async () => {
  const entries = [[internal(KEY, 10), value(token())]];
  const data = sst(entries);
  const size = block(entries).length;
  data[0] = 1; // First restart entry cannot share a previous key.
  data.writeUInt32LE(crc(data.subarray(0, size), 0, false), size + 1);
  const fixture = store({ tables: [[50, data]] });
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('unsupported manifest edit fails closed instead of scanning obsolete files', async () => {
  const fixture = store({ versions: [version(), Buffer.from([99])], extraFiles: {
    '000050.ldb': sst([[internal(KEY, 10), value(token())]]),
  } });
  assert.deepEqual(await fixture.read(), { kind: 'unavailable' });
});
test('Snappy supports overlapping copy tags and checks length/offset limits', () => {
  assert.equal(decodeDesktopSnappy(Buffer.from([9, 0, 65, 30, 1, 0])).toString(), 'A'.repeat(9));
  assert.equal(decodeDesktopSnappy(Buffer.from([5, 0, 65, 1, 1])).toString(), 'AAAAA');
  assert.equal(decodeDesktopSnappy(Buffer.from([5, 0, 65, 15, 1, 0, 0, 0])).toString(), 'AAAAA');
  for (const bytes of [Buffer.from([2, 2, 0, 0]), Buffer.from([9, 0, 65]), Buffer.from([1, 240])])
    assert.throws(() => decodeDesktopSnappy(bytes), /storage is unavailable/);
  assert.throws(() => decodeDesktopSnappy(snappyLiteral(Buffer.alloc(20)), 10));
});
