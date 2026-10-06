/**
 * Antigravity conversations as plain facts, and the session status derived
 * from them. Pure (no fs, no network, no clock): the monitor
 * (./sessionMonitor.ts) feeds it the language server's
 * `GetAllCascadeTrajectories` answer, decoded `raw_summary` blobs
 * (./sessionProto.ts) or the plain columns of conversation_summaries.db.
 *
 * The rules mirror Antigravity's own UI: the title is the user's title, else
 * the summary; subagents, battle-mode forks and archived conversations are
 * hidden; a conversation needs the user while it runs and has a waiting step
 * (an askQuestion is a question, anything else an approval); a blocking
 * notify_user after the last user input waits for a review (of the plan in
 * planning mode, else of what the agent did); "active" means notFullyIdle;
 * a killed conversation is not running.
 *
 * Summaries carry agent-written text (titles, command lines, questions):
 * only what a key face shows is kept, and none of it is ever logged.
 */
import { fileURLToPath } from 'node:url';

import {
  ATTENTION_STATES,
  STALE_WAITING_MS,
  STALE_WORKING_MS,
} from '../../session';
import { makeStatus } from '../kit';
import { Lang, SessionStatus } from '../types';

import type { AntigravityProduct } from './paths';

export type RunStatus =
  'unspecified' | 'idle' | 'running' | 'canceling' | 'busy';

/** What the first waiting step asks for. */
export type Waiting = {
  /** The RequestedInteraction case, e.g. 'runCommand', 'askQuestion' */
  kind: string;
  /** runCommand: the command line */
  command: string | null;
  /** permission: the action, e.g. 'write' */
  action: string | null;
  /** askQuestion / elicitation: the question */
  question: string | null;
  options: string[];
};

export type ConversationFacts = {
  /** Conversation id (never logged) */
  id: string;
  product: AntigravityProduct;
  title: string | null;
  status: RunStatus;
  stepCount: number;
  lastModified: number | null;
  lastUserInput: number | null;
  lastUserInputStepIndex: number | null;
  /** First workspace folder as a local path, or null */
  workspace: string | null;
  branch: string | null;
  waiting: Waiting | null;
  /** Step index of a blocking notify_user (waits for a review), or null */
  blockingNotifyStep: number | null;
  task: { name: string | null; status: string | null; mode: string | null };
  notFullyIdle: boolean;
  hasActiveChildren: boolean;
  killed: boolean;
  interrupted: boolean;
  /** A subagent, battle-mode fork, archived or non-chat trajectory */
  hidden: boolean;
};

const TITLE_MAX = 60;
const TEXT_MAX = 200;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

function clip(text: string | null, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') return /^(1|true|t)$/i.test(value.trim());
  return false;
}

/**
 * A time as ms: RFC 3339 (proto3 JSON), gorm's SQLite text
 * ("2026-10-06 09:20:00.123456+08:00"), or a number (s or ms).
 */
export function timeOf(value: unknown): number | null {
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return timeOf(Number(text));
  // "2026-10-06 09:20:00.123456789+08:00" → ISO; JS keeps 3 fraction digits
  text = text
    .replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/ ?([+-]\d{2}):?(\d{2})$/, '$1:$2')
    .replace(/ ?UTC$/i, 'Z');
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** CascadeRunStatus from its JSON name, a short name or a number. */
export function runStatusOf(value: unknown): RunStatus {
  const n = num(value);
  if (n !== null) {
    return (
      (['unspecified', 'idle', 'running', 'canceling', 'busy'] as const)[n] ??
      'unspecified'
    );
  }
  const name = typeof value === 'string' ? value.trim().toUpperCase() : '';
  const short = name.replace(/^CASCADE_RUN_STATUS_/, '');
  switch (short) {
    case 'IDLE':
      return 'idle';
    case 'RUNNING':
      return 'running';
    case 'CANCELING':
    case 'CANCELLING':
      return 'canceling';
    case 'BUSY':
      return 'busy';
    default:
      return 'unspecified';
  }
}

/** A file:// workspace URI (or a plain absolute path) as a local path. */
export function workspacePath(uri: unknown): string | null {
  const text = typeof uri === 'string' ? uri.trim() : '';
  if (!text) return null;
  if (/^file:/i.test(text)) {
    try {
      return fileURLToPath(text).replace(/[\\/]+$/, '') || null;
    } catch {
      return null;
    }
  }
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) ? text : null;
}

function enumName(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase() : `${value ?? ''}`;
}

