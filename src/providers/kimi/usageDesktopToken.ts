/**
 * Read only Kimi desktop's current www.kimi.com access_token. This is a
 * bounded LevelDB reader, not a database opener: it creates no lock, performs
 * no recovery, and never touches cookies, refresh tokens or the Keychain.
 *
 * CURRENT/MANIFEST select live tables. Scanning every leftover .ldb file
 * would resurrect a signed-out token after compaction removed its tombstone.
 * Formats: google/leveldb doc/{log_format,table_format}.md and
 * db/{version_edit,write_batch}.cc; google/snappy format_description.txt.
 */
import { constants } from 'node:fs';
import { lstat, open, opendir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type DesktopTokenState =
  | { kind: 'valid'; accessToken: string; expiresAt: number }
  | { kind: 'missing' | 'signed-out' | 'expired' | 'unavailable' };

export type DesktopTokenLimits = {
  maxFiles: number;
  maxReadBytes: number;
  maxFileBytes: number;
  maxBlockBytes: number;
  maxRecordBytes: number;
  maxEntries: number;
  maxTokenBytes: number;
};

const DEFAULT_LIMITS: DesktopTokenLimits = {
  maxFiles: 64,
  maxReadBytes: 8 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxBlockBytes: 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxEntries: 100_000,
  maxTokenBytes: 16 * 1024,
};

const ACCESS_KEY = Buffer.from('_https://www.kimi.com\0\x01access_token');
const MAX_SEQUENCE = (1n << 56n) - 1n;
const LOG_BLOCK = 32_768;
const TABLE_MAGIC = 0xdb4775248b80fb57n;

/** All failures have fixed text, so parsing errors cannot expose input. */
function invalid(): never {
  throw new Error('Kimi desktop storage is unavailable');
}

class Cursor {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      if (this.offset >= this.bytes.length) invalid();
      const byte = this.bytes[this.offset++];
      if (shift === 63n && byte > 1) invalid();
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    return invalid();
  }
  number(): number {
    const n = this.varint();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(n);
  }
  slice(): Buffer {
    const size = this.number();
    if (size > this.bytes.length - this.offset) invalid();
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
}

class Budget {
  bytes = 0;
  files = 0;
  entries = 0;
  readonly snapshots = new Map<string, FileStamp>();
  readonly limits: DesktopTokenLimits;
  constructor(limits: Partial<DesktopTokenLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(limits) as (keyof DesktopTokenLimits)[]) {
      const value = limits[key];
      if (!Number.isSafeInteger(value) || !value || value < 0) invalid();
      // Callers can tighten limits, but never remove the production bounds.
      this.limits[key] = Math.min(value, DEFAULT_LIMITS[key]);
    }
  }
  spend(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) invalid();
    this.bytes += bytes;
    if (this.bytes > this.limits.maxReadBytes) invalid();
  }
  entry(): void {
    if (++this.entries > this.limits.maxEntries) invalid();
  }
}

type FileStamp = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function sameFile(a: FileStamp, b: FileStamp): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  return crc >>> 0;
});

function maskedCrc(bytes: Buffer, type: number, typeFirst: boolean): number {
  let crc = 0xffffffff;
  const add = (byte: number) => {
    crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  };
  if (typeFirst) add(type);
  for (const byte of bytes) add(byte);
  if (!typeFirst) add(type);
  crc = ~crc >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

/** Decode a raw Snappy block; the output size is checked before allocation. */
export function decodeDesktopSnappy(
  bytes: Buffer,
  maxBytes = DEFAULT_LIMITS.maxBlockBytes
): Buffer {
  const c = new Cursor(bytes);
  const size = c.number();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || size > maxBytes)
    invalid();
  const out = Buffer.alloc(size);
  let pos = 0;
  while (c.offset < bytes.length) {
    const tag = bytes[c.offset++];
    const type = tag & 3;
    let length = tag >>> 2;
    if (type === 0) {
      if (length < 60) length++;
      else {
        const count = length - 59;
        if (count > bytes.length - c.offset) invalid();
        length = bytes.readUIntLE(c.offset, count) + 1;
        c.offset += count;
      }
      if (length > size - pos || length > bytes.length - c.offset) invalid();
      bytes.copy(out, pos, c.offset, c.offset + length);
      c.offset += length;
    } else {
      let offset: number;
      if (type === 1) {
        if (c.offset >= bytes.length) invalid();
        length = 4 + ((tag >>> 2) & 7);
        offset = ((tag & 224) << 3) | bytes[c.offset++];
      } else {
        const count = type === 2 ? 2 : 4;
        if (count > bytes.length - c.offset) invalid();
        offset = bytes.readUIntLE(c.offset, count);
        c.offset += count;
        length++;
      }
      if (!offset || offset > pos || length > size - pos) invalid();
      // Copies may overlap: Buffer.copy would not implement Snappy's RLE.
      for (let i = 0; i < length; i++) out[pos + i] = out[pos + i - offset];
    }
    pos += length;
  }
  if (pos !== size) invalid();
  return out;
}

