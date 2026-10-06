/**
 * Antigravity usage key: finds the running Antigravity language servers
 * (read-only). The desktop app and the IDE each start a language server
 * (LS) that answers Connect-JSON requests on 127.0.0.1. Its command line
 * names the product (`--app_data_dir antigravity` / `antigravity-ide`) and
 * carries the CSRF token every request must send (`--csrf_token`); `lsof`
 * lists the loopback ports it listens on.
 *
 * The CSRF token is a credential: it lives in memory only (never logged,
 * stored, shown or put on a child process's command line) and is only ever
 * sent to a 127.0.0.1 port that `lsof` attributes to the process it came
 * from. Command lines of other processes are parsed in memory and dropped.
 * The agy CLI runs its language server inside its own process without a
 * visible token, so it is not found here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** The programs with a language server of their own. */
export type ServerProduct = 'app' | 'ide';

/** One running language server, as found in the process table. */
export type LanguageServer = {
  pid: number;
  product: ServerProduct;
  /** CSRF token for this server: a credential (memory only) */
  token: string;
  /** Ports this server's flags reserve for something else */
  skipPorts: number[];
};

/** Runs a program (no shell) and resolves with its standard output. */
export type RunFile = (file: string, args: string[]) => Promise<string>;

/** Data folder name (`--app_data_dir`) → product. */
const DATA_DIRS: Readonly<Record<string, ServerProduct>> = {
  antigravity: 'app',
  'antigravity-ide': 'ide',
};

/**
 * The executable at the start of a command line: an absolute path ending
 * in a language_server binary (`language_server`, `language_server_macos_arm`,
 * …). App paths may contain spaces ("Antigravity IDE.app"), so the match
 * is lazy; parseServerCommand checks where the spaces are.
 */
const EXE_RE = /^(\/.*?\/language_server(?:_[a-z0-9]+)*)(?=\s|$)/i;

/** A token as the servers print it (a UUID); anything else is not used. */
const TOKEN_RE = /^[A-Za-z0-9._~-]{8,200}$/;

/** Flags whose port is not the Connect HTTP port. */
const OTHER_PORT_FLAGS = [
  'lsp_port',
  'extension_server_port',
  'https_server_port',
];

/** The value of `--name value` or `--name=value` in an argument string. */
export function flagValue(args: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\S+)`);
  return re.exec(args)?.[1] ?? null;
}

function basename(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? value
  );
}

/**
 * The Antigravity language server a `ps` command line runs, or null. Only
 * the app's and the IDE's servers qualify: the executable sits in an
 * Antigravity bundle and the data folder is theirs.
 */
export function parseServerCommand(
  pid: number,
  command: string
): LanguageServer | null {
  const exe = EXE_RE.exec(command)?.[1];
  if (!exe || !/antigravity/i.test(exe)) return null;
  // a space may only sit inside an app bundle's name ("Antigravity IDE.app"),
  // not between a program and its arguments ("grep /…/language_server")
  if (exe.split('/').some(part => /\s/.test(part) && !/\.app$/i.test(part))) {
    return null;
  }
  const args = command.slice(exe.length);
  const dataDir = flagValue(args, 'app_data_dir');
  const product = dataDir ? DATA_DIRS[basename(dataDir)] : undefined;
  if (!product) return null;
  const token = flagValue(args, 'csrf_token');
  if (!token || !TOKEN_RE.test(token)) return null;
  const skipPorts: number[] = [];
  for (const flag of OTHER_PORT_FLAGS) {
    const port = Number(flagValue(args, flag));
    if (Number.isInteger(port) && port > 0 && port < 65536)
      skipPorts.push(port);
  }
  return { pid, product, token, skipPorts };
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
 * output, highest first (the plain-HTTP Connect port is the higher of the
 * two the servers open), without the ones in `skip`.
 */
export function parseListeningPorts(
  lsofOutput: string,
  skip: readonly number[] = []
): number[] {
  const ports = new Set<number>();
  for (const m of lsofOutput.matchAll(/^n127\.0\.0\.1:(\d+)$/gm)) {
    const port = Number(m[1]);
    if (port > 0 && port < 65536 && !skip.includes(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => b - a);
}

function firstExisting(candidates: string[]): string {
  return candidates.find(file => fs.existsSync(file)) ?? candidates[0];
}

let psPath: string | null = null;
let lsofPath: string | null = null;

/** `ps` and `lsof` at their usual places (macOS, Linux). */
export function toolPaths(): { ps: string; lsof: string } {
  psPath ??= firstExisting(['/bin/ps', '/usr/bin/ps']);
  lsofPath ??= firstExisting(['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof']);
  return { ps: psPath, lsof: lsofPath };
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
