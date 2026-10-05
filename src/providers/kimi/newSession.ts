/**
 * Kimi New Session key: what a press opens.
 *
 * - Kimi Code CLI: a terminal window running `kimi` (new session) in the
 *   key's folder, or `kimi --continue` / `kimi --plan` (`cliMode`). The key
 *   group writes a self-deleting script with every word quoted and opens it
 *   (src/launch.ts); nothing here builds shell text.
 * - Kimi desktop: `kimi-work://open` brings the app forward on Kimi Work.
 *   The app takes no folder (and opens its last Kimi Work view; "New task"
 *   is the app's ⌘K).
 *
 * `target`: auto (default) picks the CLI when a folder is set and the CLI
 * is installed, else the desktop app, else the CLI in the home folder;
 * desktop / cli force one. Detection only checks that files exist.
 */
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProviderError } from '../kit';
import {
  KeyText,
  Lang,
  LaunchTarget,
  NewSessionLauncher,
  NewSessionRequest,
} from '../types';

import { kimiCodeHome } from './paths';

/** The desktop deep link that opens Kimi Work (no folder parameter). */
export const KIMI_WORK_URL = 'kimi-work://open';

export type KimiTarget = 'auto' | 'desktop' | 'cli';
export type KimiCliMode = 'new' | 'continue' | 'plan';

const CLI_FLAGS: Record<KimiCliMode, string[]> = {
  new: [],
  continue: ['--continue'],
  plan: ['--plan'],
};

export function launchOptions(data: Record<string, unknown> | undefined): {
  target: KimiTarget;
  cliMode: KimiCliMode;
} {
  const target = data?.target;
  const mode = data?.cliMode;
  return {
    target: target === 'desktop' || target === 'cli' ? target : 'auto',
    cliMode: mode === 'continue' || mode === 'plan' ? mode : 'new',
  };
}

export type KimiLauncherDeps = {
  /** Whether a file or folder exists (tests pass a stub) */
  exists?: (file: string) => boolean;
  /** Whether a path is an existing folder (tests pass a stub) */
  isDirectory?: (dir: string) => boolean;
  /** Environment for KIMI_INSTALL_DIR / KIMI_CODE_HOME / APPDATA */
  env?: NodeJS.ProcessEnv;
};

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

/** Key-face titles of the failures a press can run into. */
export const LAUNCH_ERRORS = {
  folder: keyText('Folder not found', '未找到文件夹'),
  app: keyText('Kimi app not found', '未找到 Kimi App'),
  none: keyText('Kimi not found', '未找到 Kimi'),
};

function defaultIsDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32'
    ? path.win32.join(...parts)
    : path.posix.join(...parts);
}

/**
 * Where the `kimi` program may be, best first: the installer's folder
 * ($KIMI_INSTALL_DIR/bin, default ~/.kimi-code/bin), the Kimi Code home's
 * bin folder, then npm's global folders. The legacy Python kimi-cli uses the
 * same name (usually ~/.local/bin/kimi) and is deliberately not listed.
 */
export function cliCandidates(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  const exe = platform === 'win32' ? ['kimi.exe', 'kimi.cmd'] : ['kimi'];
  const dirs: string[] = [];
  const add = (dir: string | undefined) => {
    if (dir && dir.trim() && !dirs.includes(dir)) dirs.push(dir);
  };
  const installDir = env.KIMI_INSTALL_DIR?.trim();
  add(installDir ? joinFor(platform, installDir, 'bin') : undefined);
  add(joinFor(platform, home, '.kimi-code', 'bin'));
  const codeHome = env.KIMI_CODE_HOME?.trim();
  add(codeHome ? joinFor(platform, codeHome, 'bin') : undefined);
  if (platform === 'win32') {
    add(env.APPDATA ? path.win32.join(env.APPDATA, 'npm') : undefined);
  } else {
    add('/opt/homebrew/bin');
    add('/usr/local/bin');
    add(path.posix.join(home, '.npm-global', 'bin'));
  }
  return dirs.flatMap(dir => exe.map(name => joinFor(platform, dir, name)));
}