function logRecords(
  bytes: Buffer,
  budget: Budget,
  consume: (b: Buffer) => void
) {
  let pos = 0;
  let fragments: Buffer[] | undefined;
  let fragmentSize = 0;
  while (pos < bytes.length) {
    const blockEnd = Math.min(
      bytes.length,
      (Math.floor(pos / LOG_BLOCK) + 1) * LOG_BLOCK
    );
    if (blockEnd - pos < 7) {
      // An incomplete final append has not committed a logical record yet.
      if (blockEnd === bytes.length && bytes.length % LOG_BLOCK) break;
      if (bytes.subarray(pos, blockEnd).some(byte => byte !== 0)) invalid();
      pos = blockEnd;
      continue;
    }
    const crc = bytes.readUInt32LE(pos);
    const length = bytes.readUInt16LE(pos + 4);
    const type = bytes[pos + 6];
    if (crc === 0 && length === 0 && type === 0) {
      if (bytes.subarray(pos, blockEnd).some(byte => byte !== 0)) invalid();
      pos = blockEnd;
      continue;
    }
    if (pos + 7 + length > blockEnd) {
      if (blockEnd === bytes.length && bytes.length % LOG_BLOCK) break;
      invalid();
    }
    const data = bytes.subarray(pos + 7, pos + 7 + length);
    pos += 7 + length;
    if (crc !== maskedCrc(data, type, true)) invalid();
    if (type === 1) {
      if (fragments || length > budget.limits.maxRecordBytes) invalid();
      consume(data);
    } else if (type === 2) {
      if (fragments || length > budget.limits.maxRecordBytes) invalid();
      fragments = [data];
      fragmentSize = length;
    } else if (type === 3 || type === 4) {
      if (!fragments) invalid();
      fragments.push(data);
      fragmentSize += length;
      if (fragmentSize > budget.limits.maxRecordBytes) invalid();
      if (type === 4) {
        consume(Buffer.concat(fragments, fragmentSize));
        fragments = undefined;
      }
    } else invalid();
  }
  // A FIRST/MIDDLE tail is an unfinished atomic write, not a new value.
}

type Entry = { sequence: bigint; type: number; value: Buffer };
class Latest {
  value?: Entry;
  add(sequence: bigint, type: number, value: Buffer): void {
    if (sequence > MAX_SEQUENCE || (type !== 0 && type !== 1)) invalid();
    if (this.value?.sequence === sequence) {
      if (this.value.type !== type || !this.value.value.equals(value))
        invalid();
    } else if (!this.value || sequence > this.value.sequence) {
      this.value = { sequence, type, value };
    }
  }
}

function writeBatch(bytes: Buffer, budget: Budget, latest: Latest): void {
  if (bytes.length < 12) invalid();
  const sequence = bytes.readBigUInt64LE(0);
  const count = bytes.readUInt32LE(8);
  if (sequence > MAX_SEQUENCE || sequence + BigInt(count) > MAX_SEQUENCE + 1n)
    invalid();
  const c = new Cursor(bytes);
  c.offset = 12;
  // Validate the complete atomic batch before accepting any target changes.
  const found: Entry[] = [];
  for (let i = 0; i < count; i++) {
    budget.entry();
    if (c.offset >= bytes.length) invalid();
    const type = bytes[c.offset++];
    if (type !== 0 && type !== 1) invalid();
    const key = c.slice();
    const value = type === 1 ? c.slice() : Buffer.alloc(0);
    if (key.equals(ACCESS_KEY))
      found.push({ sequence: sequence + BigInt(i), type, value });
  }
  if (c.offset !== bytes.length) invalid();
  for (const entry of found)
    latest.add(entry.sequence, entry.type, entry.value);
}

type LiveFiles = {
  log: bigint;
  previousLog: bigint;
  tables: Set<bigint>;
};
function manifest(bytes: Buffer, budget: Budget): LiveFiles {
  const files: LiveFiles = { log: 0n, previousLog: 0n, tables: new Set() };
  let hasLog = false;
  logRecords(bytes, budget, record => {
    const c = new Cursor(record);
    while (c.offset < record.length) {
      budget.entry();
      const tag = c.number();
      if (tag === 1) {
        if (c.slice().toString('ascii') !== 'leveldb.BytewiseComparator')
          invalid();
      } else if (tag === 2) {
        files.log = c.varint();
        hasLog = true;
      } else if (tag === 3 || tag === 4) c.varint();
      else if (tag === 9) files.previousLog = c.varint();
      else if (tag === 5) {
        if (c.number() > 6) invalid();
        c.slice();
      } else if (tag === 6 || tag === 7) {
        if (c.number() > 6) invalid();
        const number = c.varint();
        if (tag === 6) files.tables.delete(number);
        else {
          c.varint();
          c.slice();
          c.slice();
          files.tables.add(number);
          if (files.tables.size > budget.limits.maxFiles) invalid();
        }
      } else invalid();
    }
  });
  if (!hasLog) invalid();
  return files;
}

