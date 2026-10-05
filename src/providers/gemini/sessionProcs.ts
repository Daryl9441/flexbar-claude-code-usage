/**
 * Running Gemini CLI processes (read-only): `ps` lists them with their start
 * times and child processes, `lsof` (macOS) or /proc (Linux) gives their
 * working folder, which is the project the CLI records sessions for. Gemini
 * CLI keeps no registry of running sessions, so this is the only liveness
 * signal. Each interactive CLI runs as two node processes (it relaunches
 * itself with more memory); both are grouped into one instance.
 *
 * Command lines can hold prompts (`gemini -p "…"`): they are parsed in
 * memory for a few flags only, never stored, logged or shown.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';

export type ApprovalMode = 'default' | 'auto_edit' | 'yolo' | 'plan';

/** One running Gemini CLI (the outer process and its relaunched child). */
export type GeminiInstance = {
  /** The outer process first */
  pids: number[];
  /** Start of the outer process, ms (1 s resolution) */
  startedAt: number;
  /** Working folder = the project root, or null when unknown */
  cwd: string | null;
  approvalMode: ApprovalMode | null;
  /** Start of the newest child process that is not the CLI itself, ms */
  toolChildAt: number | null;
};

export type PsRow = {
  pid: number;
  ppid: number;
  startedAt: number;
  /** Only while parsing; dropped before anything is kept */
  args: string;
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

/** Rows of `ps -o pid=,ppid=,etime=,command=`. */
export function parsePs(stdout: string, now: number): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const etime = parseEtime(m[3]);
    if (etime === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: now - etime * 1000,
      args: m[4],
    });
  }
  return rows;
}

function base(word: string): string {
  return word.split(/[\\/]/).pop() ?? word;
}

/** The program is a JavaScript runtime that may run the Gemini CLI. */
const RUNTIME_RE = /^(node|nodejs|bun)(\d+(\.\d+)*)?(\.exe)?$/i;

/** The script is the Gemini CLI (Homebrew, npm, npx or a source build). */
export function isGeminiScript(word: string): boolean {
  const w = word.replace(/\\/g, '/');
  return (
    base(w) === 'gemini' ||
    /gemini-cli\/bundle\/gemini\.js$/.test(w) ||
    /gemini-cli\/dist\/index\.js$/.test(w)
  );
}

const APPROVAL_MODES = new Set(['default', 'auto_edit', 'yolo', 'plan']);

/**
 * Whether a command line runs the Gemini CLI, and its approval mode flag.
 * Words are split on spaces (as `ps` prints them), so a path with spaces
 * in it is not recognised.
 */
export function inspectCommand(args: string): {
  gemini: boolean;
  approvalMode: ApprovalMode | null;
} {
  const words = args.split(/\s+/).filter(Boolean);
  if (words.length < 2 || !RUNTIME_RE.test(base(words[0]))) {
    return { gemini: false, approvalMode: null };
  }
  // runtime options first, then the script
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i++;
  if (i >= words.length || !isGeminiScript(words[i])) {
    return { gemini: false, approvalMode: null };
  }
  let approvalMode: ApprovalMode | null = null;
  for (let j = i + 1; j < words.length; j++) {
    const word = words[j];
    if (word === '--yolo' || word === '-y') approvalMode = 'yolo';
    else if (word.startsWith('--approval-mode=')) {
      const mode = word.slice('--approval-mode='.length);
      if (APPROVAL_MODES.has(mode)) approvalMode = mode as ApprovalMode;
    } else if (word === '--approval-mode' && j + 1 < words.length) {
      const mode = words[j + 1];
      if (APPROVAL_MODES.has(mode)) approvalMode = mode as ApprovalMode;
    }
  }
  return { gemini: true, approvalMode };
}

/**
 * Gemini CLI instances in a process table (without their folder): a CLI
 * process whose parent is another CLI process is the relaunched child of
 * that one. Children that are not CLI processes are its tools (and MCP
 * servers, which start with the CLI).
 */
