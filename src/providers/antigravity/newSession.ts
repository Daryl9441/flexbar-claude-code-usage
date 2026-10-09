/**
 * Antigravity New Session always opens a new empty conversation in the
 * standalone desktop app. The shared macOS launcher activates the exact
 * bundle, presses the App's New Conversation accessibility link, and
 * verifies the empty compose screen before reporting success.
 *
 * Legacy auto / terminal-cli / ide keys keep their cid and become app keys.
 * Their old folder and CLI presets are ignored: no CLI or IDE fallback,
 * resume, prompt submission, project creation, or account-data access.
 *
 * Official App navigation: https://antigravity.google/docs/getting-started/
 */
import os from 'node:os';

import { ProviderError } from '../kit';
import {
  KeyText,
  Lang,
  LaunchTarget,
  NewSessionLauncher,
  NewSessionRequest,
} from '../types';

import { BUNDLE_IDS, bundleInstalled } from './sessionCli';

export type AntigravityTarget = 'app';

/** Old and unknown target settings migrate to the desktop app. */
export function targetOf(
  data: Record<string, unknown> | null | undefined
): AntigravityTarget {
  return data?.target === 'app' ? data.target : 'app';
}

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

export const LAUNCH_ERRORS = {
  app: keyText('App not found', '未找到 App'),
  macOnly: keyText('macOS only', '仅限 macOS'),
};

const MAC_ONLY: Readonly<Record<Lang, string>> = {
  en: 'macOS only',
  zh: '仅限 macOS',
};

export type AntigravityLauncherDeps = {
  /** Whether the standalone desktop app is installed (macOS) */
  appInstalled?: (product: 'app', home: string) => boolean;
  /** This computer, for the subtitles (presses carry their own) */
  platform?: NodeJS.Platform;
};

/** Dependencies exist so tests never launch an app or inspect account data. */
export function createAntigravityLauncher(
  deps: AntigravityLauncherDeps = {}
): NewSessionLauncher {
  const localPlatform = deps.platform ?? process.platform;
  const appInstalled = deps.appInstalled ?? bundleInstalled;

  return {
    appName: 'Antigravity',
    strings: {
      error: {
        en: 'Cannot create Antigravity session',
        zh: '无法新建 Antigravity 会话',
      },
    },

    subtitle: (_data, _folderName, lang) =>
      localPlatform === 'darwin' ? 'Antigravity App' : MAC_ONLY[lang],

    target(request: NewSessionRequest): LaunchTarget {
      if (request.platform !== 'darwin') {
        throw new ProviderError(
          'unsupported',
          'New Antigravity app conversations are supported on macOS only',
          { keyText: LAUNCH_ERRORS.macOnly }
        );
      }
      if (!appInstalled('app', request.home ?? os.homedir())) {
        throw new ProviderError('not-installed', 'Antigravity app not found', {
          keyText: LAUNCH_ERRORS.app,
        });
      }
      return {
        kind: 'mac-app-new-session',
        bundleId: BUNDLE_IDS.app,
      };
    },
  };
}

export const newSessionLauncher: NewSessionLauncher =
  createAntigravityLauncher();
