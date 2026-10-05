/**
 * Claude Code session status, derived from a session transcript
 * (`~/.claude/projects/<project>/<sessionId>.jsonl`, one JSON entry per line,
 * appended while the session runs). Pure: no fs access — sessionSource.ts
 * feeds lines in and supplies the live registry info and the clock.
 *
 * Entries are folded into an Accumulator one at a time, so a transcript can
 * be read from its tail and then incrementally as it grows; deriveStatus()
 * turns the accumulated state into a SessionStatus at a given time.
 */

export type SessionState =
  /** Claude is generating or a tool is running */
  | 'working'
  /** AskUserQuestion is waiting for an answer */
  | 'question'
  /** ExitPlanMode is waiting for plan approval */
  | 'plan'
  /** A tool call is waiting for permission (confirmed or inferred) */
  | 'permission'
  /** The turn ended; Claude is waiting for the next prompt */
  | 'done'
  /** The user interrupted the turn */
  | 'interrupted'
  /** The turn ended with an API error */
  | 'error'
  /** Nothing has happened for a while */
  | 'idle';

export type Progress = {
  completed: number;
  total: number;
  /** activeForm (or content) of the in-progress item */
  active: string | null;
};

export type SessionStatus = {
  state: SessionState;
  /**
   * False when the state is a guess: a permission prompt inferred from a
   * tool call that has been pending for a while without a result.
   */
  confident: boolean;
  /** Claude asked the user something (AskUserQuestion, or prose ending in ?) */
  hasQuestion: boolean;
  /** The pending AskUserQuestion text, or the question in Claude's reply */
  question: string | null;
  /** Option labels of a pending AskUserQuestion */
  options: string[];
  /** What the session waits on: plan title, error text, retry note */
  detail: string | null;
  /** The newest pending tool call, e.g. "Bash: npm test" */
  tool: string | null;
  progress: Progress | null;
  title: string | null;
  project: string | null;
  branch: string | null;
  sessionId: string | null;
  lastActivity: number | null;
  turnStartedAt: number | null;
  /** When the current state began (turn start, prompt shown, turn end) */
  since: number | null;
  /** Busy only with background work (subagents/tasks) after the turn ended */
  background: boolean;
  /** Backed by a live Claude Code process (session registry) */
  live: boolean;
};

/** A live session entry from `~/.claude/sessions/<pid>.json`. */
export type LiveInfo = {
  /** "busy" | "idle" | "waiting" | "shell" */
  status: string;
  /** e.g. "permission prompt", "input needed", "dialog open" */
  waitingFor?: string;
  statusUpdatedAt?: number;
};

type TodoStatus = 'pending' | 'in_progress' | 'completed';

type TodoItem = { content: string; activeForm: string; status: TodoStatus };

type PendingTool = {
  id: string;
  name: string;
  at: number | null;
  input: Record<string, unknown>;
};

type LastEvent = {
  kind:
    | 'prompt'
    | 'tool_result'
    | 'assistant'
    | 'interrupt'
    | 'error'
    | 'retry'
    | 'command_done';
  at: number | null;
};

export type Accumulator = {
  /** Saw at least one user/assistant entry of the main conversation */
  sawConversation: boolean;
  seq: number;
  last: LastEvent | null;
  pending: Map<string, PendingTool>;
  responseId: string | null;
  responseText: string[];
  lastStop: string | null;
  retry: { attempt: number; max: number } | null;
  errorText: string | null;
  todos: TodoItem[] | null;
  tasks: Map<string, TodoItem>;
  pendingCreates: Map<string, TodoItem>;
  progressSeq: number;
  turnSeq: number;
  titles: {
    custom: string | null;
    summary: string | null;
    ai: string | null;
    agent: string | null;
    lastPrompt: string | null;
    firstPrompt: string | null;
  };
  cwd: string | null;
  branch: string | null;
  sessionId: string | null;
  permissionMode: string | null;
  lastActivity: number | null;
  turnStartedAt: number | null;
};

