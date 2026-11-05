/**
 * The Cursor provider: wires the modules by their fixed export names.
 */
import { ProviderDef } from '../types';

import { CURSOR_BRAND } from './brand';
import { newSessionLauncher } from './newSession';
import { sessionProvider } from './session';
import { usageSource } from './usage';

export const CURSOR: ProviderDef = {
  id: 'cursor',
  brand: CURSOR_BRAND,
  usage: usageSource,
  session: sessionProvider,
  newSession: newSessionLauncher,
};
