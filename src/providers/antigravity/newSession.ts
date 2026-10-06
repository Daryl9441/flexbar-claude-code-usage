/**
 * Antigravity New Session key: what a press opens, by the key's `target`:
 *
 * - 'terminal-cli': a terminal window running `agy` in the key's folder (a
 *   new CLI conversation; the kind the Session key follows), with fixed
 *   presets only: resume (`--continue`), mode (`--mode accept-edits` /
 *   `--mode plan` / `--dangerously-skip-permissions`), sandbox (`--sandbox`);
 * - 'app': the desktop app (`open -b com.google.antigravity`: launches it,
 *   or shows and focuses its window). Antigravity has no link or command
 *   for "new conversation", so the key only brings the app up; ⌘N there
 *   starts one;
 * - 'ide': the IDE with the key's folder (`open -b
 *   com.google.antigravity-ide <folder>`);
 * - 'auto' (default): agy when it is installed, else the app, else the IDE.
 *
 * The app and the IDE are opened on macOS only; elsewhere those targets say
 * so (and 'auto' needs agy). An 'auto' key's subtitle names what a press
 * opens, looked up with the global settings (agy's path) the key group
 * hands over on load and on change.
 *
 * Everything goes through execFile (src/launch.ts), never a shell, and no
 * folder ends up in a URL. The terminal is opened by the key group (on
 * macOS a self-deleting `.command` script in which every word is quoted).
 *
 * Key settings (key.data): target, folder ('' = home folder), resume, mode
 * ('default' | 'accept-edits' | 'plan' | 'skip-permissions'), sandbox, lang.
 *
 * OWNER: the antigravity-session implementer (see ./session.ts).
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

import { antigravityPathSetting } from './paths';
import { BUNDLE_IDS, bundleInstalled, findAgy } from './sessionCli';

export type AntigravityTarget = 'auto' | 'terminal-cli' | 'app' | 'ide';

const TARGETS = new Set<AntigravityTarget>([
  'auto',
  'terminal-cli',
  'app',
  'ide',
]);

const MODE_ARGS: Readonly<Record<string, string[]>> = {
  'accept-edits': ['--mode', 'accept-edits'],
  plan: ['--mode', 'plan'],
  'skip-permissions': ['--dangerously-skip-permissions'],
};

/** The agy arguments for the key's presets (no free text gets through). */
export function agyArgs(
  data: Record<string, unknown> | null | undefined
): string[] {
  const args: string[] = [];
  if (data?.resume === true) args.push('--continue');
  const mode = typeof data?.mode === 'string' ? data.mode : '';
  if (Object.prototype.hasOwnProperty.call(MODE_ARGS, mode)) {
    args.push(...MODE_ARGS[mode]);
  }
  if (data?.sandbox === true) args.push('--sandbox');
  return args;
}

export function targetOf(
  data: Record<string, unknown> | null | undefined
): AntigravityTarget {
  const value = data?.target;
  return typeof value === 'string' && TARGETS.has(value as AntigravityTarget)
    ? (value as AntigravityTarget)
    : 'auto';
}

function keyText(en: string, zh: string): Record<Lang, KeyText> {
  return { en: { title: en, message: '' }, zh: { title: zh, message: '' } };
}

/** Key-face titles of the failures. */
export const LAUNCH_ERRORS = {
  folder: keyText('Folder not found', '未找到文件夹'),
  cli: keyText('agy not found', '未找到 agy'),
  // short: the face's badge already shows the Antigravity mark
  app: keyText('App not found', '未找到 App'),
  ide: keyText('IDE not found', '未找到 IDE'),
  none: keyText('Antigravity not found', '未找到 Antigravity'),
  macOnly: keyText('macOS only', '仅限 macOS'),
};

/** Subtitle of an app or IDE key off macOS (a press says the same). */
const MAC_ONLY: Readonly<Record<Lang, string>> = {
  en: 'macOS only',
  zh: '仅限 macOS',
};

export type AntigravityLauncherDeps = {
  /** Whether a path is an existing folder */
  isDirectory?: (dir: string) => boolean;
  /** The agy program, or null when not installed */
  findCli?: (request: NewSessionRequest, config: PluginConfig) => string | null;
  /** Whether the desktop app / IDE is installed (macOS) */
  appInstalled?: (product: 'app' | 'ide', home: string) => boolean;
  /** This computer, for the subtitles (presses carry their own) */
  platform?: NodeJS.Platform;
  home?: () => string;
};

function defaultIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The global settings the key group passes with the request. */
function configOf(request: NewSessionRequest): PluginConfig {
  const config = request.config;
  return config && typeof config === 'object' ? config : {};
}

const OPEN = '/usr/bin/open';
/** How long the subtitle's look for agy and the apps is reused */
const AUTO_GUESS_MS = 60_000;

