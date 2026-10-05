/**
 * Gemini New Session key: a press opens a terminal window running the Gemini
 * CLI in the key's folder (the kind of session the Gemini Session key
 * follows), or, as the secondary target, a new chat in the Gemini app
 * (`googlegemini://newchat`, no folder).
 *
 * The terminal is opened by the key group (src/launch.ts): on macOS a
 * self-deleting `.command` script in the temp folder, run by Terminal, in
 * which every word is single-quoted; this file only builds the command.
 * Arguments come from fixed presets (resume, approval mode), never from
 * free text.
 *
 * Key settings (key.data): folder ('' = home folder), target
 * ('terminal-cli' | 'gemini-app'), resume (adds `--resume latest`),
 * approvalMode ('default' | 'auto_edit' | 'yolo' | 'plan'), lang.
 *
 * OWNER: the gemini-session implementer (see ./session.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProviderError } from '../kit';
import {
  KeyText,
  LaunchTarget,
  Lang,
  NewSessionLauncher,
  NewSessionRequest,
  PluginConfig,
} from '../types';

import { geminiPathSetting } from './paths';
import { findGeminiCli } from './sessionCli';

export const GEMINI_APP_URL = 'googlegemini://newchat';

export type GeminiTarget = 'terminal-cli' | 'gemini-app';

const APPROVAL_MODES = new Set(['default', 'auto_edit', 'yolo', 'plan']);

/** The CLI arguments for the key's presets (no free text gets through). */
export function cliArgs(
  data: Record<string, unknown> | null | undefined
): string[] {
  const args: string[] = [];
  if (data?.resume === true) args.push('--resume', 'latest');
  const mode = data?.approvalMode;
  if (
    typeof mode === 'string' &&
    mode !== 'default' &&
    APPROVAL_MODES.has(mode)
  ) {
    args.push('--approval-mode', mode);
  }
  return args;
}

export function targetOf(
  data: Record<string, unknown> | null | undefined
): GeminiTarget {
  return data?.target === 'gemini-app' ? 'gemini-app' : 'terminal-cli';
}

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

/** Key-face texts of the failures (once the key group shows them per error). */
export const LAUNCH_ERRORS = {
  folder: keyText('Folder not found', '未找到文件夹'),
  cli: keyText('Gemini CLI not found', '未找到 Gemini CLI'),
  app: keyText('Gemini app not found', '未找到 Gemini App'),
};

export type GeminiLauncherDeps = {
  /** Whether a path is an existing folder */
  isDirectory?: (dir: string) => boolean;
  /** The Gemini CLI program, or null when not installed */
  findCli?: (request: NewSessionRequest, config: PluginConfig) => string | null;
  /** Whether the Gemini app is installed (macOS) */
  appInstalled?: (home: string) => boolean;
};

function defaultIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function defaultAppInstalled(home: string): boolean {
  return [
    '/Applications/Gemini.app',
    path.join(home, 'Applications', 'Gemini.app'),
  ].some(defaultIsDirectory);
}

/** The global settings, once the key group passes them with the request. */
function configOf(request: NewSessionRequest): PluginConfig {
  const config = (request as { config?: unknown }).config;
  return config && typeof config === 'object' ? (config as PluginConfig) : {};
}

/** A Gemini launcher; the dependencies exist for tests. */
export function createGeminiLauncher(
  deps: GeminiLauncherDeps = {}
): NewSessionLauncher {
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const appInstalled = deps.appInstalled ?? defaultAppInstalled;
  const findCli =
    deps.findCli ??
    ((request: NewSessionRequest, config: PluginConfig) =>
      findGeminiCli({
        setting: geminiPathSetting(config, request.home ?? os.homedir()),
        home: request.home ?? os.homedir(),
        platform: request.platform,
      }));

  return {
    appName: 'Gemini CLI',
    strings: {
      error: { en: 'Cannot open Gemini', zh: '无法打开 Gemini' },
    },

    target(request: NewSessionRequest): LaunchTarget {
      const home = request.home ?? os.homedir();
      if (targetOf(request.data) === 'gemini-app') {
        if (request.platform !== 'darwin' || !appInstalled(home)) {
          throw new ProviderError('not-installed', 'Gemini app not found', {
            keyText: LAUNCH_ERRORS.app,
          });
        }
        return { kind: 'url', url: GEMINI_APP_URL };
      }
      const folder = request.folder;
      if (folder && !isDirectory(folder)) {
        // the message goes to the log: no folder path in it
        throw new ProviderError('not-configured', 'Folder not found', {
          keyText: LAUNCH_ERRORS.folder,
        });
      }
      const cli = findCli(request, configOf(request));
      if (!cli) {
        throw new ProviderError('not-installed', 'Gemini CLI not found', {
          keyText: LAUNCH_ERRORS.cli,
        });
      }
      return {
        kind: 'terminal',
        command: [cli, ...cliArgs(request.data)],
        cwd: folder ?? home,
      };
    },
  };
}

export const newSessionLauncher: NewSessionLauncher = createGeminiLauncher();