/** Trajectory types the app lists (chat conversations). */
function listedType(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  const name = enumName(value);
  return [
    '0',
    '4',
    '17',
    'CORTEX_TRAJECTORY_TYPE_UNSPECIFIED',
    'CORTEX_TRAJECTORY_TYPE_CASCADE',
    'CORTEX_TRAJECTORY_TYPE_INTERACTIVE_CASCADE',
  ].includes(name);
}

function waitingOf(entry: unknown): Waiting | null {
  const step = obj(obj(entry)?.step);
  if (!step) return null;
  const requested = obj(step.requestedInteraction) ?? {};
  const kind = Object.keys(requested).find(k => obj(requested[k])) ?? '';
  const value = obj(requested[kind]) ?? {};
  let question: string | null = null;
  let options: string[] = [];
  if (kind === 'askQuestion') {
    const first = obj((value.questions as unknown[] | undefined)?.[0]);
    question = clip(str(first?.question), TEXT_MAX);
    options = ((first?.options as unknown[] | undefined) ?? [])
      .map(o => clip(str(obj(o)?.text), 40))
      .filter((o): o is string => !!o)
      .slice(0, 6);
  } else if (kind === 'elicitation') {
    question = clip(str(value.message), TEXT_MAX);
  }
  return {
    kind,
    command:
      kind === 'runCommand'
        ? clip(str(obj(step.runCommand)?.commandLine), TEXT_MAX)
        : null,
    action:
      kind === 'permission' ? clip(str(obj(value.resource)?.action), 40) : null,
    question,
    options,
  };
}

/**
 * The facts of one CascadeTrajectorySummary in its JSON shape (the RPC
 * answer or a decoded raw_summary). Null when it is not an object.
 */
export function factsFromSummary(
  id: string,
  summary: unknown,
  product: AntigravityProduct
): ConversationFacts | null {
  const s = obj(summary);
  if (!s || !id) return null;
  const annotations = obj(s.annotations) ?? {};
  const meta = obj(s.trajectoryMetadata) ?? {};
  const workspaces = (Array.isArray(s.workspaces) ? s.workspaces : []).map(obj);
  const metaUris = Array.isArray(meta.workspaceUris) ? meta.workspaceUris : [];
  const workspace =
    workspacePath(workspaces[0]?.workspaceFolderAbsoluteUri) ??
    workspacePath(metaUris[0]);
  const notify = obj(s.latestNotifyUserStep);
  const notifyUser = obj(obj(notify?.step)?.notifyUser);
  const boundary = obj(obj(obj(s.latestTaskBoundaryStep)?.step)?.taskBoundary);
  const waitingSteps = Array.isArray(s.waitingSteps) ? s.waitingSteps : [];
  const source = enumName(s.source);
  return {
    id,
    product,
    title:
      clip(str(annotations.title), TITLE_MAX) ??
      clip(str(s.summary), TITLE_MAX),
    status: runStatusOf(s.status),
    stepCount: num(s.stepCount) ?? 0,
    lastModified: timeOf(s.lastModifiedTime),
    lastUserInput: timeOf(s.lastUserInputTime),
    lastUserInputStepIndex: num(s.lastUserInputStepIndex),
    workspace,
    branch: clip(str(workspaces[0]?.branchName), 60),
    waiting: waitingSteps.length > 0 ? waitingOf(waitingSteps[0]) : null,
    blockingNotifyStep:
      notifyUser && bool(notifyUser.isBlocking)
        ? (num(notify?.stepIndex) ?? 0)
        : null,
    task: {
      name: clip(str(boundary?.taskName), TEXT_MAX),
      status: clip(str(boundary?.taskStatus), TEXT_MAX),
      mode: typeof boundary?.mode === 'string' ? boundary.mode : null,
    },
    notFullyIdle: bool(s.notFullyIdle),
    hasActiveChildren: bool(s.hasActiveChildren),
    killed: bool(s.killed),
    interrupted: bool(s.interrupted),
    hidden:
      !!str(meta.parentConversationId) ||
      bool(meta.isBattleModeFork) ||
      bool(annotations.archived) ||
      source === 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT' ||
      source === '16' ||
      !listedType(s.trajectoryType),
  };
}

/** A row of conversation_summaries (any subset of its columns). */
export type SummaryRow = Record<string, unknown>;

function workspaceUrisOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((u): u is string => typeof u === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * The facts of a conversation_summaries row: its raw_summary blob (decoded
 * by the caller) when there is one, the plain columns for the rest.
 */
export function factsFromRow(
  row: SummaryRow,
  product: AntigravityProduct,
  decoded: Record<string, unknown> | null
): ConversationFacts | null {
  const id = typeof row.conversation_id === 'string' ? row.conversation_id : '';
  if (!id) return null;
  const columns: ConversationFacts = {
    id,
    product,
    title: clip(str(row.title), TITLE_MAX) ?? clip(str(row.preview), TITLE_MAX),
    status: runStatusOf(row.status),
    stepCount: num(row.step_count) ?? 0,
    lastModified: timeOf(row.last_modified_time),
    lastUserInput: timeOf(row.last_user_input_time),
    lastUserInputStepIndex: (() => {
      const n = num(row.last_user_input_step_index);
      return n === null || n < 0 ? null : n;
    })(),
    workspace: workspacePath(workspaceUrisOf(row.workspace_uris)[0]),
    branch: null,
    waiting: null,
    blockingNotifyStep: null,
    task: { name: null, status: null, mode: null },
    notFullyIdle: bool(row.not_fully_idle),
    killed: bool(row.killed),
    hasActiveChildren: false,
    interrupted: false,
    hidden:
      !!str(row.parent_conversation_id) ||
      Number(num(row.nesting_depth) ?? 0) > 0,
  };
  const rich = decoded ? factsFromSummary(id, decoded, product) : null;
  if (!rich) return columns;
  return {
    ...rich,
    title: rich.title ?? columns.title,
    lastModified: rich.lastModified ?? columns.lastModified,
    lastUserInput: rich.lastUserInput ?? columns.lastUserInput,
    workspace: rich.workspace ?? columns.workspace,
    hidden: rich.hidden || columns.hidden,
  };
}

// --- status -----------------------------------------------------------------

/** Whether the conversation's language server or CLI is running. */
export type Liveness =
  /** It answered (RPC), or the CLI that writes it runs */
  | 'live'
  /** Known not to run (no language server / CLI process for it) */
  | 'gone'
  /** No process information */
  | 'unknown';

export type DeriveOptions = {
  now: number;
  /** done / stopped turn idle after this long */
  idleMs: number;
  liveness: Liveness;
  lang: Lang;
};

const WAIT_LABELS: Record<Lang, Record<string, string>> = {
  en: {
    runCommand: 'Run command',
    filePermission: 'File access',
    openBrowserUrl: 'Open URL',
    readUrlContent: 'Read URL',
    mcp: 'MCP tool',
    captureBrowserScreenshot: 'Screenshot',
    executeBrowserJavascript: 'Run JS',
    clickBrowserPixel: 'Browser action',
    browserAction: 'Browser action',
    openBrowserSetup: 'Browser setup',
    confirmBrowserSetup: 'Browser setup',
    sendCommandInput: 'Command input',
    runExtensionCode: 'Extension code',
    deploy: 'Deploy',
    approvalInteraction: 'Approval',
    permission: 'Permission',
    admin: 'Administrator access',
    other: 'Input required',
  },
  zh: {
    runCommand: '运行命令',
    filePermission: '访问文件',
    openBrowserUrl: '打开网址',
    readUrlContent: '读取网址',
    mcp: 'MCP 工具',
    captureBrowserScreenshot: '截图',
    executeBrowserJavascript: '运行 JS',
    clickBrowserPixel: '浏览器操作',
    browserAction: '浏览器操作',
    openBrowserSetup: '浏览器设置',
    confirmBrowserSetup: '浏览器设置',
    sendCommandInput: '命令输入',
    runExtensionCode: '扩展代码',
    deploy: '部署',
    approvalInteraction: '批准',
    permission: '权限',
    admin: '管理员权限',
    other: '需要输入',
  },
};

/** A blocking notify_user outside planning mode: "Review: <task>". */
export function reviewLabel(task: string | null, lang: Lang): string {
  if (task) return `${lang === 'zh' ? '审阅' : 'Review'}: ${task}`;
  return lang === 'zh' ? '请审阅' : 'Review requested';
}

/** Whether the task boundary is in planning mode (a plan to review). */
export function planningMode(mode: string | null): boolean {
  return !!mode && /(^|_)PLANNING$/i.test(mode.trim());
}

/** What an approval waits for, e.g. "Run: npm test", "Permission: write". */
export function waitingLabel(w: Waiting, lang: Lang): string {
  const labels = WAIT_LABELS[lang];
  if (w.kind === 'runCommand' && w.command) {
    return `${lang === 'zh' ? '运行' : 'Run'}: ${w.command}`;
  }
  if (w.kind === 'permission') {
    if (w.action === 'escalate_admin') return labels.admin;
    return w.action ? `${labels.permission}: ${w.action}` : labels.permission;
  }
  return labels[w.kind] ?? labels.other;
}

const QUESTION_KINDS = new Set(['askQuestion', 'elicitation']);

/** Running, or busy with something: the conversation is not fully idle. */
export function isEngaged(f: ConversationFacts): boolean {
  if (f.killed) return false;
  return (
    f.status === 'running' ||
    f.status === 'busy' ||
    f.status === 'canceling' ||
    f.hasActiveChildren ||
    f.notFullyIdle
  );
}

/** Waits for the user: a waiting step while it runs, or a blocking review. */
export function needsUser(f: ConversationFacts): boolean {
  if (f.killed) return false;
  if (f.waiting && isEngaged(f)) return true;
  return reviewPending(f);
}

function reviewPending(f: ConversationFacts): boolean {
  return (
    !f.killed &&
    f.blockingNotifyStep !== null &&
    (f.lastUserInputStepIndex === null ||
      f.blockingNotifyStep > f.lastUserInputStepIndex) &&
    (f.status === 'idle' || f.status === 'unspecified')
  );
}

/**
 * The key's SessionStatus of a conversation (project and progress are set
 * by the caller).
 */
export function deriveAgStatus(
  f: ConversationFacts,
  options: DeriveOptions
): SessionStatus {
  const { now, idleMs, liveness, lang } = options;
  const age = f.lastModified === null ? Infinity : now - f.lastModified;
  const engaged = isEngaged(f);
  const status = makeStatus({
    state: 'idle',
    title: f.title,
    branch: f.branch,
    sessionId: f.id,
    lastActivity: f.lastModified,
    turnStartedAt: f.lastUserInput,
    since: f.lastModified,
    live: liveness === 'live' && (engaged || needsUser(f)),
  });

  const stopped = () => {
    status.state = 'interrupted';
    status.since = f.lastModified;
  };

  if (f.waiting && engaged) {
    if (liveness === 'gone') stopped();
    else if (QUESTION_KINDS.has(f.waiting.kind)) {
      status.state = 'question';
      status.hasQuestion = true;
      status.question = f.waiting.question;
      status.options = f.waiting.options;
    } else {
      status.state = 'permission';
      status.tool = waitingLabel(f.waiting, lang);
    }
  } else if (reviewPending(f)) {
    if (planningMode(f.task.mode)) {
      status.state = 'plan';
      status.detail = f.task.name;
    } else {
      // a walkthrough or other result to look at: not a plan
      status.state = 'permission';
      status.tool = reviewLabel(f.task.name, lang);
    }
  } else if (engaged) {
    if (liveness === 'gone') stopped();
    else {
      status.state = 'working';
      status.since = f.lastUserInput ?? f.lastModified;
      status.background =
        f.status !== 'running' &&
        f.status !== 'busy' &&
        f.status !== 'canceling';
      status.detail = f.task.status ?? f.task.name;
    }
  } else if (f.interrupted || f.killed) {
    stopped();
  } else {
    status.state = 'done';
  }

  // time-based decay, as for the other providers' sessions
  if (
    (status.state === 'done' || status.state === 'interrupted') &&
    age > idleMs
  ) {
    status.state = 'idle';
  } else if (
    status.state === 'working' &&
    liveness === 'unknown' &&
    age > STALE_WORKING_MS
  ) {
    status.state = 'idle';
  } else if (ATTENTION_STATES.has(status.state) && age > STALE_WAITING_MS) {
    status.state = 'idle';
  }
  if (status.state === 'idle') {
    status.since = f.lastModified;
    status.hasQuestion = false;
    status.question = null;
    status.options = [];
    status.tool = null;
    status.detail = null;
  }
  return status;
}

/** Most recent first; ties by id, so the order is stable. */
export function byRecency(a: ConversationFacts, b: ConversationFacts): number {
  return (
    (b.lastModified ?? 0) - (a.lastModified ?? 0) || a.id.localeCompare(b.id)
  );
}

// --- task.md progress ---------------------------------------------------------

const CHECKBOX_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X|\/)\]\s*(.*)$/;

/**
 * Progress from the checklist in an artifact's task.md: `[x]` done, `[/]` in
 * progress (its text is the active item), `[ ]` open. Null without items.
 */
export function progressOfTask(
  text: string
): { completed: number; total: number; active: string | null } | null {
  let completed = 0;
  let total = 0;
  let active: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = CHECKBOX_RE.exec(line);
    if (!m) continue;
    total++;
    if (m[1] === 'x' || m[1] === 'X') completed++;
    else if (m[1] === '/' && active === null) {
      active = clip(
        str(
          m[2].replace(/[*_`~]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        ),
        TEXT_MAX
      );
    }
  }
  return total > 0 ? { completed, total, active } : null;
}
