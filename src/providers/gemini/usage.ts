/**
 * Gemini usage meter source.
 *
 * OWNER: the gemini-usage implementer (worktree feat/mp-gemini-usage). Edit this
 * file and add helpers as src/providers/gemini/usage*.ts (e.g. usageApi.ts);
 * do not edit index.ts, brand.ts, ../types.ts, ../kit.ts or anything
 * outside src/providers/gemini/, ui/gemini_usage.vue and
 * scripts/test-gemini-usage.mjs.
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
  // TODO(gemini-usage): the metric id a key shows by default ('' = first one)
  defaultMetric: '',

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(config: PluginConfig): Promise<UsageMetric[]> {
    // TODO(gemini-usage): find the Gemini login on this computer, request the
    // usage, and map every limit to a UsageMetric.
    throw new ProviderError(
      'not-configured',
      'Gemini usage is not available yet'
    );
  },
};
