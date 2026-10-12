/**
 * Kimi Work's scheduled tasks ("Automations"), read-only, from the desktop
 * app's data folder: `<desktopDir>/daimon-share/daimon/agents/main/blueprint/
 * automations/automation_*`. Each task is an `automation.json` (title,
 * enabled, trigger cron and timezone, the latest/active run ids) plus one
 * folder per run under `runs/` (status and times only).
 *
 * Privacy: a task's prompt, description, workspace and delivery are never
 * read, and a run's logs are never read; nothing here is logged. The next
 * run is computed from the cron text (./cronNext.ts): the store holds none.
 */
import path from 'node:path';

import type { AutomationBoard, AutomationItem } from '../types';

import { nextRunOf } from './cronNext';
import {
  JsonFile,
  cleanTitle,
  isDir,
  isObj,
  readDir,
  str,
  timeOf,
} from './sessionFs';

/** Safety cap on the tasks read (a key shows a page of a few) */
const MAX_ITEMS = 100;
/** An "active" run older than this is stale: the app died mid-run */
const RUNNING_STALE_MS = 12 * 60 * 60_000;

/** Run statuses after which nothing of that run is under way */
const RUN_DONE = /^(succeeded|failed|cancelled|canceled|skipped)$/i;

type AutomationFacts = {
  id: string;
  title: string;
  enabled: boolean;
  cron: string | null;
  timezone: string | null;
  latestRunId: string | null;
  activeRunId: string | null;
  updatedAt: number | null;
};

type RunFacts = {
  status: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

/** Keeps only the fields the key draws; undefined while a write is in flight. */
function automationFacts(id: string) {
  return (raw: unknown): AutomationFacts | undefined => {
    if (!isObj(raw) || !isObj(raw.automation)) return undefined;
    const a = raw.automation;
    const trigger = isObj(a.trigger) ? a.trigger : {};
    const scheduled = str(trigger.kind) === 'schedule';
    return {
      id,
      title: cleanTitle(a.title) ?? '',
      enabled: a.enabled !== false,
      cron: scheduled ? str(trigger.cron) : null,
      timezone: scheduled ? str(trigger.timezone) : null,
      latestRunId: str(a.latestRunId),
      activeRunId: str(a.activeRunId),
      updatedAt: timeOf(a.updatedAt),
    };
  };
}

/** A run's status and times; the run's logs are never read. */
function runFacts(raw: unknown): RunFacts | undefined {
  if (!isObj(raw) || !isObj(raw.run)) return undefined;
  const run = raw.run;
  return {
    status: str(run.status),
    startedAt: timeOf(run.startedAt),
    completedAt: timeOf(run.completedAt),
  };
}

export class KimiAutomations {
  /** The blueprint automations folder (may not exist) */
  readonly dir: string;
  private tasks = new Map<string, JsonFile<AutomationFacts | null>>();
  private runs = new Map<string, JsonFile<RunFacts | null>>();
  /** null: never synced; else whether the folder was there */
  private synced: boolean | null = null;

  constructor(readonly desktopDir: string) {
    this.dir = path.join(
      desktopDir,
      'daimon-share',
      'daimon',
      'agents',
      'main',
      'blueprint',
      'automations'
    );
  }

  /** Re-reads the tasks and their referenced runs (changed files only). */
  async sync() {
    this.synced = await isDir(this.dir);
    const entries = (await readDir(this.dir)).filter(
      entry => entry.isDirectory() && entry.name.startsWith('automation_')
    );
    const seen = new Set<string>();
    for (const entry of entries.slice(0, MAX_ITEMS)) {
      seen.add(entry.name);
      let file = this.tasks.get(entry.name);
      if (!file) {
        file = new JsonFile(
          path.join(this.dir, entry.name, 'automation.json'),
          null,
          automationFacts(entry.name)
        );
        this.tasks.set(entry.name, file);
      }
      await file.sync();
    }
    for (const name of [...this.tasks.keys()]) {
      if (!seen.has(name)) this.tasks.delete(name);
    }

    // the runs the tasks point at: the active one and the latest one
    const wanted = new Set<string>();
    for (const [name, file] of this.tasks) {
      const task = file.value;
      if (task?.activeRunId) wanted.add(`${name}/${task.activeRunId}`);
      if (task?.latestRunId) wanted.add(`${name}/${task.latestRunId}`);
    }
    for (const key of wanted) {
      let file = this.runs.get(key);
      if (!file) {
        const [name, runId] = key.split('/');
        file = new JsonFile(
          path.join(this.dir, name, 'runs', safeDirName(runId), 'run.json'),
          null,
          runFacts
        );
        this.runs.set(key, file);
      }
      await file.sync();
    }
    for (const key of [...this.runs.keys()]) {
      if (!wanted.has(key)) this.runs.delete(key);
    }
  }

  /** The tasks as the key draws them; `now` computes the next runs. */
  board(now: number): AutomationBoard {
    const items: AutomationItem[] = [];
    for (const [name, file] of this.tasks) {
      const task = file.value;
      if (!task) continue;
      items.push(this.item(name, task, now));
    }
    return { available: this.synced !== false, items };
  }

  private item(
    name: string,
    task: AutomationFacts,
    now: number
  ): AutomationItem {
    const run = (runId: string | null): RunFacts | null =>
      runId ? (this.runs.get(`${name}/${runId}`)?.value ?? null) : null;
    const active = run(task.activeRunId);
    const latest = run(task.latestRunId);
    const activeAt = active
      ? Math.max(active.startedAt ?? 0, active.completedAt ?? 0) || null
      : null;
    const running =
      !!task.activeRunId &&
      (!active || !RUN_DONE.test(active.status ?? '')) &&
      (activeAt === null || now - activeAt <= RUNNING_STALE_MS);
    const lastRunAt = latest ? (latest.completedAt ?? latest.startedAt) : null;
    return {
      id: task.id,
      title: task.title,
      enabled: task.enabled,
      cron: task.cron,
      timezone: task.timezone,
      nextRunAt:
        task.enabled && task.cron
          ? nextRunOf(task.cron, task.timezone, now)
          : null,
      running,
      failed:
        !running &&
        !!latest &&
        (latest.status ?? '').toLowerCase() === 'failed',
      lastRunAt,
      updatedAt: task.updatedAt,
    };
  }
}

/** A run id ("run_<uuid>") as a folder name, stripped of anything unsafe */
function safeDirName(runId: string): string {
  return runId.replace(/[^\w-]/g, '');
}