export function createAccumulator(): Accumulator {
  return {
    sawConversation: false,
    seq: 0,
    last: null,
    pending: new Map(),
    responseId: null,
    responseText: [],
    lastStop: null,
    retry: null,
    errorText: null,
    todos: null,
    tasks: new Map(),
    pendingCreates: new Map(),
    progressSeq: 0,
    turnSeq: 0,
    titles: {
      custom: null,
      summary: null,
      ai: null,
      agent: null,
      lastPrompt: null,
      firstPrompt: null,
    },
    cwd: null,
    branch: null,
    sessionId: null,
    permissionMode: null,
    lastActivity: null,
    turnStartedAt: null,
  };
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  );
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const INTERRUPT_RE = /^\[Request interrupted by user/;

/**
 * Prompt text without Claude Code's markup: system reminders and command
 * wrappers are dropped (a slash command keeps its name and arguments).
 * Null for machine-generated turns (task notifications) and empty text.
 */
export function cleanPrompt(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  if (/^<(task-notification|local-command|bash-)/.test(t)) return null;
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, ' $1 ')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1 ')
    .replace(/<\/?[a-zA-Z][\w-]*(\s[^>]*)?>/g, ' ');
  t = oneLine(t);
  return t ? clip(t, 200) : null;
}

/** Keeps only the tool input fields the status needs (inputs can be huge). */
function trimInput(name: string, input: unknown): Obj {
  if (!isObj(input)) return {};
  const keep: Obj = {};
  for (const key of [
    'description',
    'file_path',
    'notebook_path',
    'url',
    'query',
    'pattern',
    'skill',
    'subject',
  ]) {
    const value = str(input[key]);
    if (value) keep[key] = clip(value, 300);
  }
  const command = str(input.command);
  if (command) keep.command = clip(firstLine(command), 300);
  if (name === 'ExitPlanMode') {
    const plan = str(input.plan);
    if (plan) keep.plan = plan.slice(0, 4000);
  }
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    keep.questions = input.questions;
  }
  return keep;
}

function parseTodos(input: unknown): TodoItem[] | null {
  if (!isObj(input) || !Array.isArray(input.todos)) return null;
  const todos: TodoItem[] = [];
  for (const item of input.todos) {
    if (!isObj(item)) continue;
    const status = item.status;
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed'
    ) {
      continue;
    }
    const content = str(item.content) ?? '';
    todos.push({
      content,
      activeForm: str(item.activeForm) ?? content,
      status,
    });
  }
  return todos;
}

const TASK_CREATED_RE = /^Task #(\S+) created successfully/;

/**
 * TaskCreate/TaskUpdate bookkeeping, mirroring how Claude Code rebuilds the
 * task list from a transcript: creates become tasks once their result names
 * the new id; updates merge into (or delete) the task with that id.
 */
function observeTaskTool(acc: Accumulator, block: Obj): boolean {
  const input = isObj(block.input) ? block.input : {};
  if (block.name === 'TaskCreate') {
    const subject = str(input.subject);
    if (!subject || typeof block.id !== 'string') return false;
    acc.pendingCreates.set(block.id, {
      content: subject,
      activeForm: str(input.activeForm) ?? str(input.active_form) ?? subject,
      status: 'pending',
    });
    return true;
  }
  if (block.name === 'TaskUpdate') {
    const id = str(input.taskId) ?? str(input.id) ?? str(input.task_id);
    if (!id) return false;
    const status = input.status;
    if (status === 'deleted') return acc.tasks.delete(id);
    const prev = acc.tasks.get(id);
    const subject = str(input.subject);
    const activeForm = str(input.activeForm) ?? str(input.active_form);
    acc.tasks.set(id, {
      content: subject ?? prev?.content ?? id,
      activeForm: activeForm ?? prev?.activeForm ?? subject ?? id,
      status:
        status === 'pending' ||
        status === 'in_progress' ||
        status === 'completed'
          ? status
          : (prev?.status ?? 'pending'),
    });
    return true;
  }
  return false;
}

