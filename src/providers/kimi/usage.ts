/**
 * Kimi usage meter source.
 *
 * OWNER: the kimi-usage implementer (worktree feat/mp-kimi-usage). Edit this
 * file and add helpers as src/providers/kimi/usage*.ts (e.g. usageApi.ts);
 * do not edit index.ts, brand.ts, ../types.ts, ../kit.ts or anything
 * outside src/providers/kimi/, ui/kimi_usage.vue and
 * scripts/test-kimi-usage.mjs.
 *
 * Contract (see ../types.ts UsageSource and architecture.md):
 * - fetch(config) returns every limit as { id, label, percent, resetsAt };
 *   ids are stored in the key's `metric` setting, labels go on the chip.
 * - Throw ProviderError (../kit.ts) with a fitting code: 'not-installed',
 *   'not-configured', 'no-credentials', 'unauthorized', 'rate-limited'
 *   (with retryAfterSeconds), 'http' ("HTTP 500" in the message), 'network',
 *   'parse'. The key shows a short text for the code (override errorText for
 *   custom texts); the message goes to the log and the settings UI.
 * - Never log, throw or return credentials; route error text through
 *   safeErrorMessage (src/redact.ts); never JSON.parse credential data
 *   bare. Tests stub the network: no real requests from a test.
 */
import { ProviderError } from '../kit';
import { PluginConfig, UsageMetric, UsageSource } from '../types';

export const usageSource: UsageSource = {
  // TODO(kimi-usage): the metric id a key shows by default ('' = first one)
  defaultMetric: '',

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(config: PluginConfig): Promise<UsageMetric[]> {
    // TODO(kimi-usage): find the Kimi login on this computer, request the
    // usage, and map every limit to a UsageMetric.
    throw new ProviderError(
      'not-configured',
      'Kimi usage is not available yet'
    );
  },
};
