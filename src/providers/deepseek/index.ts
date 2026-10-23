/**
 * The DeepSeek provider: wires the modules by their fixed export names.
 */
import { ProviderDef } from '../types';

import { DEEPSEEK_BRAND } from './brand';
import { newSessionLauncher } from './newSession';
import { sessionProvider } from './session';
import { usageSource } from './usage';

export const DEEPSEEK: ProviderDef = {
  id: 'deepseek',
  brand: DEEPSEEK_BRAND,
  usage: usageSource,
  session: sessionProvider,
  newSession: newSessionLauncher,
};
