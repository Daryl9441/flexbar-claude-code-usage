/**
 * Gemini CLI session files, read into a compact form, and the session
 * status derived from them. Pure: no fs, no processes (sessionMonitor.ts
 * reads the files, sessionProcs.ts supplies the live process signals).
 *
 * Two formats exist:
 * - Gemini CLI 0.36: `tmp/<project>/chats/session-<UTC minute>-<id8>.json`,
 *   one pretty-printed JSON document `{sessionId, projectHash, startTime,
 *   lastUpdated, messages[], kind, summary?}`, rewritten (not atomically) on
 *   every change and created only with the first message.
 * - Newer releases: the same name with `.jsonl`, append-only. The first
 *   line is the metadata, message lines carry an `id` (a re-appended id
 *   replaces the message in place), `$set` merges metadata, `$rewindTo`
 *   drops a message and everything after it, `$patch` updates content or
 *   removes/reorders messages. Subagents write to `chats/<parentId>/`.
 *
 * Only what the key needs is kept: no tool output, no thoughts, and only a
 * clipped piece of each text (the prompt for the title, the end of a reply
 * for a trailing question, the first line of an error).
 */
import {
  ATTENTION_STATES,
  PERMISSION_DELAY_MS,
  Progress,
  STALE_WAITING_MS,
  STALE_WORKING_MS,
  SUBAGENT_ACTIVE_MS,
  SessionStatus,
  trailingQuestion,
} from '../../session';
import { makeStatus } from '../kit';

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

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : text;
}

/** The last `max` characters (code points) of a text. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(chars.length - max).join('') : text;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .find(Boolean) ?? ''
  );
}

/**
 * The text of a message's content: a string, a Part, or a Part list
 * (`[{text}]`); thought parts and non-text parts are left out.
 */
export function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map(part => {
      if (typeof part === 'string') return part;
      if (!isObj(part) || part.thought === true) return '';
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

// --- compact messages ----------------------------------------------------------

export type TodoStatus =
  'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';

export type TodoItem = { description: string; status: TodoStatus };

export type ToolCallInfo = {
  name: string;
  /** success | error | cancelled once recorded; newer releases may add others */
  status: string;
  /** write_todos: the list it wrote */
  todos: TodoItem[] | null;
};

export type CompactMessage = {
  id: string | null;
  /** user | gemini | info | warning | error (others are kept and ignored) */
  type: string;
  at: number | null;
  /**
   * user: the prompt as typed, on one line (clipped); gemini: the end of the
   * reply text; info/warning/error: the first line.
   */
  text: string;
  toolCalls: ToolCallInfo[] | null;
};

const PROMPT_CHARS = 300;
const REPLY_CHARS = 2_000;
const LINE_CHARS = 300;

const TODO_STATUSES = new Set<string>([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
]);

function parseTodos(args: unknown): TodoItem[] | null {
  if (!isObj(args) || !Array.isArray(args.todos)) return null;
  const todos: TodoItem[] = [];
  for (const item of args.todos) {
    if (!isObj(item) || typeof item.status !== 'string') continue;
    if (!TODO_STATUSES.has(item.status)) continue;
    todos.push({
      description: oneLine(str(item.description) ?? ''),
      status: item.status as TodoStatus,
    });
  }
  return todos;
}

function compactToolCalls(value: unknown): ToolCallInfo[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isObj).map(call => {
    const name = str(call.name) ?? '';
    return {
      name,
      status: str(call.status) ?? 'success',
      todos: name === 'write_todos' ? parseTodos(call.args) : null,
    };
  });
}

function compactText(type: string, raw: Obj): string {
  switch (type) {
    case 'user': {
      // what the user typed (before @file expansion) when it differs
      const shown =
        raw.displayContent !== undefined && raw.displayContent !== null
          ? partsText(raw.displayContent)
          : '';
      const text = oneLine(shown || partsText(raw.content));
      return clip(text, PROMPT_CHARS);
    }
    case 'gemini':
      return tail(partsText(raw.content).trim(), REPLY_CHARS);
    default:
      return clip(firstLine(partsText(raw.content)), LINE_CHARS);
  }
}

/** One message record in compact form, or null when it is not one. */
export function compactMessage(raw: unknown): CompactMessage | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const type = raw.type;
  return {
    id: str(raw.id),
    type,
    at: parseTime(raw.timestamp),
    text: compactText(type, raw),
    toolCalls: type === 'gemini' ? compactToolCalls(raw.toolCalls) : null,
  };
}

