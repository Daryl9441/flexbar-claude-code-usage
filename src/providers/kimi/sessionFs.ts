/**
 * Small read-only file helpers for the Kimi session source: JSON files read
 * without ever quoting their content (a JSON.parse error message repeats the
 * input, and some Kimi files hold tokens), directory listings that never
 * throw, and the text clean-up shared by titles and project names.
 */
import { Dirent, promises as fsp } from 'node:fs';
import path from 'node:path';

/** Kimi's JSON stores are small; anything bigger is not what we expect. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** A finite number, or a numeric string, else null. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Milliseconds from an ISO string, epoch ms or epoch seconds; else null. */
export function timeOf(value: unknown): number | null {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  const n = num(value);
  if (n === null || n <= 0) return null;
  // epoch seconds (Kimi Code writes ms; some stores write seconds)
  return n < 100_000_000_000 ? n * 1000 : n;
}

/** JSON.parse that never throws and never reports the input. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A file's mtime in ms, or null when it is missing or not a file. */
export async function mtimeOf(file: string): Promise<number | null> {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** A directory's mtime in ms, or null when it is missing. */
export async function dirMtimeOf(dir: string): Promise<number | null> {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

export async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Reads and parses a JSON file; undefined when missing, too big or invalid. */
export async function readJson(file: string): Promise<unknown> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return undefined;
    return parseJson(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A JSON file re-read only when its mtime or size changes. `value` keeps
 * the last good parse while the file is being rewritten.
 */
export class JsonFile<T> {
  value: T;
  /** mtime of the file when last read, or null when it was missing */
  mtimeMs: number | null = null;
  private size = -1;

  constructor(
    readonly path: string,
    private readonly empty: T,
    private readonly convert: (raw: unknown) => T | undefined
  ) {
    this.value = empty;
  }

  /** Brings the value up to date; true when it changed. */
  async sync(): Promise<boolean> {
    let st;
    try {
      st = await fsp.stat(this.path);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      const had = this.mtimeMs !== null;
      this.mtimeMs = null;
      this.size = -1;
      this.value = this.empty;
      return had;
    }
    if (st.mtimeMs === this.mtimeMs && st.size === this.size) return false;
    const raw =
      st.size > MAX_JSON_BYTES ? undefined : await readJson(this.path);
    const next = raw === undefined ? undefined : this.convert(raw);
    if (next === undefined) return false; // mid-write: try again next poll
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    this.value = next;
    return true;
  }
}

// --- text ----------------------------------------------------------------------

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text;
}

/** A title for the key: one line, at most 200 characters, or null. */
export function cleanTitle(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const line = oneLine(text);
  return line ? clip(line, 200) : null;
}

/** Last segment of a path written on any platform. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Path spelled for the settings page: the home folder as `~`. */
export function tildify(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length);
  }
  return p;
}

// --- project filter ----------------------------------------------------------------

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/**
 * Whether a project filter ("part of the project path") matches any of the
 * texts: a plain case-insensitive substring, or the same with every
 * non-alphanumeric character as "-" (so "my app" finds "my-app").
 */
export function matchesFilter(
  filter: string,
  texts: (string | null | undefined)[]
): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const nf = normalize(f);
  const loose = /[a-z0-9]/.test(nf);
  for (const text of texts) {
    if (!text) continue;
    if (text.toLowerCase().includes(f)) return true;
    if (loose && normalize(text).includes(nf)) return true;
  }
  return false;
}
