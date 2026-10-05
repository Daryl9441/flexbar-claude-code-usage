/**
 * A Kimi turn journal (wire.jsonl) followed incrementally: read from the
 * tail on first sight, then only the bytes appended since. The same pattern
 * as Claude's TranscriptFile (src/sessionSource.ts), for Kimi's records.
 */
import { promises as fsp } from 'node:fs';

import {
  WireAcc,
  createWireAcc,
  isLegacyWire,
  observeWireLines,
} from './sessionWire';

const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const HEAD_BYTES = 4096;

export class WireFile {
  acc: WireAcc = createWireAcc();
  mtimeMs: number | null = null;
  private offset = 0;
  private ino = -1;
  private size = -1;

  constructor(readonly path: string) {}

  /** Reads what was appended since the last sync; true when anything was. */
  async sync(): Promise<boolean> {
    const st = await fsp.stat(this.path);
    if (st.ino !== this.ino || st.size < this.offset) {
      // new, truncated or replaced file: start over from the tail
      this.ino = st.ino;
      this.size = -1;
      this.offset = 0;
      this.acc = createWireAcc();
      this.acc.protocol = await this.readProtocol();
      await this.readTail(st.size);
    } else if (st.size === this.size && st.mtimeMs === this.mtimeMs) {
      return false;
    } else if (st.size > this.offset) {
      await this.readRange(this.offset, st.size, false);
    }
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return true;
  }

  /** protocol_version from the metadata line at the start of the file. */
  private async readProtocol(): Promise<number | null> {
    let fh;
    try {
      fh = await fsp.open(this.path, 'r');
      const head = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
      const text = head.subarray(0, bytesRead).toString('utf8');
      const nl = text.indexOf('\n');
      if (nl < 0) return null;
      const probe = createWireAcc();
      observeWireLines(probe, text.slice(0, nl));
      return probe.protocol;
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }

  /**
   * Parses the end of the file, widening the window until it holds the
   * newest turn's start or end: configuration records alone say nothing
   * about the state, and steps without their prompt lose the turn's start
   * time (Kimi Work writes 200+ KB tool lists right after a prompt). An
   * older journal with a call still open also needs its permission mode,
   * for the approval guess.
   */
  private async readTail(size: number) {
    for (let window = INITIAL_TAIL_BYTES; ; window *= 4) {
      const start = Math.max(0, size - window);
      const protocol = this.acc.protocol;
      this.acc = createWireAcc();
      this.acc.protocol = protocol;
      this.offset = start;
      await this.readRange(start, size, start > 0);
      if (start === 0 || window >= MAX_TAIL_BYTES) return;
      const acc = this.acc;
      const needsMode =
        isLegacyWire(acc) &&
        acc.permissionMode === null &&
        acc.ended === null &&
        acc.tools.size > 0;
      if (acc.sawPrompt && !needsMode) return;
    }
  }

  /**
   * Feeds the complete lines in [from, to) to the accumulator; a trailing
   * partial line waits for the next read. With skipFirst, bytes up to the
   * first newline are dropped (the read starts mid-line).
   */
  private async readRange(from: number, to: number, skipFirst: boolean) {
    const fh = await fsp.open(this.path, 'r');
    try {
      let pos = from;
      let carry: Buffer = Buffer.alloc(0);
      let skipping = skipFirst;
      while (pos < to) {
        const length = Math.min(READ_CHUNK_BYTES, to - pos);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await fh.read(chunk, 0, length, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        let data: Buffer = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        if (skipping) {
          const nl = data.indexOf(0x0a);
          if (nl < 0) {
            carry = Buffer.alloc(0);
            this.offset = pos;
            continue;
          }
          data = data.subarray(nl + 1);
          skipping = false;
        }
        // a newline byte never occurs inside a UTF-8 sequence
        const lastNl = data.lastIndexOf(0x0a);
        if (lastNl < 0) {
          carry = data;
          continue;
        }
        observeWireLines(this.acc, data.subarray(0, lastNl).toString('utf8'));
        carry = data.subarray(lastNl + 1);
        this.offset = pos - carry.length;
      }
    } finally {
      await fh.close();
    }
  }
}
