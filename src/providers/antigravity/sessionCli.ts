/**
 * Finds the Antigravity programs on this computer (read-only): the `agy` CLI
 * for the New Session key's terminal command and both keys' "installed"
 * checks, and the desktop app / IDE bundles (macOS). FlexDesigner, a GUI
 * app, does not get the login shell's PATH, so the installer's folder
 * (~/.local/bin) and Homebrew's are searched too; the user's shell is never
 * started to look.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AntigravityProduct } from './paths';

export type AgySearch = {
  /** The antigravityPath setting (absolute), or null: search */
  setting: string | null;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Tests: whether a path is an executable file */
  isExecutable?: (file: string) => boolean;
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

/** Folders searched for agy, in order (PATH first). */
export function agyFolders(search: AgySearch): string[] {
  const platform = search.platform ?? process.platform;
  const env = search.env ?? process.env;
  const home = search.home ?? os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map(d => d.trim())
    .filter(Boolean);
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      dirs.push(join(env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin'));
    }
    dirs.push(join(home, '.local', 'bin'));
  } else {
    dirs.push(
      join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin'
    );
  }
  return [...new Set(dirs)];
}

/**
 * The agy program: the setting when it is set (no search then, so a wrong
 * setting shows as "not found"), else the first `agy` on PATH and in the
 * usual folders. Null when not found.
 */
export function findAgy(search: AgySearch): string | null {
  const isExecutable = search.isExecutable ?? defaultIsExecutable;
  if (search.setting)
    return isExecutable(search.setting) ? search.setting : null;
  const platform = search.platform ?? process.platform;
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of agyFolders(search)) {
    for (const name of names) {
      const file = join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

/** Bundle ids of the macOS apps (`open -b`). */
export const BUNDLE_IDS: Readonly<
  Record<Exclude<AntigravityProduct, 'cli'>, string>
> = {
  app: 'com.google.antigravity',
  ide: 'com.google.antigravity-ide',
};

const BUNDLE_NAMES: Readonly<
  Record<Exclude<AntigravityProduct, 'cli'>, string>
> = {
  app: 'Antigravity.app',
  ide: 'Antigravity IDE.app',
};

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the desktop app or the IDE is in /Applications or ~/Applications (macOS). */
export function bundleInstalled(
  product: Exclude<AntigravityProduct, 'cli'>,
  home: string = os.homedir(),
  exists: (dir: string) => boolean = isDirectory
): boolean {
  const name = BUNDLE_NAMES[product];
  return [
    path.join('/Applications', name),
    path.join(home, 'Applications', name),
  ].some(exists);
}
