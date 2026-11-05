/**
 * Where the Cursor app lives, and the URL that focuses it. The state
 * database path is the one Grok Bot already uses (`cursorStateDb`), so the
 * usage and session keys read the same file. Nothing here touches the filesystem.
 */
import os from 'node:os';
import path from 'node:path';

import { cursorStateDb } from '../grokbot/paths';
import { resolveDir } from '../kit';
import { PluginConfig } from '../types';

export { cursorStateDb };

/**
 * Activates the app's URL handler and carries no prompt. Cursor's documented
 * deeplinks (`cursor://anysphere.cursor-deeplink/prompt|command|rule`) all
 * pre-fill content. None of them opens an empty chat, so this key does not
 * use them.
 */
export const CURSOR_OPEN_URL = 'cursor://';

/** Electron user-data directory. `cursorStateDb` lives under User/globalStorage. */
export function cursorUserDataDir(
  _config: PluginConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const appData = env.APPDATA?.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const fallback =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Cursor')
      : platform === 'win32'
        ? path.join(appData || path.join(home, 'AppData', 'Roaming'), 'Cursor')
        : path.join(xdg || path.join(home, '.config'), 'Cursor');
  return resolveDir(undefined, undefined, fallback, home);
}

/** Places a normal install of the app can live. Existence is checked by the caller. */
export function cursorAppCandidates(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Cursor.app',
      path.join(home, 'Applications', 'Cursor.app'),
    ];
  }
  if (platform === 'win32') {
    const local =
      env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return [
      path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
      path.join(local, 'Programs', 'Cursor', 'Cursor.exe'),
    ];
  }
  return [
    '/usr/bin/cursor',
    '/usr/local/bin/cursor',
    path.join(home, '.local', 'bin', 'cursor'),
  ];
}