// --- transcripts -----------------------------------------------------------------

export type TranscriptMeta = {
  sessionId: string | null;
  projectHash: string | null;
  startTime: number | null;
  lastUpdated: number | null;
  /** main | subagent (missing in old files: main) */
  kind: string | null;
  summary: string | null;
};

function emptyMeta(): TranscriptMeta {
  return {
    sessionId: null,
    projectHash: null,
    startTime: null,
    lastUpdated: null,
    kind: null,
    summary: null,
  };
}

function mergeMeta(meta: TranscriptMeta, raw: Obj) {
  if ('sessionId' in raw) meta.sessionId = str(raw.sessionId) ?? meta.sessionId;
  if ('projectHash' in raw) {
    meta.projectHash = str(raw.projectHash) ?? meta.projectHash;
  }
  if ('startTime' in raw) {
    meta.startTime = parseTime(raw.startTime) ?? meta.startTime;
  }
  if ('lastUpdated' in raw) {
    meta.lastUpdated = parseTime(raw.lastUpdated) ?? meta.lastUpdated;
  }
  if ('kind' in raw) meta.kind = str(raw.kind) ?? meta.kind;
  if ('summary' in raw) {
    const summary = str(raw.summary);
    meta.summary = summary ? clip(oneLine(summary), PROMPT_CHARS) : null;
  }
}

/** A session's metadata and messages in compact form. */
export class GeminiTranscript {
  meta: TranscriptMeta = emptyMeta();
  messages: CompactMessage[] = [];

  /** A 0.36 session document (the whole `.json` file, parsed). */
  static fromDocument(doc: unknown): GeminiTranscript {
    const t = new GeminiTranscript();
    if (!isObj(doc)) return t;
    mergeMeta(t.meta, doc);
    if (Array.isArray(doc.messages)) {
      for (const raw of doc.messages) {
        const message = compactMessage(raw);
        if (message) t.messages.push(message);
      }
    }
    return t;
  }

  private indexOf(id: string): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].id === id) return i;
    }
    return -1;
  }

  /** Applies one JSONL record (metadata, message, $set, $patch, $rewindTo). */
  applyRecord(record: unknown): void {
    if (!isObj(record)) return;
    if (typeof record.$rewindTo === 'string') {
      const index = this.indexOf(record.$rewindTo);
      if (index >= 0) this.messages.splice(index);
      return;
    }
    if (isObj(record.$patch)) {
      this.applyPatch(record.$patch);
      return;
    }
    if (typeof record.id === 'string' && typeof record.type === 'string') {
      const message = compactMessage(record);
      if (!message) return;
      const index = this.indexOf(record.id);
      if (index >= 0) this.messages[index] = message;
      else this.messages.push(message);
      return;
    }
    if (isObj(record.$set)) {
      mergeMeta(this.meta, record.$set);
      if (Array.isArray(record.$set.messages)) {
        this.messages = record.$set.messages
          .map(compactMessage)
          .filter((m): m is CompactMessage => m !== null);
      }
      return;
    }
    if (typeof record.sessionId === 'string') {
      mergeMeta(this.meta, record);
      if (Array.isArray(record.messages)) {
        this.messages = record.messages
          .map(compactMessage)
          .filter((m): m is CompactMessage => m !== null);
      }
    }
  }

  private applyPatch(patch: Obj) {
    if (Array.isArray(patch.updates)) {
      for (const update of patch.updates) {
        if (!isObj(update) || typeof update.id !== 'string') continue;
        const index = this.indexOf(update.id);
        if (index < 0 || !('content' in update)) continue;
        const message = this.messages[index];
        this.messages[index] = {
          ...message,
          text: compactText(message.type, { content: update.content }),
        };
      }
    }
    if (Array.isArray(patch.removeIds)) {
      const removed = new Set(
        patch.removeIds.filter(id => typeof id === 'string')
      );
      this.messages = this.messages.filter(m => !m.id || !removed.has(m.id));
    }
    if (Array.isArray(patch.orderIds)) {
      const order = new Map<string, number>();
      patch.orderIds.forEach((id, i) => {
        if (typeof id === 'string') order.set(id, i);
      });
      const rank = (m: CompactMessage) =>
        m.id !== null && order.has(m.id) ? (order.get(m.id) as number) : -1;
      // stable: messages missing from the order keep their place up front
      this.messages = this.messages
        .map((m, i) => ({ m, i }))
        .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
        .map(({ m }) => m);
    }
  }

  /** Applies the complete JSONL lines of a chunk; bad lines are skipped. */
  applyLines(text: string): void {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // a partial line or a corrupt record
      }
      this.applyRecord(record);
    }
  }
}

