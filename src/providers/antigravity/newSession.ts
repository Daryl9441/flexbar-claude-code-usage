/**
 * Antigravity New Session key: what a press opens.
 *
 * OWNER: the antigravity-session implementer (see ./session.ts for the file
 * rules).
 *
 * Contract (see ../types.ts NewSessionLauncher and architecture.md): return
 * a LaunchTarget built from the key's settings, e.g.
 *   { kind: 'terminal', command: [agy], cwd: request.folder }   (agy CLI)
 *   { kind: 'command', file: '/usr/bin/open', args: [...] }      (desktop app)
 *   { kind: 'url', url: '…' }                                    (a deep link)
 * The key group opens it through execFile (never a shell) and tests stub the
 * opener. Folders and the CLI setting: ./paths.ts. Throw
 * ProviderError('not-installed', …) when Antigravity is missing (a custom
 * title goes in extra.keyText).
 */
import { ProviderError } from '../kit';
import { LaunchTarget, NewSessionLauncher, NewSessionRequest } from '../types';

export const newSessionLauncher: NewSessionLauncher = {
  appName: 'Antigravity',
  // TODO(antigravity-session): key-face texts, e.g.
  // error: { en: 'Antigravity not found', zh: '未找到 Antigravity' }
  strings: {},

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  target(request: NewSessionRequest): LaunchTarget {
    // TODO(antigravity-session): open a new Antigravity session (agy in
    // request.folder, or the desktop app)
    throw new ProviderError(
      'not-configured',
      'Antigravity new session is not available yet'
    );
  },
};
