/**
 * Gemini session status source: Gemini CLI session files under
 * `<geminiHome>/tmp/<project>/chats/` (./sessionMonitor.ts, read-only), the
 * status derived from them (./sessionParse.ts), and the running CLIs from
 * the process table (./sessionProcs.ts) for "is it still running" and "is a
 * tool running". Gemini CLI records a reply only when it ends and a tool
 * call only once it finished, so an approval wait is a guess ("Approval?").
 *
 * Key settings (key.data): projectFilter, idleMinutes, showProject,
 * showMark, lang, liveDetection (default on: ps + lsof every 10 s while the
 * key is shown; off: from the files alone).
 *
 * OWNER: the gemini-session implementer, who also owns ./newSession.ts.
 */
import path from 'node:path';

import {
  KeyData,
  PluginConfig,
  SessionDescription,
  SessionProvider,
} from '../types';

import { geminiHome, geminiPathSetting } from './paths';
import { findGeminiCli } from './sessionCli';
import { GeminiSessionMonitor } from './sessionMonitor';
import { ProcessProbe, createProcessProbe } from './sessionProcs';

/** Idle threshold of the settings page's one-off check by default */
const DESCRIBE_IDLE_MS = 15 * 60_000;

export type GeminiSessionDeps = {
  /** Running CLIs (default: ps + lsof on this computer) */
  probe?: () => ProcessProbe | null;
  /** Whether the Gemini CLI is installed (default: search for it) */
  cliInstalled?: (config: PluginConfig) => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
};

function idleMsOf(data: KeyData | undefined): number {
  const minutes = Number(data?.idleMinutes);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DESCRIBE_IDLE_MS;
}

/** A Gemini session provider; the dependencies exist for tests. */
export function createGeminiSessionProvider(
  deps: GeminiSessionDeps = {}
): SessionProvider {
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? (() => createProcessProbe({ platform }));
  const cliInstalled =
    deps.cliInstalled ??
    ((config: PluginConfig) =>
      findGeminiCli({
        setting: geminiPathSetting(config, deps.home),
        home: deps.home,
        platform,
        env: deps.env,
      }) !== null);
  const homeOf = (config: PluginConfig | null | undefined) =>
    geminiHome(config, deps.env ?? process.env, deps.home);

  return {
    // the Gemini CLI home (./paths.ts); a change restarts the source
    location: config => homeOf(config),

    create: ({ location, config, onChange, logger }) =>
      new GeminiSessionMonitor({
        home: location,
        onChange,
        logger,
        probe: probe(),
        cliInstalled: () => cliInstalled(config ?? {}),
        platform,
      }),

    async describe(filter, config, data): Promise<SessionDescription> {
      const monitor = new GeminiSessionMonitor({
        home: homeOf(config),
        onChange: () => undefined,
        probe: data?.liveDetection === false ? null : probe(),
        cliInstalled: () => cliInstalled(config ?? {}),
        platform,
        watch: false,
      });
      monitor.setFilters([filter]);
      await monitor.rescan();
      monitor.stop();
      const { status, others } = monitor.getStatus(
        filter,
        Date.now(),
        idleMsOf(data),
        data
      );
      return {
        success: !!status,
        projectsDir: path.join(homeOf(config), 'tmp'),
        state: status?.state ?? null,
        project: status?.project ?? null,
        title: status?.title ?? null,
        others,
        notice: status ? null : monitor.notice(),
      };
    },
  };
}

export const sessionProvider: SessionProvider = createGeminiSessionProvider();
