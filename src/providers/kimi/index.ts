/**
 * The Kimi provider: wires the modules by their fixed export names.
 * Owned by the architect: implementers never need to edit this file.
 */
import { ProviderDef } from '../types';

import { KIMI_BRAND } from './brand';
import { newSessionLauncher } from './newSession';
import { sessionProvider } from './session';
import { usageSource } from './usage';

export const KIMI: ProviderDef = {
  id: 'kimi',
  brand: KIMI_BRAND,
  usage: usageSource,
  session: sessionProvider,
  newSession: newSessionLauncher,
};