/** An Antigravity launcher; the dependencies exist for tests. */
export function createAntigravityLauncher(
  deps: AntigravityLauncherDeps = {}
): NewSessionLauncher {
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const localPlatform = deps.platform ?? process.platform;
  const localHome = deps.home ?? (() => os.homedir());
  const appInstalled =
    deps.appInstalled ??
    ((product: 'app' | 'ide', home: string) => bundleInstalled(product, home));
  const findCli =
    deps.findCli ??
    ((request: NewSessionRequest, config: PluginConfig) => {
      const home = request.home ?? os.homedir();
      return findAgy({
        setting: antigravityPathSetting(config, home),
        home,
        platform: request.platform,
      });
    });

  const checkFolder = (folder: string | null) => {
    if (folder && !isDirectory(folder)) {
      // the message goes to the log: no folder path in it
      throw new ProviderError('not-configured', 'Folder not found', {
        keyText: LAUNCH_ERRORS.folder,
      });
    }
  };

  const terminal = (request: NewSessionRequest, cli: string): LaunchTarget => ({
    kind: 'terminal',
    command: [cli, ...agyArgs(request.data)],
    cwd: request.folder ?? request.home ?? os.homedir(),
  });

  const macOnly = (product: 'app' | 'ide') =>
    new ProviderError(
      'unsupported',
      `The Antigravity ${product === 'app' ? 'app' : 'IDE'} is opened on macOS only`,
      { keyText: LAUNCH_ERRORS.macOnly }
    );

  const app = (): LaunchTarget => ({
    kind: 'command',
    file: OPEN,
    args: ['-b', BUNDLE_IDS.app],
  });

  const ide = (request: NewSessionRequest): LaunchTarget => ({
    kind: 'command',
    file: OPEN,
    args: ['-b', BUNDLE_IDS.ide, ...(request.folder ? [request.folder] : [])],
  });

  /** The global settings: handed over by the key group, or the last press's */
  let settings: PluginConfig = {};
  /** What 'auto' opened at the last press (with the global settings) */
  let autoChoice: Exclude<AntigravityTarget, 'auto'> | null = null;
  /** What 'auto' would open, looked up with `settings` (cached) */
  let autoGuess: {
    at: number;
    value: Exclude<AntigravityTarget, 'auto'> | null;
  } | null = null;

  /** What a press of an 'auto' key opens, for its subtitle. */
  const autoTarget = (): Exclude<AntigravityTarget, 'auto'> | null => {
    if (autoChoice) return autoChoice;
    const now = Date.now();
    if (autoGuess && now - autoGuess.at < AUTO_GUESS_MS) return autoGuess.value;
    let value: Exclude<AntigravityTarget, 'auto'> | null = null;
    try {
      const home = localHome();
      const platform = localPlatform;
      const probe: NewSessionRequest = {
        data: {},
        rawFolder: '',
        folder: null,
        home,
        platform,
        config: settings,
      };
      if (findCli(probe, settings)) value = 'terminal-cli';
      else if (platform === 'darwin' && appInstalled('app', home))
        value = 'app';
      else if (platform === 'darwin' && appInstalled('ide', home))
        value = 'ide';
    } catch {
      value = null;
    }
    autoGuess = { at: now, value };
    return value;
  };

  const subtitleOf = (
    target: AntigravityTarget,
    folderName: string | null,
    lang: Lang
  ): string | null => {
    switch (target) {
      case 'app':
        return localPlatform === 'darwin' ? 'App · ⌘N' : MAC_ONLY[lang];
      case 'ide':
        return localPlatform === 'darwin'
          ? (folderName ?? 'IDE')
          : MAC_ONLY[lang];
      case 'terminal-cli':
        return folderName;
      default: {
        const resolved = autoTarget();
        return resolved ? subtitleOf(resolved, folderName, lang) : folderName;
      }
    }
  };

  return {
    appName: 'Antigravity',
    needsConfig: true,
    strings: {
      error: { en: 'Cannot open Antigravity', zh: '无法打开 Antigravity' },
    },

    /**
     * The app takes no folder (and opens no conversation by itself): say
     * where to press ⌘N instead of the folder. An 'auto' key names what a
     * press opens.
     */
    subtitle: (data, folderName, lang) =>
      subtitleOf(targetOf(data), folderName, lang),

    /** The global settings, on load and on change: the subtitle uses them. */
    configure(config: PluginConfig) {
      settings = config && typeof config === 'object' ? config : {};
      autoChoice = null;
      autoGuess = null;
    },

    target(request: NewSessionRequest): LaunchTarget {
      const home = request.home ?? os.homedir();
      const mac = request.platform === 'darwin';
      const target = targetOf(request.data);
      const config = configOf(request);
      // a press without settings (they took too long) keeps the known ones
      if (Object.keys(config).length > 0 && config !== settings) {
        settings = config;
        autoGuess = null;
      }
      switch (target) {
        case 'app':
          if (!mac) throw macOnly('app');
          if (!appInstalled('app', home)) {
            throw new ProviderError(
              'not-installed',
              'Antigravity app not found',
              {
                keyText: LAUNCH_ERRORS.app,
              }
            );
          }
          return app();
        case 'ide':
          if (!mac) throw macOnly('ide');
          if (!appInstalled('ide', home)) {
            throw new ProviderError(
              'not-installed',
              'Antigravity IDE not found',
              {
                keyText: LAUNCH_ERRORS.ide,
              }
            );
          }
          checkFolder(request.folder);
          return ide(request);
        case 'terminal-cli': {
          checkFolder(request.folder);
          const cli = findCli(request, config);
          if (!cli) {
            throw new ProviderError('not-installed', 'agy not found', {
              keyText: LAUNCH_ERRORS.cli,
            });
          }
          return terminal(request, cli);
        }
        default: {
          // auto: the CLI opens a real new conversation in the folder; the
          // app and the IDE only come up
          autoChoice = null;
          const cli = findCli(request, config);
          if (cli) {
            autoChoice = 'terminal-cli';
            checkFolder(request.folder);
            return terminal(request, cli);
          }
          if (mac && appInstalled('app', home)) {
            autoChoice = 'app';
            return app();
          }
          if (mac && appInstalled('ide', home)) {
            autoChoice = 'ide';
            checkFolder(request.folder);
            return ide(request);
          }
          // off macOS only agy can be opened: name what is missing
          throw mac
            ? new ProviderError('not-installed', 'Antigravity not found', {
                keyText: LAUNCH_ERRORS.none,
              })
            : new ProviderError('not-installed', 'agy not found', {
                keyText: LAUNCH_ERRORS.cli,
              });
        }
      }
    },
  };
}

export const newSessionLauncher: NewSessionLauncher =
  createAntigravityLauncher();
