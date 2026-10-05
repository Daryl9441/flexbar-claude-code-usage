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
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ProviderError } from '../kit';
import { LaunchTarget, NewSessionLauncher, NewSessionRequest } from '../types';

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
  /** Environment for KIMI_INSTALL_DIR / KIMI_CODE_HOME / APPDATA */
  env?: NodeJS.ProcessEnv;
};

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
  if (typeof dir !== 'string' || !dir.trim() || !request.home) return env;
  return {
    ...env,
    KIMI_CODE_HOME: kimiCodeHome(request.config, env, request.home),
  };
}

/** A launcher; the exported one checks the real file system. */
export function createKimiLauncher(
  deps: KimiLauncherDeps = {}
): NewSessionLauncher {
  const exists = deps.exists ?? existsSync;
  const findCli = (request: NewSessionRequest, env: NodeJS.ProcessEnv) => {
    const home = request.home ?? '';
    const program = home
      ? cliCandidates(home, request.platform, env).find(file => exists(file))
      : undefined;
    // the CLI's data folder without a known program: the terminal's PATH
    const homeDir =
      env.KIMI_CODE_HOME?.trim() ||
      (home ? joinFor(request.platform, home, '.kimi-code') : '');
    if (program) return program;
    return homeDir && exists(homeDir) ? 'kimi' : null;
  };
  const hasDesktop = (request: NewSessionRequest, env: NodeJS.ProcessEnv) =>
    !!request.home &&
    desktopCandidates(request.home, request.platform, env).some(file =>
      exists(file)
    );

  return {
    appName: 'Kimi',
    strings: {
      error: { en: 'Kimi not found', zh: '未找到 Kimi' },
    },

    target(request: NewSessionRequest): LaunchTarget {
      const env = searchEnv(request, deps.env ?? process.env);
      const { target, cliMode } = launchOptions(request.data);
      const terminal = (program: string): LaunchTarget => ({
        kind: 'terminal',
        command: [program, ...CLI_FLAGS[cliMode]],
        cwd: request.folder,
      });
      if (target === 'desktop') {
        if (hasDesktop(request, env))
          return { kind: 'url', url: KIMI_WORK_URL };
        throw new ProviderError('not-installed', 'Kimi app not found');
      }
      const cli = findCli(request, env);
      // forced CLI: an undetected install may still be on the shell's PATH
      if (target === 'cli') return terminal(cli ?? 'kimi');
      if (cli && request.folder) return terminal(cli);
      if (hasDesktop(request, env)) return { kind: 'url', url: KIMI_WORK_URL };
      if (cli) return terminal(cli);
      throw new ProviderError(
        'not-installed',
        'Neither Kimi Code nor the Kimi app found'
      );
    },
  };
}

export const newSessionLauncher: NewSessionLauncher = createKimiLauncher();
