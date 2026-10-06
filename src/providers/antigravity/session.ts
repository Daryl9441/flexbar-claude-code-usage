/**
 * Antigravity session status source: the conversations of the desktop app,
 * the IDE and the agy CLI (./sessionMonitor.ts). The app and the IDE each
 * run a local language server that reports every conversation's live
 * status over a loopback RPC (./sessionRpc.ts, found with ps + lsof by
 * ./sessionProcs.ts); their `conversation_summaries.db` (./sessionDb.ts)
 * stands in while it does not run. agy has no reachable server: its
 * summary database plus the running agy processes tell its state.
 * Everything is read-only.
 *
 * Key settings (key.data): source ('auto' | 'app' | 'ide' | 'cli'; auto
 * merges all three), projectFilter, idleMinutes, showProject, showMark,
 * showProgress (task.md checklist of the conversation; default on), lang.
 *
 * OWNER: the antigravity-session implementer, who also owns ./newSession.ts.
 */
import os from 'node:os';

import { safeErrorMessage } from '../../redact';
import {
  KeyData,
  PluginConfig,
  SessionDescription,
  SessionProvider,
} from '../types';

import {
  AntigravityProduct,
  antigravityPathSetting,
  antigravityRoot,
  installedProducts,
} from './paths';
import { bundleInstalled, findAgy } from './sessionCli';
import { DbReader, createDbReader } from './sessionDb';
import { AntigravitySessionMonitor } from './sessionMonitor';
import { ProcessProbe, createProcessProbe } from './sessionProcs';
import { PostFn, createPost } from './sessionRpc';

/** Idle threshold of the settings page's one-off check by default */
const DESCRIBE_IDLE_MS = 15 * 60_000;

export type AntigravitySessionDeps = {
  /** Running processes (default: ps + lsof on this computer) */
  probe?: () => ProcessProbe | null;
  /** Loopback RPC transport (default: node:http to 127.0.0.1) */
  post?: PostFn | null;
  /** Summary database reader (default: node:sqlite, when available) */
  readDb?: () => DbReader | null;
  /** Installed programs (default: data folders, app bundles, agy) */
  installed?: (config: PluginConfig) => ReadonlySet<AntigravityProduct>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
};

function idleMsOf(data: KeyData | undefined): number {
  const minutes = Number(data?.idleMinutes);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DESCRIBE_IDLE_MS;
}

/** The programs of Antigravity this computer has. */
export function detectInstalled(
  config: PluginConfig,
  options: {
    home?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {}
): Set<AntigravityProduct> {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const found = new Set(installedProducts(config, home));
  if (platform === 'darwin') {
    if (bundleInstalled('app', home)) found.add('app');
    if (bundleInstalled('ide', home)) found.add('ide');
  }
  if (
    !found.has('cli') &&
    findAgy({
      setting: antigravityPathSetting(config, home),
      home,
      platform,
      env: options.env,
    })
  ) {
    found.add('cli');
  }
  return found;
}

/** An Antigravity session provider; the dependencies exist for tests. */
export function createAntigravitySessionProvider(
  deps: AntigravitySessionDeps = {}
): SessionProvider {
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? (() => createProcessProbe({ platform }));
  const post = deps.post === undefined ? createPost() : deps.post;
  const readDb = deps.readDb ?? (() => createDbReader());
  const installed =
    deps.installed ??
    ((config: PluginConfig) =>
      detectInstalled(config, { home: deps.home, platform, env: deps.env }));
  const rootOf = (config: PluginConfig | null | undefined) =>
    antigravityRoot(config, deps.home ?? os.homedir());

  const monitor = (
    config: PluginConfig,
    location: string,
    onChange: () => void,
    logger?: Parameters<SessionProvider['create']>[0]['logger']
  ) =>
    new AntigravitySessionMonitor({
      root: location,
      onChange,
      logger,
      probe: probe(),
      post,
      readDb: readDb(),
      installed: () => installed(config ?? {}),
      platform,
      now: deps.now,
    });

  return {
    // the folder holding the app, IDE and CLI data folders (./paths.ts); a
    // change restarts the source
    location: config => rootOf(config),

    watched: location => `${location} (Antigravity app, IDE and CLI)`,

    create: ({ location, config, onChange, logger }) =>
      monitor(config ?? {}, location, onChange, logger),

    async describe(filter, config, data): Promise<SessionDescription> {
      const root = rootOf(config);
      const source = monitor(config ?? {}, root, () => undefined);
      try {
        await source.rescan();
        const now = (deps.now ?? Date.now)();
        const { status, others } = source.getStatus(
          filter,
          now,
          idleMsOf(data),
          data
        );
        return {
          success: !!status,
          projectsDir: root,
          state: status?.state ?? null,
          project: status?.project ?? null,
          title: status?.title ?? null,
          others,
          notice: status ? null : source.notice(data),
        };
      } catch (error) {
        return {
          success: false,
          projectsDir: root,
          state: null,
          project: null,
          title: null,
          others: 0,
          notice: {
            label: { en: 'Error', zh: '出错' },
            text: {
              en: safeErrorMessage(error).slice(0, 80),
              zh: '无法读取会话',
            },
            tone: 'error',
          },
        };
      } finally {
        source.stop();
      }
    },
  };
}

export const sessionProvider: SessionProvider =
  createAntigravitySessionProvider();