/** Places the Kimi desktop app (or its data, written on first start) lives. */
export function desktopCandidates(
  home: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Kimi.app',
      path.posix.join(home, 'Applications', 'Kimi.app'),
      path.posix.join(home, 'Library', 'Application Support', 'kimi-desktop'),
    ];
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return [path.win32.join(appData, 'kimi-desktop')];
  }
  const config = env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
  return [path.posix.join(config, 'kimi-desktop')];
}

/**
 * The environment the program search uses: the global `kimiDir` setting
 * (Kimi Code's home) stands in for $KIMI_CODE_HOME when it is set.
 */
function searchEnv(
  request: NewSessionRequest,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const dir = request.config?.kimiDir;
  if (typeof dir !== 'string' || !dir.trim()) return env;
  return {
    ...env,
    KIMI_CODE_HOME: kimiCodeHome(request.config, env, homeOf(request)),
  };
}

/** The home folder programs are looked for in (the user's by default). */
function homeOf(request: NewSessionRequest): string {
  return request.home || os.homedir();
}

/** A launcher; the exported one checks the real file system. */
export function createKimiLauncher(
  deps: KimiLauncherDeps = {}
): NewSessionLauncher {
  const exists = deps.exists ?? existsSync;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const findCli = (request: NewSessionRequest, env: NodeJS.ProcessEnv) => {
    const home = homeOf(request);
    const program = cliCandidates(home, request.platform, env).find(file =>
      exists(file)
    );
    // the CLI's data folder without a known program: the terminal's PATH
    const homeDir =
      env.KIMI_CODE_HOME?.trim() ||
      joinFor(request.platform, home, '.kimi-code');
    if (program) return program;
    return exists(homeDir) ? 'kimi' : null;
  };
  const hasDesktop = (request: NewSessionRequest, env: NodeJS.ProcessEnv) =>
    desktopCandidates(homeOf(request), request.platform, env).some(file =>
      exists(file)
    );

  return {
    appName: 'Kimi',
    needsConfig: true,
    strings: {
      error: { en: 'Cannot open Kimi', zh: '无法打开 Kimi' },
    },

    /** Kimi Work takes no folder: name the app instead. */
    subtitle: (data, folderName) =>
      launchOptions(data).target === 'desktop' ? 'Kimi Work' : folderName,

    target(request: NewSessionRequest): LaunchTarget {
      const env = searchEnv(request, deps.env ?? process.env);
      const { target, cliMode } = launchOptions(request.data);
      const terminal = (program: string): LaunchTarget => {
        if (request.folder && !isDirectory(request.folder)) {
          // the message goes to the log: no folder path in it
          throw new ProviderError('not-configured', 'Folder not found', {
            keyText: LAUNCH_ERRORS.folder,
          });
        }
        return {
          kind: 'terminal',
          command: [program, ...CLI_FLAGS[cliMode]],
          cwd: request.folder,
        };
      };
      if (target === 'desktop') {
        if (hasDesktop(request, env))
          return { kind: 'url', url: KIMI_WORK_URL };
        throw new ProviderError('not-installed', 'Kimi app not found', {
          keyText: LAUNCH_ERRORS.app,
        });
      }
      const cli = findCli(request, env);
      // forced CLI: an undetected install (e.g. under nvm) may still be on
      // the terminal's PATH; the terminal says so when it is not
      if (target === 'cli') return terminal(cli ?? 'kimi');
      if (cli && request.folder) return terminal(cli);
      if (hasDesktop(request, env)) return { kind: 'url', url: KIMI_WORK_URL };
      if (cli) return terminal(cli);
      throw new ProviderError(
        'not-installed',
        'Neither Kimi Code nor the Kimi app found',
        { keyText: LAUNCH_ERRORS.none }
      );
    },
  };
}

export const newSessionLauncher: NewSessionLauncher = createKimiLauncher();
