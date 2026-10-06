/**
 * Running Antigravity processes (read-only), from one `ps` per probe:
 *
 * - language servers of the desktop app (`…/Antigravity.app/…/bin/
 *   language_server --app_data_dir antigravity`) and the IDE
 *   (`language_server_macos_arm … --app_data_dir antigravity-ide`): their
 *   loopback ports (`lsof`, looked up once per process) and the CSRF token
 *   from their `--csrf_token` argument, which the session RPC needs;
 * - interactive `agy` CLIs (subcommands and the background updater left
 *   out), with their working folder (`lsof -d cwd`, once per process).
 *
 * The command-line and port parsing is shared with the usage key
 * (./languageServer.ts). The CSRF token is a credential (it controls the
 * agent): it lives only in
 * a CsrfToken object that never prints it, is sent only in a request header
 * to 127.0.0.1 ports of the same process (./sessionRpc.ts), and never on a
 * command line. Command lines can hold prompts (`agy -p "…"`): they are
 * parsed in memory for a few flags only, never stored, logged or shown.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { inspect } from 'node:util';

import {
  flagValue,
  loopbackPorts,
  parseLsofNames,
  parseServerCommand,
  toolPaths,
} from './languageServer';
import type { AntigravityProduct } from './paths';

export { flagValue, loopbackPorts, parseLsofNames };

/** A language server's CSRF token: readable only through reveal(). */
export class CsrfToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The token, for the request header only. */
  reveal(): string {
    return this.#value;
  }

  same(other: CsrfToken | null | undefined): boolean {
    return !!other && other.reveal() === this.#value;
  }

  toString(): string {
    return '[csrf token]';
  }

  toJSON(): string {
    return '[csrf token]';
  }

  [inspect.custom](): string {
    return '[csrf token]';
  }
}

/** A running language server of the desktop app or the IDE. */
export type LanguageServer = {
  pid: number;
  /** Start time, ms (1 s resolution) */
  startedAt: number;
  product: Exclude<AntigravityProduct, 'cli'>;
  token: CsrfToken;
  /** Its TCP listeners on 127.0.0.1, highest first (null: not looked up) */
  ports: number[] | null;
};

/** A running interactive agy CLI. */
export type AgyProcess = {
  pid: number;
  startedAt: number;
  /** Working folder = the workspace, or null when unknown */
  cwd: string | null;
};

export type ProcessSnapshot = {
  servers: LanguageServer[];
  clis: AgyProcess[];
};

export type PsRow = {
  pid: number;
  uid: number | null;
  startedAt: number;
  /** Only while parsing; dropped before anything is kept */
  command: string;
};

/** `ps` elapsed time `[[dd-]hh:]mm:ss` in seconds, or null. */
export function parseEtime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3_600 +
    Number(min) * 60 +
    Number(s)
  );
}

/** Rows of `ps -o pid=,uid=,etime=,command=`. */
export function parsePs(stdout: string, now: number): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const etime = parseEtime(m[3]);
    if (etime === null) continue;
    rows.push({
      pid: Number(m[1]),
      uid: Number(m[2]),
      startedAt: now - etime * 1000,
      command: m[4],
    });
  }
  return rows;
}

/** A language server process of the app or the IDE, without its ports. */
export function inspectServer(command: string): {
  product: LanguageServer['product'];
  token: CsrfToken;
  /** Ports its flags reserve for something else (LSP, extension server) */
  exclude: number[];
} | null {
  const server = parseServerCommand(command);
  return server
    ? {
        product: server.product,
        token: new CsrfToken(server.token),
        exclude: server.skipPorts,
      }
    : null;
}

/** agy subcommands that are not a conversation */
const SUBCOMMANDS = new Set([
  'agent',
  'agents',
  'changelog',
  'completion',
  'help',
  'install',
  'login',
  'logout',
  'mcp',
  'mic-serve',
  'models',
  'plugin',
  'plugins',
  'remote-control',
  'uninstall',
  'update',
  'version',
]);

const AGY_RE = /^agy(?:\.exe)?$/i;

/**
 * Whether a command line is an interactive (or headless `-p`) agy session.
 * Words are split on spaces, as `ps` prints them.
 */
export function isAgySession(command: string): boolean {
  const words = command.split(/\s+/).filter(Boolean);
  const exe = words[0]?.split(/[\\/]/).pop() ?? '';
  if (!AGY_RE.test(exe)) return false;
  if (words[1] && !words[1].startsWith('-') && SUBCOMMANDS.has(words[1])) {
    return false;
  }
  return !words.some(
    w =>
      w === '--bg-updater' ||
      w === '--background' ||
      w === '--help' ||
      w === '-h' ||
      w === '--version'
  );
}

/** Runs a program without a shell; resolves with its output, even on failure. */
export type ExecRunner = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; ok: boolean }>;

const EXEC_TIMEOUT_MS = 5_000;

export const defaultRunner: ExecRunner = (file, args) =>
  new Promise(resolve => {
    try {
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) =>
          resolve({
            stdout: typeof stdout === 'string' ? stdout : '',
            ok: !error,
          })
      );
    } catch {
      resolve({ stdout: '', ok: false });
    }
  });

