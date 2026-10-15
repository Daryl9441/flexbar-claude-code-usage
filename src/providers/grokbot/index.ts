/**
 * The Grok Bot provider: wires the modules by their fixed export names.
 */
import { ProviderDef } from '../types';

import { GROKBOT_BRAND } from './brand';
import { newSessionLauncher } from './newSession';
import { sessionProvider } from './session';
import { usageSource } from './usage';

export const GROKBOT: ProviderDef = {
  id: 'grokbot',
  brand: GROKBOT_BRAND,
  usage: usageSource,
  session: sessionProvider,
  newSession: newSessionLauncher,
};
