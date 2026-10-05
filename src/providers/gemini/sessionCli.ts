/**
 * Finds the Gemini CLI program, for the Session key's "not found" notice and
 * the New Session key's terminal command. FlexDesigner, a GUI app, does not
 * get the login shell's PATH, so the usual install folders are searched too
 * (Homebrew, npm global, nvm, Volta, Bun, pnpm). The user's shell is never
 * started to look (it would run their dotfiles). Read-only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CliSearch = {
  /** The geminiPath setting (absolute), or null: search */
  setting: string | null;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Tests: whether a path is an executable file */
  isExecutable?: (file: string) => boolean;
  /** Tests: folder listing (for ~/.nvm/versions/node/<version>/bin) */
  listDir?: (dir: string) => string[];
};

function defaultIsExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultListDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Newest version folder first: v22.3.0 before v20.11.1. */
function byVersionDesc(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Folders searched for the CLI, in order (PATH first). */
export function cliFolders(search: CliSearch): string[] {
  const platform = search.platform ?? process.platform;
  const env = search.env ?? process.env;
  const home = search.home ?? os.homedir();
  const listDir = search.listDir ?? defaultListDir;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map(d => d.trim())
    .filter(Boolean);
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'pnpm'));
    dirs.push(join(home, '.bun', 'bin'), join(home, '.volta', 'bin'));
    return [...new Set(dirs)];
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.yarn', 'bin')
  );
  const nvm = join(
    env.NVM_DIR?.trim() || join(home, '.nvm'),
    'versions',
    'node'
  );
  for (const version of listDir(nvm).sort(byVersionDesc)) {
    dirs.push(join(nvm, version, 'bin'));
  }
  return [...new Set(dirs)];
}

/**
 * The Gemini CLI program: the setting when it points at a program (no
 * search then, so a wrong setting shows as "not found"), else the first
 * `gemini` in PATH and the usual install folders. Null when not found.
 */
export function findGeminiCli(search: CliSearch): string | null {
  const isExecutable = search.isExecutable ?? defaultIsExecutable;
  if (search.setting)
    return isExecutable(search.setting) ? search.setting : null;
  const platform = search.platform ?? process.platform;
  const names =
    platform === 'win32' ? ['gemini.cmd', 'gemini.exe', 'gemini'] : ['gemini'];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of cliFolders(search)) {
    for (const name of names) {
      const file = join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}
