/**
 * Antigravity session status source.
 *
 * OWNER: the antigravity-session implementer (worktree feat/ag-session),
 * who also owns ./newSession.ts. Add helpers as
 * src/providers/antigravity/session*.ts or newSession*.ts; do not edit
 * index.ts, brand.ts, paths.ts, ../types.ts, ../kit.ts or anything outside
 * those files, ui/antigravity_session.vue, ui/antigravity_newsession.vue and
 * scripts/test-antigravity-session.mjs. Manifest strings go to the
 * integrator as a manifestPatch (see architecture.md).
 *
 * Contract (see ../types.ts SessionProvider/SessionSource and
 * architecture.md):
 * - location(config): what sessions are read from (antigravityRoot() in
 *   ./paths.ts, which holds the app, CLI and IDE data folders); keys restart
 *   the source when it changes.
 * - create(): a SessionSource that watches/polls read-only, calls onChange()
 *   after every refresh (at least once after start()), and answers
 *   getStatus() with a SessionStatus (build it with makeStatus() from
 *   ../kit.ts) and listRunning() with runningItem() entries.
 * - notice(): unavailableNotice('not-installed' | 'not-configured', brand)
 *   while there is nothing to read, else null.
 * - describe(): one-off scan for the settings page.
 * Never write to Antigravity's files or state; never log titles, prompts,
 * conversation ids, CSRF tokens or paths beyond what the existing Claude
 * code logs.
 */
import { staticSessionSource, unavailableNotice } from '../kit';
import { PluginConfig, SessionDescription, SessionProvider } from '../types';

import { ANTIGRAVITY_BRAND } from './brand';
import { antigravityRoot, installedProducts } from './paths';

/** Not installed until one of the data folders exists, else not set up. */
function stubNotice(config: PluginConfig) {
  return unavailableNotice(
    installedProducts(config).length ? 'not-configured' : 'not-installed',
    ANTIGRAVITY_BRAND
  );
}

export const sessionProvider: SessionProvider = {
  // the folder holding the Antigravity data folders (./paths.ts); a change
  // restarts the source
  location: config => antigravityRoot(config),

  // TODO(antigravity-session): return a real SessionSource
  create: options => staticSessionSource(options, stubNotice(options.config)),

  async describe(filter, config): Promise<SessionDescription> {
    // TODO(antigravity-session): scan once and report what a key with this
    // filter shows
    return {
      success: false,
      projectsDir: antigravityRoot(config),
      state: null,
      project: null,
      title: null,
      others: 0,
      notice: stubNotice(config),
    };
  },
};
