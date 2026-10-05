/**
 * Kimi session status source.
 *
 * OWNER: the kimi-session implementer (worktree feat/mp-kimi-session), who
 * also owns ./newSession.ts. Add helpers as src/providers/kimi/session*.ts;
 * do not edit index.ts, brand.ts, ../types.ts, ../kit.ts or anything
 * outside src/providers/kimi/, ui/kimi_session.vue, ui/kimi_newsession.vue
 * and scripts/test-kimi-session.mjs.
 *
 * Contract (see ../types.ts SessionProvider/SessionSource and
 * architecture.md):
 * - location(config): the folder sessions are read from (config.kimiDir
 *   overrides the default); keys restart the source when it changes.
 * - create(): a SessionSource that watches/polls read-only, calls onChange()
 *   after every refresh (at least once after start()), and answers
 *   getStatus() with a SessionStatus (build it with makeStatus() from
 *   ../kit.ts) and listRunning() with runningItem() entries.
 * - notice(): unavailableNotice('not-installed' | 'not-configured', brand)
 *   while there is nothing to read, else null.
 * - describe(): one-off scan for the settings page.
 * Never write to Kimi's files; never log titles, prompts or paths beyond
 * what the existing Claude code logs.
 */
import { staticSessionSource, unavailableNotice } from '../kit';
import { SessionDescription, SessionProvider } from '../types';

import { KIMI_BRAND } from './brand';

export const sessionProvider: SessionProvider = {
  // TODO(kimi-session): resolve the Kimi data folder (config.kimiDir first)
  location: () => '',

  // TODO(kimi-session): return a real SessionSource
  create: options =>
    staticSessionSource(
      options,
      unavailableNotice('not-configured', KIMI_BRAND)
    ),

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async describe(filter, config): Promise<SessionDescription> {
    // TODO(kimi-session): scan once and report what a key with this filter shows
    return {
      success: false,
      projectsDir: null,
      state: null,
      project: null,
      title: null,
      others: 0,
      notice: unavailableNotice('not-configured', KIMI_BRAND),
    };
  },
};