export type ProbeOptions = {
  platform?: NodeJS.Platform;
  run?: ExecRunner;
  /** This process's uid: only processes of the same user count */
  uid?: number | null;
  /** Linux: the cwd of a pid (default: readlink /proc/<pid>/cwd) */
  readCwd?: (pid: number) => Promise<string | null>;
  now?: () => number;
};

export interface ProcessProbe {
  /** The running servers and CLIs, or null when they cannot be listed. */
  snapshot(): Promise<ProcessSnapshot | null>;
  /** Looks up a server's ports again at the next snapshot (a request failed). */
  forgetPorts(pid: number): void;
}

type Cached<T> = { startedAt: number; value: T };

/**
 * A probe for this computer: macOS (ps + lsof) and Linux (ps + lsof +
 * /proc). Windows has no cheap way: no probe (sessions then come from the
 * summary databases alone). Ports and folders are cached per process (a
 * reused pid has another start time).
 */
export function createProcessProbe(
  options: ProbeOptions = {}
): ProcessProbe | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const uid =
    options.uid !== undefined
      ? options.uid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : null;
  const readCwd =
    options.readCwd ??
    (async (pid: number) => {
      try {
        return await fsp.readlink(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    });
  const lsofPath = toolPaths(platform).lsof;
  const portCache = new Map<number, Cached<number[]>>();
  const cwdCache = new Map<number, Cached<string>>();
  const fresh = <T>(cache: Map<number, Cached<T>>, pid: number, at: number) => {
    const entry = cache.get(pid);
    return entry && Math.abs(entry.startedAt - at) < 5_000 ? entry : null;
  };

  return {
    forgetPorts(pid) {
      portCache.delete(pid);
    },

    async snapshot() {
      const psPath = toolPaths(platform).ps;
      const ps =
        platform === 'darwin'
          ? await run(psPath, ['-axww', '-o', 'pid=,uid=,etime=,command='])
          : await run(psPath, ['-e', '-ww', '-o', 'pid=,uid=,etime=,args=']);
      if (!ps.ok && !ps.stdout) return null;
      const servers: (LanguageServer & { exclude: number[] })[] = [];
      const clis: AgyProcess[] = [];
      for (const row of parsePs(ps.stdout, now())) {
        if (uid !== null && row.uid !== null && row.uid !== uid) continue;
        const server = inspectServer(row.command);
        if (server) {
          servers.push({
            pid: row.pid,
            startedAt: row.startedAt,
            ...server,
            ports: null,
          });
        } else if (isAgySession(row.command)) {
          clis.push({ pid: row.pid, startedAt: row.startedAt, cwd: null });
        }
      }

      // ports of servers not seen before (one lsof per server)
      for (const server of servers) {
        const known = fresh(portCache, server.pid, server.startedAt);
        if (known) {
          server.ports = known.value;
          continue;
        }
        const lsof = await run(lsofPath, [
          '-nP',
          '-a',
          '-p',
          `${server.pid}`,
          '-iTCP',
          '-sTCP:LISTEN',
          '-Fpn',
        ]);
        const names = parseLsofNames(lsof.stdout).get(server.pid) ?? [];
        const ports = loopbackPorts(names, server.exclude);
        server.ports = ports;
        if (ports.length > 0) {
          portCache.set(server.pid, {
            startedAt: server.startedAt,
            value: ports,
          });
        }
      }

      // folders of CLIs not seen before (one lsof for all of them)
      const missing = clis.filter(c => !fresh(cwdCache, c.pid, c.startedAt));
      if (missing.length > 0) {
        if (platform === 'darwin') {
          const lsof = await run(lsofPath, [
            '-a',
            '-d',
            'cwd',
            '-Fpn',
            '-p',
            missing.map(c => c.pid).join(','),
          ]);
          // lsof exits with 1 when one of the pids is gone; use what it found
          const found = parseLsofNames(lsof.stdout);
          for (const c of missing) {
            const cwd = found.get(c.pid)?.[0];
            if (cwd)
              cwdCache.set(c.pid, { startedAt: c.startedAt, value: cwd });
          }
        } else {
          for (const c of missing) {
            const cwd = await readCwd(c.pid);
            if (cwd)
              cwdCache.set(c.pid, { startedAt: c.startedAt, value: cwd });
          }
        }
      }
      for (const c of clis)
        c.cwd = fresh(cwdCache, c.pid, c.startedAt)?.value ?? null;

      const alive = new Set([...servers, ...clis].map(p => p.pid));
      for (const cache of [portCache, cwdCache] as Map<number, unknown>[]) {
        for (const pid of [...cache.keys()])
          if (!alive.has(pid)) cache.delete(pid);
      }
      return {
        servers: servers.map(server => ({
          pid: server.pid,
          startedAt: server.startedAt,
          product: server.product,
          token: server.token,
          ports: server.ports,
        })),
        clis,
      };
    },
  };
}
