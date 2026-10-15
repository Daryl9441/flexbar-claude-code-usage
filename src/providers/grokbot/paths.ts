/**
 * Where Grok Bot keeps its local data, and where the Cursor app keeps the
 * session the usage key reads. Shared so the usage, session and new-session
 * keys agree. Nothing here touches the filesystem.
 *
 * Grok Bot is the desktop app (bundle id com.anysphere.sand), not Groq and
 * not the Grok Build CLI under ~/.grok.
 */
import os from 'node:os';
import path from 'node:path';

import { resolveDir } from '../kit';
import { PluginConfig } from '../types';

export const GROKBOT_BUNDLE = 'com.anysphere.sand';
/** Documented activation route. It focuses the app and takes no prompt. */
export const GROKBOT_OPEN_URL = 'grokbot://app/v1/open';

export const PERSISTENCE_DIR = 'sand-client-persistence';
export const SESSION_MARKER = 'sand-session-marker.json';
export const DAEMON_FILE = 'local-exec-daemon.json';

/**
 * The app's Electron userData directory: the session marker and the
 * sand-client-persistence mirror. `grokbotDir` overrides it.
 */
export function grokbotUserDataDir(
  config: PluginConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const appData = env.APPDATA?.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const fallback =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Grok Bot')
      : platform === 'win32'
        ? path.join(
            appData || path.join(home, 'AppData', 'Roaming'),
            'Grok Bot'
          )
        : path.join(xdg || path.join(home, '.config'), 'Grok Bot');
  return resolveDir(config?.grokbotDir, undefined, fallback, home);
}

/**
 * The app's data root ($SAND_DATA_ROOT, else ~/.grokbot): host plumbing and
 * local-exec-daemon.json. Not the chat store.
 */
export function grokbotDataRoot(
  config: PluginConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  return resolveDir(
    config?.grokbotDataRoot,
    env.SAND_DATA_ROOT,
    path.join(home, '.grokbot'),
    home
  );
}

/** Cursor's state database, where cursorAuth/accessToken is stored. */
export function cursorStateDb(
  config: PluginConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const appData = env.APPDATA?.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const fallback =
    platform === 'darwin'
      ? path.join(
          home,
          'Library',
          'Application Support',
          'Cursor',
          'User',
          'globalStorage',
          'state.vscdb'
        )
      : platform === 'win32'
        ? path.join(
            appData || path.join(home, 'AppData', 'Roaming'),
            'Cursor',
            'User',
            'globalStorage',
            'state.vscdb'
          )
        : path.join(
            xdg || path.join(home, '.config'),
            'Cursor',
            'User',
            'globalStorage',
            'state.vscdb'
          );
  return resolveDir(config?.cursorStateDb, undefined, fallback, home);
}

/** Places a normal install of the app can live. Existence is checked by the caller. */
export function grokbotAppCandidates(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Grok Bot.app',
      path.join(home, 'Applications', 'Grok Bot.app'),
    ];
  }
  if (platform === 'win32') {
    const local =
      env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    const programs = env.ProgramFiles?.trim() || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', 'Grok Bot', 'Grok Bot.exe'),
      path.join(local, 'Grok Bot', 'Grok Bot.exe'),
      path.join(programs, 'Grok Bot', 'Grok Bot.exe'),
    ];
  }
  return [];
}
