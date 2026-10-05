/**
 * Runs what a New Session key asks for: a program started directly, or a
 * terminal window running a CLI in a folder. Programs start through execFile
 * with an argument list, never through a shell. On macOS the terminal runs a
 * self-deleting `.command` script (opened with `open -a Terminal`, so no
 * Automation permission is needed) in which every word is single-quoted.
 * Errors never contain the arguments (folders, script paths).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SETTLE_MS,
  ExecFileLike,
  OpenUrlError,
  execDetached,
} from './openUrl';

export type CommandSpec = { file: string; args: string[]; cwd?: string };

/** Starts a program; resolves once it was accepted, rejects otherwise. */
export type CommandRunner = (command: CommandSpec) => Promise<void>;

export type CommandRunnerOptions = {
  execFile?: ExecFileLike;
  settleMs?: number;
};

/** An error message with every argument (paths, names) left out. */
function describeCommandFailure(
  command: CommandSpec,
  error: Error,
  stderr: unknown
): OpenUrlError {
  const raw = (error as { code?: unknown }).code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? raw : null;
  const hidden = [...command.args, command.cwd ?? '']
    .filter(arg => arg.length >= 3)
    .sort((a, b) => b.length - a.length);
  let detail =
    `${stderr ?? ''}`
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) ?? '';
  for (const arg of hidden) detail = detail.split(arg).join('…');
  detail = detail.slice(0, 200);
  const name = command.file.split(/[\\/]/).pop() || command.file;
  const status =
    code === 'ENOENT'
      ? `${name} not found`
      : `${name} failed${code === null ? '' : ` (${code})`}`;
  return new OpenUrlError(detail ? `${status}: ${detail}` : status, code);
}

/** Creates a command runner; options exist so tests never start a process. */
export function createCommandRunner(
  options: CommandRunnerOptions = {}
): CommandRunner {
  const run: ExecFileLike = options.execFile ?? execFile;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  return command =>
    execDetached(run, command, settleMs, (error, stderr) =>
      describeCommandFailure(command, error, stderr)
    );
}

/** Starts programs on this computer (tests pass a stub runner instead). */
export const runCommand: CommandRunner = createCommandRunner();

// --- terminal ------------------------------------------------------------------

/** One word for sh: single-quoted, embedded quotes as '\''. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The macOS `.command` script that runs `command` in `cwd`: it deletes
 * itself first (the shell keeps it open), changes to the folder, and execs
 * the program. Every word is quoted, so no folder name can inject syntax.
 */
export function commandScript(command: string[], cwd: string | null): string {
  if (command.length === 0) throw new Error('commandScript: empty command');
  const lines = ['#!/bin/sh', 'rm -f -- "$0"'];
  if (cwd) {
    lines.push(
      `cd -- ${shellQuote(cwd)} || { echo 'Folder not found'; exit 1; }`
    );
  }
  lines.push(`exec ${command.map(shellQuote).join(' ')}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Characters cmd.exe acts on in a command line: the Windows console runs
 * the program through `cmd /k`, which would split or expand a word holding
 * one (e.g. a home folder named `A&B`), quoted or not.
 */
const CMD_SPECIAL = /[&|<>^%!()"\r\n]/;

/**
 * The command that opens a terminal window: macOS opens the `.command`
 * script at `script`; Windows starts a new console (`start`); Linux uses
 * x-terminal-emulator. Windows and Linux are best effort (unverified).
 * On Windows a word with a cmd.exe special character is refused (the
 * error names no path).
 */
export function terminalCommand(
  command: string[],
  cwd: string | null,
  platform: NodeJS.Platform,
  script?: string
): CommandSpec {
  if (command.length === 0) throw new Error('terminalCommand: empty command');
  switch (platform) {
    case 'darwin':
      if (!script) throw new Error('terminalCommand: no script on macOS');
      return { file: '/usr/bin/open', args: ['-a', 'Terminal', script] };
    case 'win32':
      if (command.some(word => CMD_SPECIAL.test(word))) {
        throw new Error(
          'The program path holds a character cmd.exe would act on (& | < > ^ % ! ( ) "): cannot start it in a console'
        );
      }
      return {
        file: 'cmd.exe',
        // '' becomes the empty window title "" (libuv quotes empty args)
        args: ['/d', '/c', 'start', '', 'cmd.exe', '/k', ...command],
        ...(cwd ? { cwd } : {}),
      };
    default:
      return {
        file: 'x-terminal-emulator',
        args: ['-e', ...command],
        ...(cwd ? { cwd } : {}),
      };
  }
}

/** Opens a terminal window running `command` in `cwd` (null: home). */
export type TerminalOpener = (
  command: string[],
  cwd: string | null
) => Promise<void>;

export type TerminalOpenerOptions = {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Folder for the macOS script (default: the per-user temp folder) */
  tmpDir?: string;
  writeFile?: (file: string, data: string, mode: number) => Promise<void>;
  unlink?: (file: string) => Promise<void>;
  /**
   * The script deletes itself when Terminal runs it; if Terminal never
   * does, it is removed this long after `open` accepted it (default 60 s)
   */
  cleanupMs?: number;
};

/** Script names the terminal opener writes (flexbar-<16 hex>.command) */
const SCRIPT_RE = /^flexbar-[0-9a-f]{16}\.command$/;
/** Leftover scripts older than this are removed by sweepTerminalScripts */
const SCRIPT_MAX_AGE_MS = 60_000;

/**
 * Removes terminal scripts this plugin left in `dir` (Terminal never ran
 * them) that are older than `maxAgeMs`. Never throws; resolves to how many
 * were removed. Only files named like the opener's scripts are touched.
 */
export async function sweepTerminalScripts(
  dir: string = os.tmpdir(),
  maxAgeMs: number = SCRIPT_MAX_AGE_MS,
  now: number = Date.now()
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!SCRIPT_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      await fsp.unlink(file);
      removed++;
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
  return removed;
}

/** Creates a terminal opener; options exist so tests never open anything. */
export function createTerminalOpener(
  options: TerminalOpenerOptions = {}
): TerminalOpener {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const writeFile =
    options.writeFile ??
    ((file: string, data: string, mode: number) =>
      fsp.writeFile(file, data, { mode, flag: 'wx' }));
  const unlink = options.unlink ?? ((file: string) => fsp.unlink(file));
  const cleanupMs = options.cleanupMs ?? SCRIPT_MAX_AGE_MS;
  return async (command, cwd) => {
    if (platform !== 'darwin') {
      await run(terminalCommand(command, cwd, platform));
      return;
    }
    const name = `flexbar-${randomBytes(8).toString('hex')}.command`;
    const script = path.join(options.tmpDir ?? os.tmpdir(), name);
    await writeFile(script, commandScript(command, cwd), 0o700);
    try {
      await run(terminalCommand(command, cwd, platform, script));
    } catch (error) {
      await unlink(script).catch(() => undefined);
      throw error;
    }
    // normally gone already (the script removes itself first thing)
    const timer = setTimeout(
      () => void unlink(script).catch(() => undefined),
      cleanupMs
    );
    timer.unref?.();
  };
}
