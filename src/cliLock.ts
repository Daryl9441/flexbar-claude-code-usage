/**
 * Cross-process locks shared with the CLIs whose logins this plugin refreshes
 * (Kimi Code, Claude Code). Both use proper-lockfile: the lock is a directory
 * created with mkdir, its holder touches the directory's mtime while it works,
 * and a lock untouched for `staleMs` counts as abandoned. Taking the same lock
 * keeps the plugin from rotating a refresh token while the CLI rotates it too.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rmdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

export type LockTimings = {
  /** Attempts while another process holds the lock */
  retries: number;
  /** Wait between attempts */
  delayMs: number;
  /** A lock untouched this long is abandoned (proper-lockfile `stale`) */
  staleMs: number;
  /** How often a held lock's mtime is refreshed */
  updateMs: number;
  /**
   * Stop refreshing the mtime after this long, so a holder stuck in its work
   * lets the lock go stale instead of keeping the CLI out (default: no limit)
   */
  maxHoldMs?: number;
};

export type LockOptions = {
  /** Create the folder the lock lives in when it is missing (default true) */
  createParent?: boolean;
};

/** The lock directory's inode, or null when it is gone. */
async function lockInode(lockDir: string): Promise<number | null> {
  try {
    return (await stat(lockDir)).ino;
  } catch {
    return null;
  }
}

/**
 * Removes an abandoned lock. It is renamed away first, so two processes that
 * both found it stale cannot remove each other's fresh lock.
 */
async function clearStale(lockDir: string): Promise<void> {
  const aside = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(lockDir, aside);
  } catch {
    return; // already taken over or released: just try again
  }
  await rmdir(aside).catch(() => undefined);
}

/** Whether the existing lock directory counts as abandoned. */
async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    return (await stat(lockDir)).mtimeMs < Date.now() - staleMs;
  } catch {
    return false; // released meanwhile: the next mkdir decides
  }
}

/**
 * Keeps a held lock fresh until released or `maxHoldMs` passes, and only while
 * it is still ours (the same directory, by inode).
 */
function startHeartbeat(
  lockDir: string,
  ino: number,
  timings: LockTimings
): () => void {
  const started = Date.now();
  const timer = setInterval(() => {
    if (
      timings.maxHoldMs !== undefined &&
      Date.now() - started > timings.maxHoldMs
    ) {
      clearInterval(timer);
      return;
    }
    lockInode(lockDir).then(current => {
      if (current !== ino) {
        clearInterval(timer); // lost: someone took it over
        return;
      }
      const time = new Date();
      utimes(lockDir, time, time).catch(() => undefined);
    });
  }, timings.updateMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Takes the proper-lockfile lock `<target>.lock` the CLI uses (a directory
 * created with mkdir; abandoned after `staleMs` without an mtime update).
 * Resolves to a release function, or null when another process kept it. The
 * release removes the directory only while it is still this holder's.
 */
export async function acquireCliLock(
  target: string,
  timings: LockTimings,
  sleep: (ms: number) => Promise<void>,
  { createParent = true }: LockOptions = {}
): Promise<(() => Promise<void>) | null> {
  const lockDir = `${target}.lock`;
  if (createParent) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  }
  for (let attempt = 0; attempt <= timings.retries; attempt++) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStale(lockDir, timings.staleMs)) {
        await clearStale(lockDir);
      } else if (attempt < timings.retries) {
        await sleep(timings.delayMs);
      }
      continue;
    }
    const ino = await lockInode(lockDir);
    const stop = startHeartbeat(lockDir, ino ?? -1, timings);
    return async () => {
      stop();
      if ((await lockInode(lockDir)) === ino) {
        await rmdir(lockDir).catch(() => undefined);
      }
    };
  }
  return null;
}
