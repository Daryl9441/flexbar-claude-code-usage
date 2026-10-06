/**
 * Antigravity usage meter source.
 *
 * OWNER: the antigravity-usage implementer (worktree feat/ag-usage). Edit
 * this file and add helpers as src/providers/antigravity/usage*.ts (e.g.
 * usageRpc.ts); do not edit index.ts, brand.ts, paths.ts, ../types.ts,
 * ../kit.ts or anything outside src/providers/antigravity/usage*.ts,
 * ui/antigravity_usage.vue and scripts/test-antigravity-usage.mjs. Manifest
 * strings go to the integrator as a manifestPatch (see architecture.md).
 *
 * Contract (see ../types.ts UsageSource and architecture.md):
 * - fetch(config) returns every limit as { id, label, percent, resetsAt };
 *   ids are stored in the key's `metric` setting, labels go on the chip.
 *   Antigravity has a desktop app, an IDE and the agy CLI (./paths.ts);
 *   read whichever reports the account's quota.
 * - Throw ProviderError (../kit.ts) with a fitting code: 'not-installed',
 *   'not-configured', 'no-credentials', 'unauthorized', 'rate-limited'
 *   (with retryAfterSeconds), 'http' ("HTTP 500" in the message), 'network',
 *   'parse'. The key shows a short text for the code (override errorText for
 *   custom texts); the message goes to the log and the settings UI.
 * - Never log, throw or return credentials, CSRF tokens or OAuth secrets;
 *   route error text through safeErrorMessage (src/redact.ts); never
 *   JSON.parse credential data bare. Tests stub the network, local RPC and
 *   process lookups: no real requests from a test.
 */
import { ProviderError } from '../kit';
import { PluginConfig, UsageMetric, UsageSource } from '../types';

import { installedProducts } from './paths';

export const usageSource: UsageSource = {
  // TODO(antigravity-usage): the metric id a key shows by default ('' = first one)
  defaultMetric: '',

  async fetch(config: PluginConfig): Promise<UsageMetric[]> {
    // TODO(antigravity-usage): find the Antigravity login on this computer,
    // request the usage, and map every limit to a UsageMetric.
    if (installedProducts(config).length === 0) {
      throw new ProviderError(
        'not-installed',
        'No Antigravity data folder found'
      );
    }
    throw new ProviderError(
      'not-configured',
      'Antigravity usage is not available yet'
    );
  },
};
