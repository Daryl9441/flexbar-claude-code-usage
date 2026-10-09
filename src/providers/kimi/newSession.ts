/**
 * Kimi New Session opens Kimi Code App's new-session view on macOS.
 * The shared native launcher activates the exact bundle, presses File >
 * New Session, and verifies the focused empty composer before success.
 *
 * Older target / cliMode / folder settings are ignored. Project selection
 * stays in the App. No app-argument, `kimi` CLI or ordinary Kimi app fallback;
 * an unsent draft is preserved and reported instead of submitted or erased.
 */
import { existsSync } from 'node:fs';
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

/** The Kimi Code desktop app, distinct from the ordinary Kimi app. */
export const KIMI_CODE_BUNDLE_ID = 'com.kimi.code.desktop';

export type KimiLauncherDeps = {
  /** Whether an app bundle exists (tests pass a stub) */
  exists?: (file: string) => boolean;
};

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

/** Key-face titles of the failures a press can run into. */
export const LAUNCH_ERRORS = {
  app: keyText('Kimi Code App missing', '未找到 Kimi Code App'),
  macOnly: keyText('macOS only', '仅限 macOS'),
};

/** App bundles only: CLI installs and old app data are not evidence. */
export function desktopCandidates(home: string): string[] {
  return [
    '/Applications/Kimi Code.app',
    path.join(home, 'Applications', 'Kimi Code.app'),
  ];
}

/** A launcher; the exported one checks the real file system. */
export function createKimiLauncher(
  deps: KimiLauncherDeps = {}
): NewSessionLauncher {
  const exists = deps.exists ?? existsSync;

  return {
    appName: 'Kimi Code App',
    strings: {
      error: { en: 'Cannot open Kimi Code App', zh: '无法打开 Kimi Code App' },
    },

    subtitle: () => 'Kimi Code App',

    target(request: NewSessionRequest): LaunchTarget {
      if (request.platform !== 'darwin') {
        throw new ProviderError(
          'unsupported',
          'Kimi Code App new sessions are supported on macOS only',
          { keyText: LAUNCH_ERRORS.macOnly }
        );
      }
      const home = request.home ?? os.homedir();
      if (!desktopCandidates(home).some(file => exists(file))) {
        throw new ProviderError('not-installed', 'Kimi Code App not found', {
          keyText: LAUNCH_ERRORS.app,
        });
      }
      return {
        kind: 'mac-app-new-session',
        bundleId: KIMI_CODE_BUNDLE_ID,
      };
    },
  };
}

export const newSessionLauncher: NewSessionLauncher = createKimiLauncher();
