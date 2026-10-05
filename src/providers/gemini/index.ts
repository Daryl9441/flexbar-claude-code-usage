/**
 * The Gemini provider: wires the modules by their fixed export names.
 * Owned by the architect: implementers never need to edit this file.
 */
import { ProviderDef } from '../types';

import { GEMINI_BRAND } from './brand';
import { newSessionLauncher } from './newSession';
import { sessionProvider } from './session';
import { usageSource } from './usage';

export const GEMINI: ProviderDef = {
  id: 'gemini',
  brand: GEMINI_BRAND,
  usage: usageSource,
  session: sessionProvider,
  newSession: newSessionLauncher,
};
