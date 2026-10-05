/**
 * The one usage number the Kimi desktop app keeps on disk without
 * credentials: how full the context window of a Kimi Work task is
 * (<desktop>/kimi-agent/conversation-context-usage.json, contextUsage 0–1
 * per conversation). The meter shows the running task's, else the most
 * recently updated one's; archived tasks are skipped.
 *
 * Read-only. The files hold conversation ids: never log or return them.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { UsageMetric } from '../types';

import { METRIC_LABEL, percentFromRatio } from './usageApi';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

async function readJson(file: string): Promise<unknown> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    // missing, being rewritten or unreadable: no data this time
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The context metric of the current Kimi Work task, or null when the
 * desktop app has none (not installed, Kimi Work never used).
 */
export async function readContextMetric(
  desktopDir: string
): Promise<UsageMetric | null> {
  const agentDir = path.join(desktopDir, 'kimi-agent');
  const [usage, statuses, archive] = await Promise.all([
    readJson(path.join(agentDir, 'conversation-context-usage.json')),
    readJson(path.join(agentDir, 'conversation-statuses.json')),
    readJson(path.join(agentDir, 'conversation-archive.json')),
  ]);
  if (!isRecord(usage)) return null;

  const archived = new Set<string>(
    Array.isArray(archive)
      ? archive.filter((key): key is string => typeof key === 'string')
      : isRecord(archive)
        ? Object.keys(archive)
        : []
  );
  const status = isRecord(statuses) ? statuses : {};

  let best: { ratio: number; running: boolean; at: number } | null = null;
  for (const [key, entry] of Object.entries(usage)) {
    if (archived.has(key) || !isRecord(entry)) continue;
    const ratio = entry.contextUsage;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) continue;
    const at = Date.parse(`${entry.updatedAt ?? ''}`);
    const candidate = {
      ratio,
      running: status[key] === 'running',
      at: Number.isFinite(at) ? at : 0,
    };
    if (
      !best ||
      (candidate.running && !best.running) ||
      (candidate.running === best.running && candidate.at > best.at)
    ) {
      best = candidate;
    }
  }
  if (!best) return null;
  return {
    id: 'context',
    label: METRIC_LABEL.context,
    percent: percentFromRatio(best.ratio),
    resetsAt: null,
  };
}
