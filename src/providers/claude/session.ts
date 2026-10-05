/**
 * Claude Code sessions: transcripts in `<claudeDir>/projects` and the live
 * registry in `<claudeDir>/sessions`, followed by SessionMonitor.
 */
import path from 'node:path';

import { SessionMonitor, resolveClaudeDir } from '../../sessionSource';
import { SessionDescription, SessionProvider } from '../types';

/** Idle threshold of the settings page's one-off check */
const DESCRIBE_IDLE_MS = 15 * 60_000;

export const claudeSessionProvider: SessionProvider = {
  location: config => resolveClaudeDir(config?.claudeDir),

  create: ({ location, onChange, logger }) =>
    new SessionMonitor({ claudeDir: location, onChange, logger }),

  // the transcripts folder, as SessionMonitor.projectsDir names it
  watched: location => path.join(location, 'projects'),

  async describe(filter, config): Promise<SessionDescription> {
    const monitor = new SessionMonitor({
      claudeDir: resolveClaudeDir(config?.claudeDir),
      onChange: () => undefined,
    });
    monitor.setFilters([filter]);
    await monitor.rescan();
    monitor.stop();
    const { status, others } = monitor.getStatus(
      filter,
      Date.now(),
      DESCRIBE_IDLE_MS
    );
    return {
      success: !!status,
      projectsDir: monitor.projectsDir,
      state: status?.state ?? null,
      project: status?.project ?? null,
      title: status?.title ?? null,
      others,
    };
  },
};
