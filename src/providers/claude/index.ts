/**
 * The Claude provider: the original three keys, with their original cids.
 */
import { ProviderDef } from '../types';

import { CLAUDE_BRAND } from './brand';
import { claudeNewSessionLauncher } from './newSession';
import { claudeSessionProvider } from './session';
import { claudeUsageSource } from './usage';

export const CLAUDE: ProviderDef = {
  id: 'claude',
  brand: CLAUDE_BRAND,
  usage: claudeUsageSource,
  session: claudeSessionProvider,
  newSession: claudeNewSessionLauncher,
};
