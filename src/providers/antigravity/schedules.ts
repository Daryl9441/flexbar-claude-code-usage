/**
 * Antigravity scheduled tasks, read-only.
 *
 * The Scheduled Tasks panel and the `schedule` sidecar builtin store each
 * job as `sidecar.json` under `<root>/config/sidecars/<id>/` (global) or
 * `<root>/config/plugins/<plugin>/sidecars/<id>/` (plugin id
 * `<plugin>/<id>`). `<root>` is antigravityRoot() (`~/.gemini` unless
 * `antigravityDir` is set). The first `args` entry of a
 * `"builtin": "schedule"` sidecar is a five-field cron expression. A task
 * runs only when `<root>/config/config.json` sets `sidecars[<id>].enabled`
 * to true. The latest run time is the newest file mtime under
 * `<root>/antigravity/sidecar_data/<id>/{logs,events}`.
 *
 * Privacy: the prompt (later args), description, env, command and log
 * bodies are never kept, and a JSON parse error is never reported (it
 * quotes the file). Nothing here is logged.
 */
import { Dirent, promises as fsp } from 'node:fs';
import path from 'node:path';

import { nextRunOf, parseCron } from '../kimi/cronNext';
import type { AutomationBoard, AutomationItem } from '../types';

import { DATA_FOLDERS } from './paths';

const MAX_ITEMS = 100;
const MAX_SIDECAR_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_RUN_FILES = 50;

type ScheduleFacts = {
  id: string;
  title: string;
  enabled: boolean;
  cron: string | null;
  timezone: string | null;
  lastRunAt: number | null;
  updatedAt: number | null;
};

type Listed = { entries: Dirent[]; missing: boolean; failed: boolean };

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One directory name: no separators, so a listing cannot escape its folder. */
function isSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function isZone(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_+-]{1,32}(?:\/[A-Za-z0-9_+-]{1,32}){0,2}$/.test(value)
  );
}

function localZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

function oneLine(text: string): string {
  let out = '';
  for (const char of text) out += char.charCodeAt(0) <= 32 ? ' ' : char;
  return out.replace(/ +/g, ' ').trim();
}

function titleOf(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const line = oneLine(value);
  if (!line) return fallback;
  const chars = Array.from(line);
  return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : line;
}

/**
 * The cron expression and its zone, only when it is a supported five-field
 * schedule. Antigravity writes schedules as `CRON_TZ=<zone> <cron>` (also
 * accepted: `TZ=<zone>`); the prefix names the zone and is not part of the
 * expression.
 */
function cronOf(args: unknown): { cron: string | null; zone: string | null } {
  const none = { cron: null, zone: null };
  if (!Array.isArray(args) || typeof args[0] !== 'string') return none;
  let text = args[0].trim();
  let zone: string | null = null;
  const prefix = /^(?:CRON_TZ|TZ)=(\S+)\s+/.exec(text);
  if (prefix) {
    zone = isZone(prefix[1]) ? prefix[1] : null;
    text = text.slice(prefix[0].length).trim();
  }
  if (text.length > 80 || !parseCron(text)) return none;
  return { cron: text, zone };
}

function factsOf(
  id: string,
  raw: unknown,
  enabled: boolean,
  updatedAt: number | null
): ScheduleFacts | null {
  if (!isObj(raw) || raw.builtin !== 'schedule') return null;
  const { cron, zone } = cronOf(raw.args);
  return {
    id,
    title: titleOf(raw.display_name, id),
    enabled,
    cron,
    timezone: isZone(raw.timezone) ? raw.timezone : zone,
    lastRunAt: null,
    updatedAt,
  };
}

/** A regular file's JSON, or undefined. Parse failures are discarded. */
async function readJsonFile(file: string, max: number): Promise<unknown> {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size <= 0 || st.size > max) return undefined;
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  if (text.length > max) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function listDir(dir: string): Promise<Listed> {
  try {
    return {
      entries: await fsp.readdir(dir, { withFileTypes: true }),
      missing: false,
      failed: false,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { entries: [], missing: true, failed: false };
    }
    return { entries: [], missing: false, failed: true };
  }
}

