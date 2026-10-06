/**
 * The running Antigravity language servers, shared by the usage key
 * (./usageProcess.ts, ./usageRpc.ts) and the session key
 * (./sessionProcs.ts, ./sessionRpc.ts) so both find the same processes,
 * read the same token and talk to the same ports the same way.
 *
 * The desktop app and the IDE each start a language server (LS) that
 * answers Connect-JSON requests on 127.0.0.1. Its command line names the
 * product (`--app_data_dir antigravity` / `antigravity-ide`) and carries the
 * CSRF token every request must send (`--csrf_token`, never
 * `--extension_server_csrf_token`); `lsof` lists the loopback ports it
 * listens on. The agy CLI runs its language server inside its own process
 * without a visible token, so it is not found here.
 *
 * The CSRF token is a credential: callers keep it in memory only (never
 * logged, stored, shown or put on a child process's command line) and send
 * it only in the `x-codeium-csrf-token` header to a 127.0.0.1 port that
 * `lsof` attributes to the process it came from. Command lines of other
 * processes are parsed in memory and dropped.
 */
import fs from 'node:fs';
import http from 'node:http';

/** The programs with a language server of their own. */
export type ServerProduct = 'app' | 'ide';

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
const TOKEN_RE = /^[A-Za-z0-9._~-]{8,256}$/;

/** Flags whose port is not the Connect HTTP port. */
const OTHER_PORT_FLAGS = [
  'lsp_port',
  'extension_server_port',
  'https_server_port',
];

/** The value of `--name value` or `--name=value` (a whole flag only). */
export function flagValue(command: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\s)--${escaped}(?:=|\\s+)(\\S+)`).exec(command);
  return m ? m[1] : null;
}

function basename(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? value
  );
}

/** A language server of the app or the IDE, as its command line shows it. */
export type ServerCommand = {
  product: ServerProduct;
  /** CSRF token for this server: a credential (memory only) */
  token: string;
  /** Ports this server's flags reserve for something else */
  skipPorts: number[];
};

/**
 * The Antigravity language server a `ps` command line runs, or null. Only
 * the app's and the IDE's servers qualify: the executable sits in an
 * Antigravity folder and the data folder is theirs.
 */
export function parseServerCommand(command: string): ServerCommand | null {
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
  return { product, token, skipPorts };
}

/** `lsof -F` output: pid → names (`n` lines). */
export function parseLsofNames(stdout: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null) {
      out.set(pid, [...(out.get(pid) ?? []), line.slice(1)]);
    }
  }
  return out;
}

/**
 * Loopback listener ports (127.0.0.1 / localhost) from lsof names, highest
 * first (the plain-HTTP Connect port is the higher of the two the servers
 * open), without the ones in `exclude`.
 */
export function loopbackPorts(
  names: readonly string[],
  exclude: readonly number[] = []
): number[] {
  const ports = new Set<number>();
  for (const name of names) {
    const m = /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(name.trim());
    if (!m) continue;
    const port = Number(m[1]);
    if (port > 0 && port < 65536 && !exclude.includes(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => b - a);
}

function firstExisting(candidates: string[]): string {
  return candidates.find(file => fs.existsSync(file)) ?? candidates[0];
}

let linuxTools: { ps: string; lsof: string } | null = null;

/** `ps` and `lsof` at their usual places (macOS, Linux). */
export function toolPaths(platform: NodeJS.Platform = process.platform): {
  ps: string;
  lsof: string;
} {
  if (platform === 'darwin') return { ps: '/bin/ps', lsof: '/usr/sbin/lsof' };
  linuxTools ??= {
    ps: firstExisting(['/bin/ps', '/usr/bin/ps']),
    lsof: firstExisting(['/usr/bin/lsof', '/usr/sbin/lsof', '/sbin/lsof']),
  };
  return linuxTools;
}

// --- loopback Connect-JSON ----------------------------------------------------

/** The language server's Connect service. */
export const LS_SERVICE = 'exa.language_server_pb.LanguageServerService';

/** The request path of a method of the language server's service. */
export function rpcPath(method: string): string {
  return `/${LS_SERVICE}/${method}`;
}

/** Headers of a Connect-JSON request; the token goes nowhere else. */
export function rpcHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'connect-protocol-version': '1',
    'x-codeium-csrf-token': token,
  };
}

/** Whether an answer is the HTTPS port's reply to a plain HTTP request. */
export function isTlsPortReply(status: number, body: string): boolean {
  return (
    status === 400 &&
    /http request to an https server|\btls\b/i.test(body.slice(0, 400))
  );
}

/** One POST to 127.0.0.1. */
export type LoopbackRequest = {
  port: number;
  path: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Largest answer accepted, in bytes */
  maxBytes: number;
};

/** An HTTP answer as received, or the transport failure. */
export type LoopbackResult =
  | { status: number; contentType: string; body: string }
  | {
      error: 'refused' | 'timeout' | 'too-large' | 'failed';
      /** The error's code (e.g. ECONNRESET) when it has a plain one */
      code?: string;
    };

/** A credential-free code of a transport error, or undefined. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]{2,30}$/.test(code)
    ? code
    : undefined;
}

/**
 * POSTs to 127.0.0.1 (fixed here, not configurable) over node:http: no
 * proxy, no keep-alive, a socket timeout and a deadline for slow answers,
 * and a cap on the answer's size. Never rejects. Tests pass a fake
 * `request`.
 */
export function postLoopback(
  options: LoopbackRequest,
  request: typeof http.request = http.request
): Promise<LoopbackResult> {
  return new Promise(resolve => {
    const { port } = options;
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      resolve({ error: 'failed', code: 'EBADPORT' });
      return;
    }
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const done = (result: LoopbackResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };
    try {
      const payload = Buffer.from(options.body, 'utf8');
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: options.path,
          method: 'POST',
          agent: false,
          timeout: options.timeoutMs,
          headers: {
            ...options.headers,
            'content-length': `${payload.length}`,
          },
        },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > options.maxBytes) {
              done({ error: 'too-large' });
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            done({
              status: res.statusCode ?? 0,
              contentType: String(res.headers?.['content-type'] ?? ''),
              body: Buffer.concat(chunks).toString('utf8'),
            })
          );
          res.on('error', error =>
            done({ error: 'failed', code: errorCode(error) })
          );
        }
      );
      // the socket timeout covers silence; the deadline a slow trickle
      deadline = setTimeout(() => {
        done({ error: 'timeout' });
        req.destroy();
      }, options.timeoutMs);
      req.on('timeout', () => {
        done({ error: 'timeout' });
        req.destroy();
      });
      req.on('error', error => {
        const code = errorCode(error);
        done(
          code === 'ECONNREFUSED'
            ? { error: 'refused', code }
            : { error: 'failed', code }
        );
      });
      req.end(payload);
    } catch {
      done({ error: 'failed' });
    }
  });
}
