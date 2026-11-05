/**
 * Cursor's third key. A press opens the app with `cursor://`, which
 * activates the registered handler and carries no prompt.
 *
 * Cursor's documented deeplinks pre-fill a prompt, a command or a rule.
 * None of them starts an empty agent chat, and this key does not invent
 * one: it does not claim a new session was created.
 */
import fs from 'node:fs';
import os from 'node:os';

import { ProviderError } from '../kit';
import {
  KeyText,
  Lang,
  LaunchTarget,
  NewSessionLauncher,
  NewSessionRequest,
  PluginConfig,
} from '../types';

import {
  CURSOR_OPEN_URL,
  cursorAppCandidates,
  cursorStateDb,
  cursorUserDataDir,
} from './paths';

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

export const LAUNCH_ERRORS = {
  missing: keyText('Cursor not found', '未找到 Cursor'),
};

export type CursorLauncherDeps = {
  exists?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
};

function configOf(request: NewSessionRequest): PluginConfig {
  const config = request.config;
  return config && typeof config === 'object' ? config : {};
}

export function createCursorLauncher(
  deps: CursorLauncherDeps = {}
): NewSessionLauncher {
  const exists = deps.exists ?? fs.existsSync;
  const env = deps.env ?? process.env;
  return {
    appName: 'Cursor',
    needsConfig: true,
    strings: {
      ready: { en: 'Open Cursor', zh: '打开 Cursor' },
      opening: { en: 'Opening…', zh: '正在打开…' },
      error: { en: 'Cursor not found', zh: '未找到 Cursor' },
    },
    subtitle: (_data, _folder, lang) =>
      lang === 'zh' ? '打开应用' : 'Opens the app',
    target(request: NewSessionRequest): LaunchTarget {
      const home = request.home ?? os.homedir();
      const config = configOf(request);
      const places = [
        ...cursorAppCandidates(home, request.platform, env),
        cursorUserDataDir(config, env, home, request.platform),
        cursorStateDb(config, env, home, request.platform),
      ];
      const found = places.some(place => {
        try {
          return exists(place);
        } catch {
          return false;
        }
      });
      if (!found) {
        throw new ProviderError('not-installed', 'Cursor not found', {
          keyText: LAUNCH_ERRORS.missing,
        });
      }
      return { kind: 'url', url: CURSOR_OPEN_URL };
    },
  };
}

export const newSessionLauncher: NewSessionLauncher = createCursorLauncher();