async function fileMtime(file: string): Promise<number | null> {
  try {
    const st = await fsp.lstat(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Newest regular file under `dir`, one level, contents unread. */
async function newestMtime(dir: string): Promise<number | null> {
  const listed = await listDir(dir);
  let newest: number | null = null;
  let seen = 0;
  for (const entry of listed.entries) {
    if (seen >= MAX_RUN_FILES) break;
    if (!entry.isFile() || entry.isSymbolicLink() || !isSegment(entry.name)) {
      continue;
    }
    seen++;
    const mtime = await fileMtime(path.join(dir, entry.name));
    if (mtime !== null && (newest === null || mtime > newest)) newest = mtime;
  }
  return newest;
}

/** Scheduled tasks under one Antigravity root. */
export class AntigravitySchedules {
  private items: ScheduleFacts[] = [];
  private failed = false;

  constructor(readonly root: string) {}

  /** Re-reads the sidecar manifests and the run-file times. */
  async sync(): Promise<void> {
    this.failed = false;
    const enabled = await this.enabledIds();
    const items = await this.collect(
      path.join(this.root, 'config', 'sidecars'),
      name => name,
      enabled
    );
    const plugins = await listDir(path.join(this.root, 'config', 'plugins'));
    if (plugins.failed) this.failed = true;
    for (const plugin of plugins.entries) {
      if (items.length >= MAX_ITEMS) break;
      if (
        !plugin.isDirectory() ||
        plugin.isSymbolicLink() ||
        !isSegment(plugin.name)
      ) {
        continue;
      }
      const nested = await this.collect(
        path.join(this.root, 'config', 'plugins', plugin.name, 'sidecars'),
        name => `${plugin.name}/${name}`,
        enabled
      );
      items.push(...nested);
    }
    for (const item of items.slice(0, MAX_ITEMS)) {
      item.lastRunAt = await this.lastRunAt(item.id);
    }
    this.items = items.slice(0, MAX_ITEMS);
  }

  /**
   * The enabled tasks as the session key draws them (disabled ones are left
   * off the board). `now` places the next runs.
   */
  board(now: number): AutomationBoard {
    const zone = localZone();
    const items: AutomationItem[] = this.items
      .filter(item => item.enabled)
      .map(item => {
        const timezone = item.timezone ?? zone;
        return {
          id: item.id,
          title: item.title,
          enabled: item.enabled,
          cron: item.cron,
          timezone,
          nextRunAt:
            item.enabled && item.cron
              ? nextRunOf(item.cron, timezone, now)
              : null,
          running: false,
          failed: false,
          lastRunAt: item.lastRunAt,
          updatedAt: item.updatedAt,
        };
      });
    return { available: !this.failed, items };
  }

  /** Ids whose config.json entry sets enabled to true. Missing file: none. */
  private async enabledIds(): Promise<Set<string>> {
    const raw = await readJsonFile(
      path.join(this.root, 'config', 'config.json'),
      MAX_CONFIG_BYTES
    );
    const on = new Set<string>();
    if (!isObj(raw) || !isObj(raw.sidecars)) return on;
    for (const [id, value] of Object.entries(raw.sidecars)) {
      if (!isObj(value) || value.enabled !== true) continue;
      const parts = id.split('/');
      if (parts.length > 2 || parts.some(part => !isSegment(part))) continue;
      on.add(id);
    }
    return on;
  }

  private async collect(
    dir: string,
    idOf: (name: string) => string,
    enabled: Set<string>
  ): Promise<ScheduleFacts[]> {
    const listed = await listDir(dir);
    if (listed.failed) this.failed = true;
    const out: ScheduleFacts[] = [];
    for (const entry of listed.entries) {
      if (out.length >= MAX_ITEMS) break;
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !isSegment(entry.name)
      ) {
        continue;
      }
      const id = idOf(entry.name);
      const file = path.join(dir, entry.name, 'sidecar.json');
      const facts = factsOf(
        id,
        await readJsonFile(file, MAX_SIDECAR_BYTES),
        enabled.has(id),
        await fileMtime(file)
      );
      if (facts) out.push(facts);
    }
    return out;
  }

  /** Newest log or event mtime. The files themselves are not read. */
  private async lastRunAt(id: string): Promise<number | null> {
    const parts = id.split('/');
    if (parts.some(part => !isSegment(part))) return null;
    const base = path.join(
      this.root,
      DATA_FOLDERS.app,
      'sidecar_data',
      ...parts
    );
    const times = await Promise.all([
      newestMtime(path.join(base, 'logs')),
      newestMtime(path.join(base, 'events')),
    ]);
    const known = times.filter((time): time is number => time !== null);
    return known.length ? Math.max(...known) : null;
  }
}