function toolResultText(block: Obj): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part =>
        isObj(part) && typeof part.text === 'string' ? part.text : ''
      )
      .join('');
  }
  return '';
}

function resolveTool(acc: Accumulator, block: Obj) {
  const id = block.tool_use_id;
  if (typeof id !== 'string') return;
  acc.pending.delete(id);
  const create = acc.pendingCreates.get(id);
  if (create) {
    acc.pendingCreates.delete(id);
    const taskId = toolResultText(block).match(TASK_CREATED_RE)?.[1];
    if (block.is_error !== true && taskId && !acc.tasks.has(taskId)) {
      acc.tasks.set(taskId, create);
    }
    acc.progressSeq = ++acc.seq;
  }
}

function startTurn(acc: Accumulator, text: string, at: number | null) {
  acc.pending.clear();
  acc.last = { kind: 'prompt', at };
  acc.turnStartedAt = at ?? acc.turnStartedAt;
  acc.turnSeq = ++acc.seq;
  acc.retry = null;
  acc.errorText = null;
  acc.responseId = null;
  acc.responseText = [];
  const prompt = cleanPrompt(text);
  if (prompt && !acc.titles.firstPrompt) acc.titles.firstPrompt = prompt;
}

function observePromptText(acc: Accumulator, text: string, at: number | null) {
  const t = text.trim();
  if (INTERRUPT_RE.test(t)) {
    acc.pending.clear();
    acc.last = { kind: 'interrupt', at };
  } else if (/^<local-command-(stdout|stderr)>/.test(t)) {
    // a local slash command (/model, /cost…) finished: no Claude turn runs
    acc.pending.clear();
    acc.last = { kind: 'command_done', at };
  } else if (!/^<local-command-caveat>/.test(t)) {
    startTurn(acc, t, at);
  }
}

function observeUser(acc: Accumulator, entry: Obj, at: number | null) {
  if (
    entry.isMeta === true ||
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true
  ) {
    return;
  }
  const mode = str(entry.permissionMode);
  if (mode) acc.permissionMode = mode;
  const message = isObj(entry.message) ? entry.message : {};
  const content = message.content;
  acc.sawConversation = true;

  if (typeof content === 'string') {
    observePromptText(acc, content, at);
    return;
  }
  if (!Array.isArray(content)) return;

  let sawResult = false;
  const texts: string[] = [];
  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === 'tool_result') {
      sawResult = true;
      resolveTool(acc, block);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'image' || block.type === 'document') {
      texts.push(' ');
    }
  }
  if (texts.some(text => INTERRUPT_RE.test(text.trim()))) {
    acc.pending.clear();
    acc.last = { kind: 'interrupt', at };
  } else if (sawResult) {
    acc.last = { kind: 'tool_result', at };
  } else if (texts.length > 0) {
    observePromptText(acc, texts.join('\n'), at);
  }
}

