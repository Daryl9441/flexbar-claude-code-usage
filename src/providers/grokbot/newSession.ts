/**
 * Grok Bot's third key. A press opens the app with the documented
 * activation link `grokbot://app/v1/open`, which focuses the main window
 * and accepts no prompt.
 *
 * There is no deep link that starts a blank chat. The in-app New chat
 * control can be a no-op when that view is already open, and it keeps an
 * unsent draft, so this key does not press it and does not claim a new
 * session was created.
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
  GROKBOT_OPEN_URL,
  grokbotAppCandidates,
  grokbotDataRoot,
  grokbotUserDataDir,
} from './paths';

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

export const LAUNCH_ERRORS = {
  missing: keyText('Grok Bot not found', '未找到 Grok Bot'),
};

export type GrokbotLauncherDeps = {
  exists?: (file: string) => boolean;
};

function configOf(request: NewSessionRequest): PluginConfig {
  const config = request.config;
  return config && typeof config === 'object' ? config : {};
}

export function createGrokbotLauncher(
  deps: GrokbotLauncherDeps = {}
): NewSessionLauncher {
  const exists = deps.exists ?? fs.existsSync;
  return {
    appName: 'Grok Bot',
    needsConfig: true,
    strings: {
      ready: { en: 'Open Grok Bot', zh: '打开 Grok Bot' },
      opening: { en: 'Opening…', zh: '正在打开…' },
      error: { en: 'Grok Bot not found', zh: '未找到 Grok Bot' },
    },
    subtitle: (_data, _folder, lang) =>
      lang === 'zh' ? '打开应用' : 'Opens the app',
    target(request: NewSessionRequest): LaunchTarget {
      const home = request.home ?? os.homedir();
      const config = configOf(request);
      const places = [
        ...grokbotAppCandidates(home, request.platform),
        grokbotUserDataDir(config, process.env, home, request.platform),
        grokbotDataRoot(config, process.env, home),
      ];
      const found = places.some(place => {
        try {
          return exists(place);
        } catch {
          return false;
        }
      });
      if (!found) {
        throw new ProviderError('not-installed', 'Grok Bot not found', {
          keyText: LAUNCH_ERRORS.missing,
        });
      }
      return { kind: 'url', url: GROKBOT_OPEN_URL };
    },
  };
}

export const newSessionLauncher: NewSessionLauncher = createGrokbotLauncher();
