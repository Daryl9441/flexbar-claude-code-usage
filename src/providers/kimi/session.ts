/**
 * Kimi session status source: Kimi Code CLI sessions and Kimi desktop
 * "Kimi Work" tasks, merged (sessionSource.ts). A key's `source` setting
 * (auto | desktop | cli) picks which of them it shows, `includeAutomations`
 * adds the desktop's scheduled tasks.
 *
 * Read-only: never writes Kimi's files; logs no titles, prompts or paths
 * beyond the data folders the key group already names.
 */
import os from 'node:os';
import path from 'node:path';

import { SessionDescription, SessionProvider } from '../types';

import { kimiCodeHome, kimiDesktopDir } from './paths';
import { tildify } from './sessionFs';
import { KimiSessionSource, keyOptions } from './sessionSource';

/** Idle threshold of the settings page's one-off check (default 15 min) */
const DEFAULT_IDLE_MS = 15 * 60_000;

function idleMsOf(data: Record<string, unknown> | undefined): number {
  const minutes = Number(data?.idleMinutes);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DEFAULT_IDLE_MS;
}

/** The folders a key with these settings reads, for the settings page. */
function describeDirs(
  source: KimiSessionSource,
  data: Record<string, unknown> | undefined
): string {
  const { source: kind } = keyOptions(data);
  const home = os.homedir();
  const dirs: string[] = [];
  if (kind !== 'desktop') dirs.push(tildify(source.cli.sessionsDir, home));
  if (kind !== 'cli') dirs.push(tildify(source.desktop.root, home));
  return dirs.join(' · ');
}

export const sessionProvider: SessionProvider = {
  // both data roots (./paths.ts): a change of either restarts the source
  location: config =>
    [kimiCodeHome(config), kimiDesktopDir(config)].join(path.delimiter),

  create: ({ config, onChange, logger }) =>
    new KimiSessionSource({
      codeHome: kimiCodeHome(config),
      desktopDir: kimiDesktopDir(config),
      onChange,
      logger,
    }),

  async describe(filter, config, data): Promise<SessionDescription> {
    const source = new KimiSessionSource({
      codeHome: kimiCodeHome(config),
      desktopDir: kimiDesktopDir(config),
      onChange: () => undefined,
    });
    try {
      source.setFilters([filter]);
      await source.rescan();
      const idleMs = idleMsOf(data);
      const { status, others } = source.getStatus(
        filter,
        Date.now(),
        idleMs,
        data
      );
      return {
        success: !!status,
        projectsDir: describeDirs(source, data),
        state: status?.state ?? null,
        project: status?.project ?? null,
        title: status?.title ?? null,
        others,
        notice: status ? null : source.notice(),
      };
    } finally {
      source.stop();
    }
  },
};