function observeAssistant(acc: Accumulator, entry: Obj, at: number | null) {
  const message = entry.message;
  if (!isObj(message)) return;
  acc.sawConversation = true;
  acc.retry = null;

  const content = Array.isArray(message.content) ? message.content : [];
  const texts = content
    .filter(
      (b): b is Obj =>
        isObj(b) && b.type === 'text' && typeof b.text === 'string'
    )
    .map(b => b.text as string);

  if (entry.isApiErrorMessage === true || typeof entry.error === 'string') {
    acc.pending.clear();
    acc.errorText =
      clip(firstLine(texts.join('\n')), 160) ||
      (typeof entry.error === 'string' ? entry.error : 'API error');
    acc.last = { kind: 'error', at };
    return;
  }

  // one API response is split over several entries sharing its message id
  const id = str(message.id) ?? str(entry.requestId);
  if (!id || id !== acc.responseId) {
    acc.responseId = id;
    acc.responseText = [];
  }
  if (message.model !== '<synthetic>') acc.responseText.push(...texts);

  for (const block of content) {
    if (!isObj(block) || block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : '';
    if (typeof block.id === 'string') {
      acc.pending.set(block.id, {
        id: block.id,
        name,
        at,
        input: trimInput(name, block.input),
      });
    }
    if (name === 'TodoWrite') {
      const todos = parseTodos(block.input);
      if (todos) {
        acc.todos = todos;
        acc.progressSeq = ++acc.seq;
      }
    } else if (observeTaskTool(acc, block)) {
      acc.progressSeq = ++acc.seq;
    }
  }

  acc.lastStop =
    typeof message.stop_reason === 'string' ? message.stop_reason : null;
  acc.last = { kind: 'assistant', at };
}

function observeSystem(acc: Accumulator, entry: Obj, at: number | null) {
  if (entry.subtype === 'api_error' && typeof entry.retryAttempt === 'number') {
    acc.retry = {
      attempt: entry.retryAttempt,
      max: typeof entry.maxRetries === 'number' ? entry.maxRetries : 0,
    };
    acc.last = { kind: 'retry', at };
  }
}

/** Folds one transcript entry into the accumulator. */
export function observeEntry(acc: Accumulator, entry: unknown): void {
  if (!isObj(entry)) return;
  // subagent messages (older Claude Code wrote them into the main file)
  if (entry.isSidechain === true) return;

  const at = parseTime(entry.timestamp);
  if (at !== null && (acc.lastActivity === null || at > acc.lastActivity)) {
    acc.lastActivity = at;
  }
  const cwd = str(entry.cwd);
  if (cwd) acc.cwd = cwd;
  const branch = str(entry.gitBranch);
  if (branch) acc.branch = branch;
  const sessionId = str(entry.sessionId);
  if (sessionId) acc.sessionId = sessionId;

  switch (entry.type) {
    case 'user':
      observeUser(acc, entry, at);
      break;
    case 'assistant':
      observeAssistant(acc, entry, at);
      break;
    case 'system':
      observeSystem(acc, entry, at);
      break;
    case 'custom-title':
      acc.titles.custom = str(entry.customTitle) ?? acc.titles.custom;
      break;
    case 'ai-title':
      acc.titles.ai = str(entry.aiTitle) ?? acc.titles.ai;
      break;
    case 'summary':
      acc.titles.summary = str(entry.summary) ?? acc.titles.summary;
      break;
    case 'agent-name':
      acc.titles.agent = str(entry.agentName) ?? acc.titles.agent;
      break;
    case 'last-prompt':
      acc.titles.lastPrompt =
        cleanPrompt(entry.lastPrompt) ?? acc.titles.lastPrompt;
      break;
    case 'relocated':
      acc.cwd = str(entry.relocatedCwd) ?? acc.cwd;
      break;
    case 'permission-mode':
      acc.permissionMode = str(entry.permissionMode) ?? acc.permissionMode;
      break;
  }
}

/**
 * Folds the complete lines of a transcript chunk into the accumulator.
 * Lines that are not valid JSON (e.g. a partial last line) are skipped.
 */
export function observeLines(acc: Accumulator, text: string): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    observeEntry(acc, entry);
  }
}

// --- derivation ------------------------------------------------------------

/** Tools that never show a permission prompt (read-only or bookkeeping). */
const NEVER_ASKS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'TodoRead',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'BashOutput',
  'KillShell',
  'KillBash',
  'ToolSearch',
  'StructuredOutput',
  'SendMessage',
  'Sleep',
  'Monitor',
]);

/** Tools whose call always waits for the user's decision. */
const ALWAYS_ASKS = new Set(['EnterPlanMode']);

/** Default delay before a stalled tool call counts as a permission prompt. */
export const PERMISSION_DELAY_MS = 10_000;
/** Without a live process, "working" this long without output is stale. */
export const STALE_WORKING_MS = 30 * 60_000;
/** Waiting states (question, plan, permission) give up after this long. */
export const STALE_WAITING_MS = 12 * 60 * 60_000;
/** Subagent transcript writes this recent mean the session is busy. */
export const SUBAGENT_ACTIVE_MS = 20_000;

