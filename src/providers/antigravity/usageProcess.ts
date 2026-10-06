/**
 * Antigravity usage key: finds the running Antigravity language servers
 * (read-only) with `ps` and `lsof`. The command-line and port parsing is
 * shared with the session key (./languageServer.ts), which also describes
 * how the CSRF token is handled: memory only, sent only in a header to a
 * 127.0.0.1 port `lsof` attributes to the process it came from.
 */
import { execFile } from 'node:child_process';

import {
  ServerCommand,
  ServerProduct,
  flagValue,
  loopbackPorts,
  parseServerCommand as parseCommand,
  toolPaths,
} from './languageServer';

export { flagValue, toolPaths };
export type { ServerProduct };

/** One running language server, as found in the process table. */
export type LanguageServer = ServerCommand & { pid: number };

/** Runs a program (no shell) and resolves with its standard output. */
export type RunFile = (file: string, args: string[]) => Promise<string>;

/**
 * The Antigravity language server a `ps` command line runs, or null. Only
 * the app's and the IDE's servers qualify (./languageServer.ts).
 */
export function parseServerCommand(
  pid: number,
  command: string
): LanguageServer | null {
  const server = parseCommand(command);
  return server ? { pid, ...server } : null;
}

/**
 * The Antigravity language servers in `ps -axww -o pid=,uid=,command=` output
 * that run as `uid` (any uid when null): the app's first, then the IDE's,
 * newest (highest pid) first within each.
 */
export function parseServers(
  psOutput: string,
  uid: number | null
): LanguageServer[] {
  const servers: LanguageServer[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    if (uid !== null && Number(m[2]) !== uid) continue;
    const server = parseServerCommand(Number(m[1]), m[3]);
    if (server) servers.push(server);
  }
  const rank = (s: LanguageServer) => (s.product === 'app' ? 0 : 1);
  return servers.sort((a, b) => rank(a) - rank(b) || b.pid - a.pid);
}

/**
 * The 127.0.0.1 ports in `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn`
 * output, highest first, without the ones in `skip`.
 */
export function parseListeningPorts(
  lsofOutput: string,
  skip: readonly number[] = []
): number[] {
  const names = [...lsofOutput.matchAll(/^n(.*)$/gm)].map(m => m[1]);
  return loopbackPorts(names, skip);
}

/** execFile without a shell, with a timeout and an output cap. */
export const runFile: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        // lsof exits 1 when it finds nothing; what it printed still counts
        if (error && !stdout) reject(error);
        else resolve(stdout ?? '');
      }
    );
  });

/** The current user's id, or null where there is none (Windows). */
export function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Lists the Antigravity language servers running as this user. */
export async function findServers(
  run: RunFile,
  uid: number | null,
  ps: string = toolPaths().ps
): Promise<LanguageServer[]> {
  // ww: full command lines (the token may come after a long path)
  const out = await run(ps, ['-axww', '-o', 'pid=,uid=,command=']);
  return parseServers(out, uid);
}

/** The loopback ports a server listens on now ([] when it is gone). */
export async function serverPorts(
  run: RunFile,
  server: Pick<LanguageServer, 'pid' | 'skipPorts'>,
  lsof: string = toolPaths().lsof
): Promise<number[]> {
  try {
    const out = await run(lsof, [
      '-nP',
      '-a',
      '-p',
      String(server.pid),
      '-iTCP',
      '-sTCP:LISTEN',
      '-Fn',
    ]);
    return parseListeningPorts(out, server.skipPorts);
  } catch {
    return [];
  }
}
