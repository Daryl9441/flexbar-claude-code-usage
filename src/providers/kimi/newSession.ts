/**
 * Kimi New Session key: what a press opens.
 *
 * OWNER: the kimi-session implementer (see ./session.ts for the file rules).
 *
 * Contract (see ../types.ts NewSessionLauncher and architecture.md): return
 * a LaunchTarget built from the key's settings, e.g.
 *   { kind: 'url', url: 'kimi://…' }                       (app deep link)
 *   { kind: 'terminal', command: ['kimi'], cwd: request.folder }  (CLI)
 *   { kind: 'command', file: '/abs/path', args: […] }
 * The key group opens it through execFile (never a shell) and tests stub the
 * opener. Data folders: kimiCodeHome() / kimiDesktopDir() in ./paths.ts. Throw
 * ProviderError('not-installed', …) when Kimi is missing.
 */
import { ProviderError } from '../kit';
import { LaunchTarget, NewSessionLauncher, NewSessionRequest } from '../types';

export const newSessionLauncher: NewSessionLauncher = {
  appName: 'Kimi',
  // TODO(kimi-session): key-face texts, e.g. error: { en: 'Kimi not found', zh: '未找到 Kimi' }
  strings: {},

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  target(request: NewSessionRequest): LaunchTarget {
    // TODO(kimi-session): open a new Kimi session in request.folder
    throw new ProviderError(
      'not-configured',
      'Kimi new session is not available yet'
    );
  },
};