function blockEntries(
  bytes: Buffer,
  budget: Budget,
  consume: (k: Buffer, v: Buffer) => void
) {
  if (bytes.length < 4) invalid();
  const count = bytes.readUInt32LE(bytes.length - 4);
  if (count < 1 || count > (bytes.length - 4) / 4) invalid();
  const end = bytes.length - (count + 1) * 4;
  const restarts = new Set<number>();
  let previousRestart = -1;
  for (let i = 0; i < count; i++) {
    const restart = bytes.readUInt32LE(end + i * 4);
    if (
      restart <= previousRestart ||
      restart > end ||
      (i === 0 && restart !== 0)
    )
      invalid();
    restarts.add(restart);
    previousRestart = restart;
  }
  const c = new Cursor(bytes.subarray(0, end));
  let previous = Buffer.alloc(0);
  while (c.offset < end) {
    budget.entry();
    const isRestart = restarts.delete(c.offset);
    const shared = c.number();
    const unshared = c.number();
    const size = c.number();
    if (
      shared > previous.length ||
      (isRestart && shared !== 0) ||
      unshared > end - c.offset ||
      size > end - c.offset - unshared ||
      shared + unshared > budget.limits.maxBlockBytes
    )
      invalid();
    const key = Buffer.concat([
      previous.subarray(0, shared),
      bytes.subarray(c.offset, c.offset + unshared),
    ]);
    c.offset += unshared;
    const value = bytes.subarray(c.offset, c.offset + size);
    c.offset += size;
    consume(key, value);
    previous = key;
  }
  if (end !== 0 && restarts.size) invalid();
}

type Handle = { offset: number; size: number };
function blockHandle(c: Cursor): Handle {
  return { offset: c.number(), size: c.number() };
}

async function readAt(
  file: FileHandle,
  size: number,
  offset: number,
  budget: Budget
) {
  budget.spend(size);
  const bytes = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const { bytesRead } = await file.read(
      bytes,
      done,
      size - done,
      offset + done
    );
    if (!bytesRead) invalid();
    done += bytesRead;
  }
  return bytes;
}

async function withFile<T>(
  name: string,
  budget: Budget,
  run: (file: FileHandle, size: number) => Promise<T>
): Promise<T> {
  if (++budget.files > budget.limits.maxFiles) invalid();
  const file = await open(
    name,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > budget.limits.maxFileBytes) invalid();
    const previous = budget.snapshots.get(name);
    if (previous && !sameFile(previous, info)) invalid();
    budget.snapshots.set(name, info);
    const value = await run(file, info.size);
    const after = await file.stat();
    if (!sameFile(info, after)) invalid();
    return value;
  } finally {
    await file.close();
  }
}

async function storeNames(dir: string, budget: Budget): Promise<string[]> {
  const names: string[] = [];
  const iterator = await opendir(dir);
  let entries = 0;
  for await (const item of iterator) {
    if (++entries > budget.limits.maxFiles * 4) invalid();
    if (/^\d+\.(log|ldb|sst)$/.test(item.name)) names.push(item.name);
  }
  return names.sort();
}

async function readBlock(
  file: FileHandle,
  handle: Handle,
  fileSize: number,
  budget: Budget
) {
  if (
    handle.size > budget.limits.maxBlockBytes ||
    handle.offset > fileSize - 48 - 5 - handle.size
  )
    invalid();
  const raw = await readAt(file, handle.size + 5, handle.offset, budget);
  const compressed = raw.subarray(0, handle.size);
  const type = raw[handle.size];
  if (raw.readUInt32LE(handle.size + 1) !== maskedCrc(compressed, type, false))
    invalid();
  if (type === 0) return compressed;
  if (type !== 1) invalid();
  const out = decodeDesktopSnappy(compressed, budget.limits.maxBlockBytes);
  budget.spend(out.length);
  return out;
}

