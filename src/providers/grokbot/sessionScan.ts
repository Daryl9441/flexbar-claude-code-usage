/**
 * Reads Grok Bot's local status files. Read-only: regular files only, size
 * capped, and a JSON failure is dropped without logging the contents.
 *
 * What is actually on disk:
 * - sand-session-marker.json (pid, startedAtMs, aliveAtMs) in the Electron
 *   userData directory: the app process, once the pid still belongs to Grok Bot.
 * - ~/.grokbot/local-exec-daemon.json (pid, inflightCount): local work the
 *   daemon is running. It is not tied to one bot.
 * - sand-client-persistence/*.blob: the roster (bot id, name,
 *   awaitingUserResponse, lastActivityAt) and transcript replicas. A replica
 *   contributes only its latest timestamp. Message text is not kept: the
 *   mirror is a window of recent entries and has no live "still generating"
 *   flag, so a bot is never marked Working from it.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { decodeBase32 } from './base32';
import { DAEMON_FILE, PERSISTENCE_DIR, SESSION_MARKER } from './paths';
import { PidAlive } from './sessionProcs';

const MARKER_MAX_BYTES = 64 * 1024;
const DAEMON_MAX_BYTES = 64 * 1024;
const BLOB_MAX_BYTES = 2 * 1024 * 1024;
const MAX_BLOBS = 200;
const MAX_BOTS = 36;
const MIN_MS = Date.UTC(2020, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
const MAX_INFLIGHT = 64;

const ROSTER_SLICE =
  /^sand\.client\.slice\.account\.(.+?)\.roster\.last-roster$/;
const TRANSCRIPT_SLICE =
  /^sand\.client\.slice\.account\.(.+?)\.transcript\.replicas\.(.+)$/;

export type GrokbotBot = {
  id: string;
  name: string;
  awaitingUser: boolean;
  lastActivityAt: number | null;
};

export type GrokbotSnapshot = {
  installed: boolean;
  appRunning: boolean;
  /** When the app process was started, if the marker said so. */
  appSince: number | null;
  /** Local tasks in flight, or 0 when the daemon is not alive. */
  inflight: number;
  bots: GrokbotBot[];
};

export type ScanInput = {
  userDataDir: string;
  dataRoot: string;
  appCandidates: string[];
  exists: (file: string) => boolean;
  pidAlive: PidAlive;
  /** False: ignore pids, so the key does not claim the app is running. */
  checkPids: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < MIN_MS ? value * 1000 : value;
    return ms >= MIN_MS && ms < MAX_MS ? ms : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && !/[tT\-:Z]/.test(value)) {
      return epochMs(asNumber);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= MIN_MS && parsed < MAX_MS
      ? parsed
      : null;
  }
  return null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    cleaned += code < 32 ? ' ' : char;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || null;
}

function positivePid(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 1 &&
    value < 1_000_000_000
    ? value
    : null;
}

async function readJson(
  file: string,
  maxBytes: number
): Promise<unknown | null> {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch {
    return null;
  }
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.size <= 0 ||
    st.size > maxBytes
  ) {
    return null;
  }
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sliceKey(fileName: string): string | null {
  if (!fileName.endsWith('.blob')) return null;
  return decodeBase32(fileName.slice(0, -'.blob'.length));
}

async function readBots(userDataDir: string): Promise<GrokbotBot[]> {
  const dir = path.join(userDataDir, PERSISTENCE_DIR);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const slices = names
    .slice(0, MAX_BLOBS)
    .map(name => ({ name, key: sliceKey(name) }))
    .filter(
      (slice): slice is { name: string; key: string } => slice.key !== null
    );

  const bots = new Map<string, GrokbotBot>();
  const touch = (id: string, name?: string | null): GrokbotBot => {
    const existing = bots.get(id);
    if (existing) {
      if (name && existing.name === 'Bot') existing.name = name;
      return existing;
    }
    const created: GrokbotBot = {
      id,
      name: name || 'Bot',
      awaitingUser: false,
      lastActivityAt: null,
    };
    bots.set(id, created);
    return created;
  };

  for (const slice of slices) {
    if (!ROSTER_SLICE.test(slice.key)) continue;
    const value = await readJson(path.join(dir, slice.name), BLOB_MAX_BYTES);
    const rows =
      isRecord(value) && isRecord(value.value) ? value.value.rows : null;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = cleanName(row.id);
      if (!id) continue;
      const bot = touch(id, cleanName(row.name));
      if (row.awaitingUserResponse === true) bot.awaitingUser = true;
      const at = epochMs(row.lastActivityAt);
      if (
        at !== null &&
        (bot.lastActivityAt === null || at > bot.lastActivityAt)
      ) {
        bot.lastActivityAt = at;
      }
    }
  }

  for (const slice of slices) {
    const match = TRANSCRIPT_SLICE.exec(slice.key);
    if (!match) continue;
    const id = cleanName(match[2]);
    if (!id) continue;
    const value = await readJson(path.join(dir, slice.name), BLOB_MAX_BYTES);
    const entries =
      isRecord(value) && isRecord(value.value) ? value.value.entries : null;
    if (!Array.isArray(entries)) continue;
    let latest: number | null = null;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const at = epochMs(entry.timestampMs);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
    if (latest === null) continue;
    const bot = touch(id);
    if (bot.lastActivityAt === null || latest > bot.lastActivityAt) {
      bot.lastActivityAt = latest;
    }
  }

  return [...bots.values()]
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, MAX_BOTS);
}

export async function scanGrokbot(input: ScanInput): Promise<GrokbotSnapshot> {
  const places = [input.userDataDir, input.dataRoot, ...input.appCandidates];
  const installed = places.some(place => {
    try {
      return input.exists(place);
    } catch {
      return false;
    }
  });

  let appRunning = false;
  let appSince: number | null = null;
  let inflight = 0;

  if (input.checkPids) {
    const marker = await readJson(
      path.join(input.userDataDir, SESSION_MARKER),
      MARKER_MAX_BYTES
    );
    if (isRecord(marker)) {
      const pid = positivePid(marker.pid);
      appSince = epochMs(marker.startedAtMs) ?? epochMs(marker.aliveAtMs);
      if (pid !== null && input.pidAlive(pid)) appRunning = true;
    }
    const daemon = await readJson(
      path.join(input.dataRoot, DAEMON_FILE),
      DAEMON_MAX_BYTES
    );
    if (isRecord(daemon)) {
      const pid = positivePid(daemon.pid);
      const count = daemon.inflightCount;
      if (
        pid !== null &&
        input.pidAlive(pid) &&
        typeof count === 'number' &&
        Number.isInteger(count) &&
        count > 0 &&
        count <= MAX_INFLIGHT
      ) {
        inflight = count;
      }
    }
  }

  const bots = installed ? await readBots(input.userDataDir) : [];
  return { installed, appRunning, appSince, inflight, bots };
}
