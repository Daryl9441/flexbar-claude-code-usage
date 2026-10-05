/**
 * Opens a URL with the operating system's default handler. The URL is passed
 * to the opener as a single argument via execFile, never through a shell, so
 * nothing in it (spaces, quotes, `&`, CJK folder names) can be interpreted as
 * shell syntax.
 */
import { execFile } from 'node:child_process';

/** Hands a URL to the OS; resolves once it was accepted, rejects otherwise. */
export type Launcher = (url: string) => Promise<void>;

export type OpenCommand = { file: string; args: string[] };

/** The subset of child_process.execFile the launcher uses. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { windowsHide: boolean },
  callback: (error: Error | null, stdout: unknown, stderr: unknown) => void
) => unknown;

export type LauncherOptions = {
  platform?: NodeJS.Platform;
  execFile?: ExecFileLike;
  /**
   * An opener still running after this long has handed the URL over (some
   * xdg-open setups only exit with the app), so it counts as success.
   */
  settleMs?: number;
};

const DEFAULT_SETTLE_MS = 5_000;

/** The opener command for a platform. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): OpenCommand {
  switch (platform) {
    case 'darwin':
      return { file: '/usr/bin/open', args: [url] };
    case 'win32':
      return { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    default:
      return { file: 'xdg-open', args: [url] };
  }
}

/** A failed launch; the message never contains the URL's query (paths). */
export class OpenUrlError extends Error {
  constructor(
    message: string,
    readonly code: string | number | null
  ) {
    super(message);
    this.name = 'OpenUrlError';
  }
}

function describeFailure(
  file: string,
  url: string,
  error: Error,
  stderr: unknown
): OpenUrlError {
  const raw = (error as { code?: unknown }).code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? raw : null;
  const scheme = url.split('?')[0];
  const detail = `${stderr ?? ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
    // the opener echoes the URL; keep the scheme and path, drop the query
    ?.split(url)
    .join(scheme)
    .slice(0, 200);
  const status =
    code === 'ENOENT'
      ? `${file} not found`
      : `${file} failed${code === null ? '' : ` (${code})`}`;
  return new OpenUrlError(detail ? `${status}: ${detail}` : status, code);
}

/** Creates a launcher; options exist so tests never start a real process. */
export function createLauncher(options: LauncherOptions = {}): Launcher {
  const platform = options.platform ?? process.platform;
  const run: ExecFileLike = options.execFile ?? execFile;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  return url =>
    new Promise<void>((resolve, reject) => {
      const { file, args } = openCommand(url, platform);
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve();
      }, settleMs);
      timer.unref?.();
      const done = (error: Error | null, stderr?: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (error) reject(describeFailure(file, url, error, stderr));
        else resolve();
      };
      try {
        run(file, args, { windowsHide: true }, (error, _stdout, stderr) =>
          done(error, stderr)
        );
      } catch (error) {
        done(error instanceof Error ? error : new Error(`${error}`));
      }
    });
}

/** Opens a URL with the default handler of this computer. */
export const openUrl: Launcher = createLauncher();