async function table(name: string, budget: Budget, latest: Latest) {
  await withFile(name, budget, async (file, size) => {
    if (size < 48) invalid();
    const footer = await readAt(file, 48, size - 48, budget);
    if (footer.readBigUInt64LE(40) !== TABLE_MAGIC) invalid();
    const c = new Cursor(footer.subarray(0, 40));
    blockHandle(c); // Metaindex is not needed to read a single key.
    const index = blockHandle(c);
    const selected: Handle[] = [];
    let passed = false;
    blockEntries(
      await readBlock(file, index, size, budget),
      budget,
      (key, value) => {
        if (key.length < 8) invalid();
        const order = key.subarray(0, key.length - 8).compare(ACCESS_KEY);
        // Include all separators equal to the user key plus the first above it.
        // The token's versions can straddle a data-block boundary.
        if (order < 0 || passed) return;
        const v = new Cursor(value);
        selected.push(blockHandle(v));
        if (v.offset !== value.length) invalid();
        if (order > 0) passed = true;
      }
    );
    for (const handle of selected) {
      const data = await readBlock(file, handle, size, budget);
      blockEntries(data, budget, (key, value) => {
        if (key.length < 8) invalid();
        if (!key.subarray(0, key.length - 8).equals(ACCESS_KEY)) return;
        const tag = key.readBigUInt64LE(key.length - 8);
        latest.add(tag >> 8n, Number(tag & 255n), value);
      });
    }
  });
}

function tokenState(
  entry: Entry | undefined,
  now: number,
  budget: Budget
): DesktopTokenState {
  if (!entry) return { kind: 'missing' };
  if (entry.type === 0) return { kind: 'signed-out' };
  const bytes = entry.value;
  if (!bytes.length || bytes.length > budget.limits.maxTokenBytes) invalid();
  const encoding = bytes[0];
  if (encoding !== 0 && encoding !== 1) invalid();
  if (encoding === 0 && (bytes.length - 1) % 2) invalid();
  const token = bytes.subarray(1).toString(encoding === 1 ? 'utf8' : 'utf16le');
  if (!token || token === 'null' || token === 'undefined')
    return { kind: 'signed-out' };
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    );
  } catch {
    return invalid();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    invalid();
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) invalid();
  if (exp * 1000 <= now) return { kind: 'expired' };
  return { kind: 'valid', accessToken: token, expiresAt: exp };
}

/**
 * `desktopDir` is the configured Kimi app data directory, never a browser
 * profile. A corrupt, changing or over-budget store fails closed: no older
 * token is returned as a fallback. The caller owns network validation.
 */
export async function readDesktopAccessToken(
  desktopDir: string,
  options: { now?: number; limits?: Partial<DesktopTokenLimits> } = {}
): Promise<DesktopTokenState> {
  const dir = path.join(desktopDir, 'Local Storage', 'leveldb');
  try {
    const budget = new Budget(options.limits);
    const currentFile = path.join(dir, 'CURRENT');
    const current = await withFile(currentFile, budget, (file, size) => {
      if (size > 128) invalid();
      return readAt(file, size, 0, budget);
    });
    const name = current.toString('ascii');
    if (!/^MANIFEST-\d+\n$/.test(name)) invalid();
    const manifestFile = path.join(dir, name.trim());
    const before = await stat(manifestFile);
    const live = await withFile(manifestFile, budget, async (file, size) =>
      manifest(await readAt(file, size, 0, budget), budget)
    );
    const names = await storeNames(dir, budget);
    const latest = new Latest();
    for (const number of live.tables) {
      const matches = names.filter(
        n => /^\d+\.(ldb|sst)$/.test(n) && BigInt(n.split('.')[0]) === number
      );
      if (matches.length !== 1) invalid();
      await table(path.join(dir, matches[0]), budget, latest);
    }
    for (const name of names.filter(n => n.endsWith('.log'))) {
      const number = BigInt(name.split('.')[0]);
      if (number < live.log && number !== live.previousLog) continue;
      await withFile(path.join(dir, name), budget, async (file, size) =>
        logRecords(await readAt(file, size, 0, budget), budget, batch =>
          writeBatch(batch, budget, latest)
        )
      );
    }
    // Rotation or compaction during the read must not revive obsolete values.
    const after = await stat(manifestFile);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      invalid();
    const currentAfter = await withFile(currentFile, budget, (file, size) => {
      if (size > 128) invalid();
      return readAt(file, size, 0, budget);
    });
    if (!currentAfter.equals(current)) invalid();
    const namesAfter = await storeNames(dir, budget);
    if (
      namesAfter.length !== names.length ||
      names.some((name, index) => name !== namesAfter[index])
    )
      invalid();
    // Recheck earlier journals too: the app may append a sign-out while a
    // later table/log is being read, after the first journal's local check.
    for (const [file, before] of budget.snapshots)
      if (!sameFile(before, await lstat(file))) invalid();
    const now = options.now ?? Date.now();
    if (!Number.isFinite(now)) invalid();
    return tokenState(latest.value, now, budget);
  } catch (error) {
    // A missing CURRENT means no usable desktop login. Missing live tables or
    // permission errors also never return a previously found token.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
      return { kind: 'missing' };
    return { kind: 'unavailable' };
  }
}