/**
 * Parses a 0.36 session document. Null when it is not complete JSON (the
 * CLI rewrites the file in place, so a read can catch it half written).
 * The error never leaves this function (its message would quote the file).
 */
export function parseDocument(text: string): GeminiTranscript | null {
  try {
    const doc: unknown = JSON.parse(text);
    return isObj(doc) ? GeminiTranscript.fromDocument(doc) : null;
  } catch {
    return null;
  }
}

/** Start of a message in a 0.36 document (pretty-printed, 2-space indent). */
const MESSAGE_START = '\n    {\n';
/** End of the messages array. */
const MESSAGES_END = '\n  ]';

/**
 * The complete message objects in a slice of a 0.36 document (the head or
 * the tail of a file too big to parse whole). Objects cut by the slice are
 * skipped.
 */
export function sliceMessages(text: string): CompactMessage[] {
  const out: CompactMessage[] = [];
  let start = text.indexOf(MESSAGE_START);
  while (start >= 0) {
    const next = text.indexOf(MESSAGE_START, start + 1);
    let chunk = text.slice(start + 1, next >= 0 ? next : undefined);
    const end = chunk.indexOf(MESSAGES_END);
    if (end >= 0) chunk = chunk.slice(0, end);
    chunk = chunk.trim().replace(/,$/, '');
    try {
      const message = compactMessage(JSON.parse(chunk));
      if (message) out.push(message);
    } catch {
      // cut off by the slice
    }
    if (next < 0 || end >= 0) break;
    start = next;
  }
  return out;
}

/**
 * Reads a 0.36 document from its first and last bytes only: header fields
 * and the first prompt from the head, the latest messages and the trailing
 * fields (kind, summary) from the tail. Null when the slices do not look
 * like a session document.
 */
export function parseDocumentSlices(
  head: string,
  tailText: string
): GeminiTranscript | null {
  const t = new GeminiTranscript();
  const header: Obj = {};
  for (const key of ['sessionId', 'projectHash', 'startTime', 'lastUpdated']) {
    const match = new RegExp(`\\n  "${key}": "([^"\\\\]*)"`).exec(head);
    if (match) header[key] = match[1];
  }
  if (!header.sessionId) return null;
  mergeMeta(t.meta, header);
  // trailing fields after the messages array (whose end is the first
  // top-level "]" after the last message; `directories` may follow)
  const lastStart = tailText.lastIndexOf(MESSAGE_START);
  const end = tailText.indexOf(MESSAGES_END, Math.max(0, lastStart));
  if (end >= 0) {
    const rest = tailText.slice(end + MESSAGES_END.length).replace(/^,/, '');
    try {
      const trailer: unknown = JSON.parse(`{${rest.trim().replace(/}$/, '')}}`);
      if (isObj(trailer)) mergeMeta(t.meta, trailer);
    } catch {
      // no trailer yet (file being written)
    }
  }
  const first = sliceMessages(head).find(m => m.type === 'user');
  const latest = sliceMessages(tailText);
  if (latest.length === 0) return null;
  // the first prompt keeps the title; the tail decides the state
  t.messages = first && !latest.some(m => m.id === first.id) ? [first] : [];
  t.messages.push(...latest);
  return t;
}

// --- facts -------------------------------------------------------------------------

/** What the last message that matters for the state says. */
export type LastKind =
  /** A prompt was sent: the model's move */
  | 'prompt'
  /** Tool calls finished (results go back to the model) or still run */
  | 'tools'
  /** A newer release recorded a tool call waiting for approval */
  | 'awaiting'
  /** A reply without text or recorded tool calls: a tool call is pending */
  | 'tool-pending'
  /** A reply with text and no tool calls: the turn is over */
  | 'reply'
  /** Esc, a rejected tool call, or a stop by a hook */
  | 'cancel'
  | 'error';

export type GeminiFacts = {
  sessionId: string | null;
  projectHash: string | null;
  kind: string | null;
  title: string | null;
  last: { kind: LastKind; at: number | null } | null;
  /** The end of the last reply (for a trailing question) */
  replyText: string | null;
  errorText: string | null;
  progress: Progress | null;
  turnStartedAt: number | null;
  lastActivity: number | null;
  startTime: number | null;
  messages: number;
};

const CANCEL_RE =
  /^(Request cancelled|User cancelled the request|Operation cancelled)\.?$|^Agent execution (stopped|blocked)\b/i;

