/**
 * Whether a pid still belongs to Grok Bot. `process.kill(pid, 0)` only
 * checks that some process exists; the short process name has to mention
 * Grok, so a reused pid is not reported as the app. The command line is
 * never read.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type PidAlive = (pid: number) => boolean;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processComm(pid: number, platform: NodeJS.Platform): string | null {
  try {
    if (platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    }
    if (platform === 'darwin') {
      const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
        timeout: 2000,
        encoding: 'utf8',
        windowsHide: true,
      });
      return path.basename(String(out).trim());
    }
    if (platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { timeout: 3000, encoding: 'utf8', windowsHide: true }
      );
      const name = String(out).split(',')[0]?.replace(/"/g, '').trim() ?? '';
      return name || null;
    }
  } catch {
    return null;
  }
  return null;
}

/** True when `pid` exists and its short name mentions Grok. */
export function pidIsGrokBot(
  pid: number,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (!processExists(pid)) return false;
  const comm = processComm(pid, platform);
  return comm !== null && /grok/i.test(comm);
}