export const ATTENTION_STATES: ReadonlySet<SessionState> = new Set([
  'question',
  'plan',
  'permission',
]);

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Short description of a tool call, e.g. "Bash: npm test". */
export function describeTool(name: string, input: Obj = {}): string {
  const s = (key: string) =>
    typeof input[key] === 'string' ? (input[key] as string) : '';
  let label = name;
  let arg = '';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    label = parts.slice(2).join('__') || name;
  }
  switch (name) {
    case 'Bash':
      arg = s('description') || firstLine(s('command'));
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      arg = basename(s('file_path') || s('notebook_path'));
      break;
    case 'WebFetch':
      arg = hostOf(s('url'));
      break;
    case 'WebSearch':
      arg = s('query');
      break;
    case 'Glob':
    case 'Grep':
      arg = s('pattern');
      break;
    case 'Agent':
    case 'Task':
      arg = s('description');
      break;
    case 'Skill':
      arg = s('skill') || s('command');
      break;
  }
  arg = oneLine(arg);
  return arg ? `${label}: ${clip(arg, 120)}` : label;
}

function questionOf(input: Obj): {
  question: string | null;
  options: string[];
} {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions.find(isObj);
  if (!first) return { question: null, options: [] };
  let question = str(first.question) ?? str(first.header);
  if (question && questions.length > 1) {
    question = `${oneLine(question)} (+${questions.length - 1})`;
  }
  const options = Array.isArray(first.options)
    ? first.options
        .map(o => (isObj(o) ? str(o.label) : null))
        .filter((o): o is string => !!o)
        .map(o => oneLine(o))
    : [];
  return { question: question ? oneLine(question) : null, options };
}

