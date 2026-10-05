/**
 * Gemini New Session key: what a press opens.
 *
 * OWNER: the gemini-session implementer (see ./session.ts for the file rules).
 *
 * Contract (see ../types.ts NewSessionLauncher and architecture.md): return
 * a LaunchTarget built from the key's settings, e.g.
 *   { kind: 'url', url: 'gemini://…' }                       (app deep link)
 *   { kind: 'terminal', command: ['gemini'], cwd: request.folder }  (CLI)
 *   { kind: 'command', file: '/abs/path', args: […] }
 * The key group opens it through execFile (never a shell) and tests stub the
 * opener. Data folders: geminiHome() / geminiPathSetting() in ./paths.ts. Throw
 * ProviderError('not-installed', …) when Gemini is missing.
 */
import { ProviderError } from '../kit';
import { LaunchTarget, NewSessionLauncher, NewSessionRequest } from '../types';

export const newSessionLauncher: NewSessionLauncher = {
  appName: 'Gemini',
  // TODO(gemini-session): key-face texts, e.g. error: { en: 'Gemini not found', zh: '未找到 Gemini' }
  strings: {},

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  target(request: NewSessionRequest): LaunchTarget {
    // TODO(gemini-session): open a new Gemini session in request.folder
    throw new ProviderError(
      'not-configured',
      'Gemini new session is not available yet'
    );
  },
};