/** Tool call statuses of a finished call; others mean it is still pending. */
const FINAL_STATUSES = new Set(['success', 'error', 'cancelled']);
/** Pending statuses that wait for the user (newer releases, if recorded) */
const AWAITING_STATUSES = new Set(['awaiting_approval', 'awaitingapproval']);

function progressOf(
  todos: TodoItem[] | null,
  progressSeq: number,
  turnSeq: number
): Progress | null {
  const items = (todos ?? []).filter(t => t.status !== 'cancelled');
  if (items.length === 0) return null;
  const completed = items.filter(t => t.status === 'completed').length;
  // a finished list from an earlier turn is history, not progress
  if (completed === items.length && progressSeq < turnSeq) return null;
  const active = items.find(t => t.status === 'in_progress');
  return {
    completed,
    total: items.length,
    active: active?.description || null,
  };
}

/** Folds a transcript into the facts the status is derived from. */
export function factsOf(t: GeminiTranscript): GeminiFacts {
  let last: GeminiFacts['last'] = null;
  let replyText: string | null = null;
  let errorText: string | null = null;
  let turnStartedAt: number | null = null;
  let lastActivity: number | null = null;
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let todos: TodoItem[] | null = null;
  let seq = 0;
  let turnSeq = 0;
  let progressSeq = 0;

  for (const m of t.messages) {
    seq++;
    const at = m.at;
    if (at !== null && (lastActivity === null || at > lastActivity)) {
      lastActivity = at;
    }
    switch (m.type) {
      case 'user': {
        turnSeq = seq;
        last = { kind: 'prompt', at };
        turnStartedAt = at ?? turnStartedAt;
        replyText = null;
        errorText = null;
        const prompt = m.text || null;
        if (prompt) {
          lastPrompt = prompt;
          // the CLI's own rule: slash commands and ? help are no titles
          if (!firstPrompt && !/^[/?]/.test(prompt)) firstPrompt = prompt;
        }
        break;
      }
      case 'gemini': {
        const calls = m.toolCalls ?? [];
        for (const call of calls) {
          if (call.todos && call.status === 'success') {
            todos = call.todos;
            progressSeq = seq;
          }
        }
        if (calls.length > 0) {
          if (calls.some(c => AWAITING_STATUSES.has(c.status.toLowerCase()))) {
            last = { kind: 'awaiting', at };
          } else if (calls.every(c => c.status === 'cancelled')) {
            last = { kind: 'cancel', at };
          } else {
            last = { kind: 'tools', at };
          }
          replyText = null;
        } else if (!m.text) {
          last = { kind: 'tool-pending', at };
          replyText = null;
        } else {
          last = { kind: 'reply', at };
          replyText = m.text;
        }
        break;
      }
      case 'error':
        last = { kind: 'error', at };
        errorText = m.text || null;
        break;
      case 'info':
        if (CANCEL_RE.test(m.text.trim())) last = { kind: 'cancel', at };
        break;
      default:
        // warnings, compression notices, command output: no state change
        break;
    }
  }
  const updated = t.meta.lastUpdated;
  if (updated !== null && (lastActivity === null || updated > lastActivity)) {
    lastActivity = updated;
  }
  const title = t.meta.summary ?? firstPrompt ?? lastPrompt;
  return {
    sessionId: t.meta.sessionId,
    projectHash: t.meta.projectHash,
    kind: t.meta.kind,
    title: title ? clip(oneLine(title), 200) : null,
    last,
    replyText,
    errorText: errorText ? clip(errorText, 160) : null,
    progress: progressOf(todos, progressSeq, turnSeq),
    turnStartedAt,
    lastActivity,
    startTime: t.meta.startTime,
    messages: t.messages.length,
  };
}

/** True when a tool call status means the call has not finished. */
export function isPendingToolStatus(status: string): boolean {
  return !FINAL_STATUSES.has(status);
}

// --- status ------------------------------------------------------------------------

/** What the process table says about a session (null: not known). */
export type LiveSignal = {
  /** A Gemini CLI process runs this session */
  alive: boolean;
  /** Start of the newest child process of that CLI (a tool), ms */
  toolChildAt: number | null;
  /** --approval-mode / --yolo from the CLI's arguments */
  approvalMode: string | null;
};

/** A CLI gone this long after the last write did not just exit normally. */
export const DEAD_GRACE_MS = 60_000;
/** Process start times have 1 s resolution (ps etime) */
const START_SLACK_MS = 1_500;