export function findInstances(rows: PsRow[]): GeminiInstance[] {
  const cli = new Map<number, PsRow & { approvalMode: ApprovalMode | null }>();
  for (const row of rows) {
    const { gemini, approvalMode } = inspectCommand(row.args);
    if (gemini) cli.set(row.pid, { ...row, approvalMode });
  }
  const instances: GeminiInstance[] = [];
  for (const row of cli.values()) {
    if (cli.has(row.ppid)) continue; // a relaunched child
    const pids = [row.pid];
    let mode = row.approvalMode;
    for (const child of cli.values()) {
      if (child.ppid === row.pid) {
        pids.push(child.pid);
        mode = mode ?? child.approvalMode;
      }
    }
    instances.push({
      pids,
      startedAt: row.startedAt,
      cwd: null,
      approvalMode: mode,
      toolChildAt: null,
    });
  }
  const owner = new Map<number, GeminiInstance>();
  for (const instance of instances) {
    for (const pid of instance.pids) owner.set(pid, instance);
  }
  for (const row of rows) {
    const instance = owner.get(row.ppid);
    if (!instance || cli.has(row.pid)) continue;
    if (instance.toolChildAt === null || row.startedAt > instance.toolChildAt) {
      instance.toolChildAt = row.startedAt;
    }
  }
  return instances;
}

/** `lsof -Fpn` output: pid → path (the cwd with `-d cwd`). */
export function parseLsof(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith('n') && pid !== null && !out.has(pid)) {
      out.set(pid, line.slice(1));
    }
  }
  return out;
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
  /** Linux: the cwd of a pid (default: readlink /proc/<pid>/cwd) */
  readCwd?: (pid: number) => Promise<string | null>;
  now?: () => number;
};

/** Lists running Gemini CLIs; null when this platform has no way to. */
export type ProcessProbe = () => Promise<GeminiInstance[] | null>;

/**
 * A probe for this computer: macOS (ps + lsof) and Linux (ps + /proc).
 * Windows has no cheap way to read another process's folder: no probe
 * (sessions are then judged from their files alone). A pid's folder is
 * looked up once and cached.
 */
export function createProcessProbe(options: ProbeOptions = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;
  const now = options.now ?? Date.now;
  const readCwd =
    options.readCwd ??
    (async (pid: number) => {
      try {
        return await fsp.readlink(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    });
  const cwds = new Map<number, { startedAt: number; cwd: string }>();

  return async () => {
    if (platform !== 'darwin' && platform !== 'linux') return null;
    const ps =
      platform === 'darwin'
        ? await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,etime=,command='])
        : await run('ps', ['-e', '-ww', '-o', 'pid=,ppid=,etime=,args=']);
    if (!ps.ok && !ps.stdout) return null;
    const instances = findInstances(parsePs(ps.stdout, now()));

    // the folder of each instance (its outer process), looked up once per
    // process (a reused pid has another start time)
    const known = (i: GeminiInstance) => {
      const entry = cwds.get(i.pids[0]);
      return entry && Math.abs(entry.startedAt - i.startedAt) < 5_000
        ? entry
        : null;
    };
    const missing = instances.filter(i => !known(i));
    if (missing.length > 0) {
      if (platform === 'darwin') {
        const pids = missing.map(i => i.pids[0]).join(',');
        const lsof = await run('/usr/sbin/lsof', [
          '-a',
          '-d',
          'cwd',
          '-Fpn',
          '-p',
          pids,
        ]);
        // lsof exits with 1 when one of the pids is gone; use what it found
        if (lsof.ok || lsof.stdout) {
          const found = parseLsof(lsof.stdout);
          for (const i of missing) {
            const cwd = found.get(i.pids[0]) ?? null;
            if (cwd) cwds.set(i.pids[0], { startedAt: i.startedAt, cwd });
          }
        }
      } else {
        for (const i of missing) {
          const cwd = await readCwd(i.pids[0]);
          if (cwd) cwds.set(i.pids[0], { startedAt: i.startedAt, cwd });
        }
      }
    }
    const alive = new Set(instances.map(i => i.pids[0]));
    for (const pid of [...cwds.keys()]) if (!alive.has(pid)) cwds.delete(pid);
    for (const i of instances) i.cwd = known(i)?.cwd ?? null;
    return instances;
  };
}