function stripMarkdown(line: string): string {
  return oneLine(
    line
      .replace(/^\s*(#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '')
      .replace(/\*\*|__|`/g, '')
  );
}

function planTitle(input: Obj): string | null {
  const plan = str(input.plan);
  if (!plan) return null;
  const line = plan.split('\n').map(stripMarkdown).find(Boolean);
  return line ? clip(line, 200) : null;
}

/**
 * The question Claude's reply ends with, when it ends with one: the last
 * sentence of the last line, markdown stripped. Null otherwise.
 */
export function trailingQuestion(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim().replace(/[\s*_`~)\]"'」』）】》]+$/u, '');
  if (!/[?？]$/.test(t)) return null;
  const line = t.split('\n').pop() ?? t;
  const chars = Array.from(line);
  // start of the last sentence: after a CJK terminator, or a Latin one
  // followed by whitespace and no lowercase letter (so "v1.2" and
  // "e.g. foo" do not split)
  let start = 0;
  for (let i = chars.length - 2; i >= 0; i--) {
    const c = chars[i];
    if ('。！？'.includes(c)) {
      start = i + 1;
      break;
    }
    if ('.!?'.includes(c) && /\s/.test(chars[i + 1])) {
      const next = chars.slice(i + 1).find(ch => !/\s/.test(ch)) ?? '';
      if (!/[a-z]/.test(next)) {
        start = i + 1;
        break;
      }
    }
  }
  let sentence = stripMarkdown(chars.slice(start).join(''));
  if (Array.from(sentence).length < 4) sentence = stripMarkdown(line);
  return sentence ? clip(sentence, 300) : null;
}

/** Todo/task progress, or null when there is none worth showing. */
export function progressOf(acc: Accumulator): Progress | null {
  const items =
    acc.tasks.size + acc.pendingCreates.size > 0
      ? [...acc.tasks.values(), ...acc.pendingCreates.values()]
      : (acc.todos ?? []);
  if (items.length === 0) return null;
  const completed = items.filter(i => i.status === 'completed').length;
  // a finished list from an earlier turn is history, not progress
  if (completed === items.length && acc.progressSeq < acc.turnSeq) return null;
  const active = items.find(i => i.status === 'in_progress');
  return {
    completed,
    total: items.length,
    active: active
      ? oneLine(active.activeForm || active.content) || null
      : null,
  };
}

export function titleOf(acc: Accumulator): string | null {
  const t = acc.titles;
  const title =
    t.custom ?? t.summary ?? t.ai ?? t.agent ?? t.lastPrompt ?? t.firstPrompt;
  return title ? clip(oneLine(title), 200) : null;
}

export type DeriveOptions = {
  now: number;
  /** done/interrupted/error turn into idle after this long */
  idleMs: number;
  permissionDelayMs?: number;
  /** The session's live registry entry, when its process is running */
  live?: LiveInfo | null;
  /** Newest write to one of the session's subagent transcripts */
  subagentActiveAt?: number | null;
  /** Fallbacks when the transcript tail carries no cwd */
  project?: string | null;
  sessionId?: string | null;
};

/** Derives the session status from the accumulated transcript state. */
export function deriveStatus(
  acc: Accumulator,
  options: DeriveOptions
): SessionStatus {
  const { now, idleMs, live } = options;
  const permissionDelay = options.permissionDelayMs ?? PERMISSION_DELAY_MS;
  const subagentAt = options.subagentActiveAt ?? null;
  const subagentBusy =
    subagentAt !== null && now - subagentAt < SUBAGENT_ACTIVE_MS;
  const pending = [...acc.pending.values()];
  const newest = pending[pending.length - 1];
  const ask = pending.find(p => p.name === 'AskUserQuestion');
  const plan = pending.find(p => p.name === 'ExitPlanMode');
  const last = acc.last;

  const status: SessionStatus = {
    state: 'idle',
    confident: true,
    hasQuestion: false,
    question: null,
    options: [],
    detail: null,
    tool: newest ? describeTool(newest.name, newest.input) : null,
    progress: progressOf(acc),
    title: titleOf(acc),
    project: acc.cwd ? basename(acc.cwd) : (options.project ?? null),
    branch: acc.branch,
    sessionId: acc.sessionId ?? options.sessionId ?? null,
    lastActivity: acc.lastActivity,
    turnStartedAt: acc.turnStartedAt,
    since: acc.lastActivity,
    background: false,
    live: !!live,
  };
  const turnStart = acc.turnStartedAt ?? last?.at ?? acc.lastActivity;

  if (!last) {
    status.state = 'idle';
  } else if (last.kind === 'interrupt') {
    status.state = 'interrupted';
  } else if (last.kind === 'error') {
    status.state = 'error';
    status.detail = acc.errorText;
  } else if (ask) {
    status.state = 'question';
    const { question, options: opts } = questionOf(ask.input);
    status.question = question;
    status.options = opts;
    status.hasQuestion = true;
    status.since = ask.at ?? status.since;
  } else if (plan) {
    status.state = 'plan';
    status.detail = planTitle(plan.input);
    status.since = plan.at ?? status.since;
  } else if (
    pending.length > 0 &&
    (last.kind === 'assistant' || last.kind === 'tool_result')
  ) {
    // tool calls without results: running, or waiting for permission
    const asking = pending.find(p => ALWAYS_ASKS.has(p.name));
    const stalled = pending
      .filter(p => !NEVER_ASKS.has(p.name) && p.at !== null)
      .sort((a, b) => (a.at as number) - (b.at as number))[0];
    // nothing written since the call (or since the last result)
    const quietSince = stalled
      ? Math.max(stalled.at as number, last.at ?? 0)
      : null;
    if (asking) {
      status.state = 'permission';
      status.since = asking.at ?? status.since;
      status.tool = describeTool(asking.name, asking.input);
    } else if (
      stalled &&
      quietSince !== null &&
      now - quietSince >= permissionDelay &&
      acc.permissionMode !== 'bypassPermissions' &&
      !subagentBusy &&
      live?.status !== 'busy'
    ) {
      status.state = 'permission';
      status.confident = false;
      status.since = stalled.at;
      status.tool = describeTool(stalled.name, stalled.input);
    } else {
      status.state = 'working';
      status.since = turnStart;
    }
  } else if (last.kind === 'assistant') {
    const stop = acc.lastStop;
    if (stop === null || stop === 'pause_turn' || stop === 'tool_use') {
      status.state = 'working'; // still streaming
      status.since = turnStart;
    } else {
      status.state = 'done';
      const question = trailingQuestion(acc.responseText.join('\n'));
      status.hasQuestion = !!question;
      status.question = question;
    }
  } else if (last.kind === 'command_done') {
    status.state = 'done';
  } else {
    // prompt, tool result or API retry: Claude's move
    status.state = 'working';
    status.since = turnStart;
    if (last.kind === 'retry' && acc.retry) {
      status.detail = `API retry ${acc.retry.attempt}/${acc.retry.max}`;
    }
  }

  // The live registry (written by Claude Code itself) beats inference
  if (live?.status === 'waiting') {
    if (status.state !== 'question' && status.state !== 'plan') {
      if (live.waitingFor === 'input needed') {
        status.state = 'question';
        status.hasQuestion = true;
        status.detail = live.waitingFor;
        status.since = live.statusUpdatedAt ?? status.since;
      } else if (live.waitingFor !== 'dialog open') {
        status.state = 'permission';
        status.confident = true;
        status.detail = status.tool ? null : (live.waitingFor ?? null);
        status.since = live.statusUpdatedAt ?? status.since;
      }
    }
  } else if (live?.status === 'busy') {
    if (
      status.state === 'done' ||
      status.state === 'interrupted' ||
      status.state === 'error' ||
      status.state === 'idle'
    ) {
      status.state = 'working';
      status.background = true;
      status.hasQuestion = false;
      status.question = null;
      status.since = live.statusUpdatedAt ?? status.since;
    }
  } else if (
    live &&
    (status.state === 'working' ||
      (status.state === 'permission' && !status.confident)) &&
    live.statusUpdatedAt !== undefined &&
    acc.lastActivity !== null &&
    live.statusUpdatedAt > acc.lastActivity + 5_000
  ) {
    // Claude Code went idle after the last write without finishing the
    // turn (e.g. Esc while streaming): nothing is running any more
    status.state = 'interrupted';
    status.confident = true;
    status.since = live.statusUpdatedAt;
  } else if (!live && status.state === 'done' && subagentAt !== null) {
    // background subagents still writing after the turn ended
    if (
      now - subagentAt < SUBAGENT_ACTIVE_MS &&
      (acc.lastActivity === null || subagentAt > acc.lastActivity)
    ) {
      status.state = 'working';
      status.background = true;
      status.since = acc.lastActivity;
    }
  }

  // time-based decay
  const age = acc.lastActivity === null ? Infinity : now - acc.lastActivity;
  const liveBusy = live?.status === 'busy';
  const liveWaiting = live?.status === 'waiting';
  if (
    (status.state === 'done' ||
      status.state === 'interrupted' ||
      status.state === 'error') &&
    age > idleMs
  ) {
    status.state = 'idle';
    status.hasQuestion = false;
  } else if (
    status.state === 'working' &&
    !liveBusy &&
    !subagentBusy &&
    age > STALE_WORKING_MS
  ) {
    status.state = 'idle';
    status.background = false;
  } else if (
    ATTENTION_STATES.has(status.state) &&
    !liveWaiting &&
    age > STALE_WAITING_MS
  ) {
    status.state = 'idle';
    status.hasQuestion = false;
  }
  if (status.state === 'idle') status.since = acc.lastActivity;

  return status;
}

/**
 * Picks the session to show from candidates ordered most recent first: the
 * most recent one that needs the user, else the most recent one. `others`
 * counts the remaining sessions that are working or need the user.
 */
export function pickSession<T extends { status: SessionStatus }>(
  candidates: T[]
): { chosen: T | null; others: number } {
  const chosen =
    candidates.find(c => ATTENTION_STATES.has(c.status.state)) ??
    candidates[0] ??
    null;
  const others = candidates.filter(
    c =>
      c !== chosen &&
      (c.status.state === 'working' || ATTENTION_STATES.has(c.status.state))
  ).length;
  return { chosen, others };
}