export type GeminiDeriveOptions = {
  now: number;
  /** done/interrupted/error turn into idle after this long */
  idleMs: number;
  /** null: no process information (live detection off or unavailable) */
  live: LiveSignal | null;
  /** Newest write to one of the session's subagent files */
  subagentAt?: number | null;
  project: string | null;
  sessionId?: string | null;
  permissionDelayMs?: number;
};

/**
 * The session status from the facts of its file plus the process signals.
 * Gemini CLI writes a reply only once its stream ends and a tool call only
 * once it finished, so "waiting for approval" is a guess (confident:false)
 * from a reply without text that sits there with no tool process running.
 */
export function deriveGeminiStatus(
  f: GeminiFacts,
  options: GeminiDeriveOptions
): SessionStatus {
  const { now, idleMs, live } = options;
  const permissionDelay = options.permissionDelayMs ?? PERMISSION_DELAY_MS;
  const last = f.last;
  const lastAt = last?.at ?? f.lastActivity ?? 0;
  const status = makeStatus({
    state: 'idle',
    progress: f.progress,
    title: f.title,
    project: options.project,
    sessionId: f.sessionId ?? options.sessionId ?? null,
    lastActivity: f.lastActivity,
    turnStartedAt: f.turnStartedAt,
    since: f.lastActivity,
    live: live?.alive === true,
  });
  const turnStart = f.turnStartedAt ?? lastAt;
  const age = f.lastActivity === null ? Infinity : now - f.lastActivity;

  // a tool (or subagent) started after the last reply is running now
  const toolRunning =
    live?.alive === true &&
    live.toolChildAt !== null &&
    live.toolChildAt >= lastAt - START_SLACK_MS &&
    now - live.toolChildAt < STALE_WORKING_MS;
  const subagentAt = options.subagentAt ?? null;
  const subagentBusy =
    subagentAt !== null &&
    now - subagentAt < SUBAGENT_ACTIVE_MS &&
    subagentAt >= lastAt - START_SLACK_MS;
  const busy = toolRunning || subagentBusy;
  // the CLI is known to be gone (not just unknown)
  const gone = live !== null && !live.alive && age > DEAD_GRACE_MS;
  const yolo = live?.approvalMode === 'yolo';

  const working = () => {
    status.state = 'working';
    status.since = turnStart;
  };
  const stopped = () => {
    status.state = 'interrupted';
    status.since = f.lastActivity;
  };

  switch (last?.kind) {
    case undefined:
      status.state = 'idle';
      break;
    case 'prompt':
    case 'tools':
      if (gone) stopped();
      else working();
      break;
    case 'awaiting':
      if (gone) stopped();
      else {
        status.state = 'permission';
        status.since = last.at ?? status.since;
      }
      break;
    case 'tool-pending':
      if (busy || yolo) working();
      else if (gone) stopped();
      else if (now - Math.max(lastAt, f.lastActivity ?? 0) >= permissionDelay) {
        status.state = 'permission';
        status.confident = false;
        status.since = last.at ?? status.since;
      } else working();
      break;
    case 'reply':
      if (busy) working();
      else {
        status.state = 'done';
        status.since = last.at ?? status.since;
        const question = trailingQuestion(f.replyText);
        status.hasQuestion = !!question;
        status.question = question;
      }
      break;
    case 'cancel':
      status.state = 'interrupted';
      status.since = last.at ?? status.since;
      break;
    case 'error':
      status.state = 'error';
      status.detail = f.errorText;
      status.since = last.at ?? status.since;
      break;
  }

  // time-based decay, as for Claude Code sessions
  if (
    (status.state === 'done' ||
      status.state === 'interrupted' ||
      status.state === 'error') &&
    age > idleMs
  ) {
    status.state = 'idle';
    status.hasQuestion = false;
    status.question = null;
  } else if (status.state === 'working' && !busy && age > STALE_WORKING_MS) {
    status.state = 'idle';
  } else if (ATTENTION_STATES.has(status.state) && age > STALE_WAITING_MS) {
    status.state = 'idle';
  }
  if (status.state === 'idle') status.since = f.lastActivity;
  return status;
}

/**
 * A Gemini CLI that runs but has not recorded a message yet (0.36 creates
 * the file with the first prompt): idle, named by its folder.
 */
export function freshStatus(options: {
  project: string | null;
  startedAt: number;
  title: string | null;
}): SessionStatus {
  return makeStatus({
    state: 'idle',
    title: options.title,
    project: options.project,
    lastActivity: options.startedAt,
    since: options.startedAt,
    live: true,
  });
}
