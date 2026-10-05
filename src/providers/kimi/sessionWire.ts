/**
 * Kimi Code session status from its turn journal (`agents/main/wire.jsonl`,
 * one JSON record per line, appended while the session runs). Pure: no fs
 * access; sessionTail.ts feeds lines in.
 *
 * Kimi Code 2.x (wire protocol 1.5) writes durable `turn.prompt`,
 * `turn.ended`, `interaction.request`/`interaction.resolved` records, so a
 * pending question or approval is known, not guessed. Older journals (wire
 * 1.0–1.4: Kimi Code 0.x and the Kimi desktop's embedded kernel) only have
 * the prompt and the loop events (`step.end` finish reasons, tool calls and
 * results); for those the state follows from the last step like Claude's.
 *
 * Only what the key shows is kept: tool names with a few short arguments,
 * question texts and the end of the final answer (for a trailing question).
 * Prompts are never stored.
 */
import {
  ATTENTION_STATES,
  PERMISSION_DELAY_MS,
  STALE_WAITING_MS,
  STALE_WORKING_MS,
  SessionStatus,
  describeTool,
  trailingQuestion,
} from '../../session';
import { makeStatus } from '../kit';

import { Obj, clip, isObj, oneLine, str, timeOf } from './sessionFs';

type OpenTool = { name: string; input: Obj; at: number | null };

type OpenInteraction = {
  kind: string;
  toolName: string | null;
  toolCallId: string | null;
  question: string | null;
  options: string[];
  at: number | null;
};

export type WireAcc = {
  /** protocol_version of the metadata line as major * 1000 + minor */
  protocol: number | null;
  /** Saw turn.ended or interaction records (Kimi Code 2.x journals) */
  durable: boolean;
  /** Saw a prompt or a loop step: the tail holds part of a turn */
  sawTurn: boolean;
  turnStartedAt: number | null;
  ended: { reason: string; error: string | null; at: number | null } | null;
  cancelledAt: number | null;
  /** finishReason of the newest step.end of the turn */
  lastFinish: string | null;
  tools: Map<string, OpenTool>;
  interactions: Map<string, OpenInteraction>;
  /** Text of the newest step (the final answer once the turn ends) */
  responseText: string;
  permissionMode: string | null;
  planMode: boolean;
  lastActivity: number | null;
};

export function createWireAcc(): WireAcc {
  return {
    protocol: null,
    durable: false,
    sawTurn: false,
    turnStartedAt: null,
    ended: null,
    cancelledAt: null,
    lastFinish: null,
    tools: new Map(),
    interactions: new Map(),
    responseText: '',
    permissionMode: null,
    planMode: false,
    lastActivity: null,
  };
}

/** The end of the answer is all a trailing question needs. */
const MAX_RESPONSE_CHARS = 4000;

/** Keeps the tool arguments describeTool() uses, short. */
function trimArgs(args: unknown): Obj {
  let input = args;
  if (typeof input === 'string') {
    // some providers stream arguments as a JSON string
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  if (!isObj(input)) return {};
  const keep: Obj = {};
  for (const key of ['description', 'url', 'query', 'pattern', 'skill']) {
    const value = str(input[key]);
    if (value) keep[key] = clip(value, 300);
  }
  const file = str(input.file_path) ?? str(input.path);
  if (file) keep.file_path = clip(file, 300);
  const command = str(input.command);
  if (command) {
    const line = command.split('\n').find(l => l.trim()) ?? '';
    keep.command = clip(line.trim(), 300);
  }
  return keep;
}

/** "Bash: npm test", "Read: parser.ts", "FetchURL: example.com" */
export function describeKimiTool(name: string, input: Obj = {}): string {
  if (name === 'FetchURL') {
    const text = describeTool('WebFetch', input);
    return text.replace(/^WebFetch/, 'FetchURL');
  }
  return describeTool(name, input);
}

function questionOf(request: unknown): {
  question: string | null;
  options: string[];
} {
  if (!isObj(request)) return { question: null, options: [] };
  const questions = Array.isArray(request.questions) ? request.questions : [];
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
        .map(o => clip(oneLine(o), 120))
    : [];
  return {
    question: question ? clip(oneLine(question), 300) : null,
    options,
  };
}

/** "1.5" → 1005: comparable protocol versions ("1.10" > "1.9"). */
export function protocolOf(value: unknown): number | null {
  const match = `${value ?? ''}`.trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return Number(match[1]) * 1000 + Number(match[2] ?? 0);
}

/** Wire 1.5 (Kimi Code 2.x) records approvals and turn ends. */
const DURABLE_PROTOCOL = 1005;

function startTurn(acc: WireAcc, at: number | null) {
  acc.sawTurn = true;
  acc.turnStartedAt = at ?? acc.turnStartedAt;
  acc.ended = null;
  acc.cancelledAt = null;
  acc.lastFinish = null;
  acc.tools.clear();
  acc.interactions.clear();
  acc.responseText = '';
}

function observeLoopEvent(acc: WireAcc, event: Obj, at: number | null) {
  switch (event.type) {
    case 'step.begin':
      acc.sawTurn = true;
      acc.lastFinish = null;
      acc.responseText = '';
      break;
    case 'content.part': {
      const part = isObj(event.part) ? event.part : null;
      if (part?.type === 'text' && typeof part.text === 'string') {
        acc.responseText = (acc.responseText + part.text).slice(
          -MAX_RESPONSE_CHARS
        );
      }
      break;
    }
    case 'tool.call': {
      const id = str(event.toolCallId);
      const name = str(event.name);
      if (id && name) {
        acc.tools.set(id, { name, input: trimArgs(event.args), at });
      }
      break;
    }
    case 'tool.result': {
      const id = str(event.toolCallId);
      if (id) acc.tools.delete(id);
      break;
    }
    case 'step.end':
      acc.lastFinish = str(event.finishReason) ?? 'unknown';
      break;
  }
}

/** Folds one journal record into the accumulator. */
export function observeWireRecord(acc: WireAcc, record: unknown): void {
  if (!isObj(record)) return;
  const event = isObj(record.event) ? record.event : null;
  const at = timeOf(record.time) ?? (event ? timeOf(event.time) : null);
  if (at !== null && (acc.lastActivity === null || at > acc.lastActivity)) {
    acc.lastActivity = at;
  }
  switch (record.type) {
    case 'metadata': {
      const version = protocolOf(record.protocol_version);
      if (version !== null) acc.protocol = version;
      break;
    }
    case 'turn.prompt':
      startTurn(acc, at);
      break;
    case 'turn.cancel':
      // a cancelled queued prompt leaves the running turn alone
      if (record.target !== 'queued') acc.cancelledAt = at ?? 0;
      break;
    case 'turn.ended': {
      acc.durable = true;
      acc.sawTurn = true;
      const error = isObj(record.error) ? str(record.error.message) : null;
      acc.ended = {
        reason: str(record.reason) ?? 'completed',
        error: error ? clip(oneLine(error), 160) : null,
        at,
      };
      acc.tools.clear();
      acc.interactions.clear();
      break;
    }
    case 'interaction.request': {
      acc.durable = true;
      const id = str(record.id);
      if (!id) break;
      const request = isObj(record.request) ? record.request : {};
      const kind = str(record.kind) ?? 'approval';
      const { question, options } =
        kind === 'question' ? questionOf(request) : questionOf(null);
      acc.interactions.set(id, {
        kind,
        toolName: str(request.toolName),
        toolCallId: str(record.toolCallId) ?? str(request.toolCallId),
        question,
        options,
        at,
      });
      break;
    }
    case 'interaction.resolved': {
      acc.durable = true;
      const id = str(record.id);
      if (id) acc.interactions.delete(id);
      break;
    }
    case 'context.append_loop_event':
      if (event) observeLoopEvent(acc, event, at);
      break;
    case 'permission.set_mode':
      acc.permissionMode = str(record.mode) ?? acc.permissionMode;
      break;
    case 'plan_mode.enter':
      acc.planMode = true;
      break;
    case 'plan_mode.exit':
    case 'plan_mode.cancel':
      acc.planMode = false;
      break;
  }
}

/** Folds the complete lines of a chunk; invalid lines are skipped. */
export function observeWireLines(acc: WireAcc, text: string): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    observeWireRecord(acc, record);
  }
}

/** Tools that never wait for an approval in older journals. */
const NEVER_ASKS = new Set([
  'Read',
  'Glob',
  'Grep',
  'TodoList',
  'Agent',
  'AgentSwarm',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'Skill',
  'WebSearch',
]);

export type WireDeriveOptions = {
  now: number;
  /** done / stopped / error turn into idle after this long */
  idleMs: number;
  /** Fallback activity time (the journal's mtime) */
  mtimeMs?: number | null;
  permissionDelayMs?: number;
};

/** Derives the session status (title and project left empty). */
export function deriveWireStatus(
  acc: WireAcc,
  options: WireDeriveOptions
): SessionStatus {
  const { now, idleMs } = options;
  const lastActivity = acc.lastActivity ?? options.mtimeMs ?? null;
  const tools = [...acc.tools.values()];
  const newestTool = tools[tools.length - 1];
  const status = makeStatus({
    state: 'idle',
    tool: newestTool
      ? describeKimiTool(newestTool.name, newestTool.input)
      : null,
    lastActivity,
    turnStartedAt: acc.turnStartedAt,
    since: lastActivity,
  });
  const turnStart = acc.turnStartedAt ?? lastActivity;
  const open = [...acc.interactions.values()];
  const question = open.find(
    i => i.kind === 'question' || i.toolName === 'AskUserQuestion'
  );
  const plan = open.find(i => i.toolName === 'ExitPlanMode');
  const approval = open.find(i => i.kind === 'approval');
  const finish = acc.lastFinish;

  if (question) {
    status.state = 'question';
    status.hasQuestion = true;
    status.question = question.question;
    status.options = question.options;
    status.since = question.at ?? status.since;
  } else if (plan) {
    status.state = 'plan';
    status.since = plan.at ?? status.since;
  } else if (approval) {
    status.state = 'permission';
    const call = approval.toolCallId
      ? acc.tools.get(approval.toolCallId)
      : null;
    const name = call?.name ?? approval.toolName;
    status.tool = name ? describeKimiTool(name, call?.input) : status.tool;
    status.since = approval.at ?? status.since;
  } else if (acc.ended) {
    const reason = acc.ended.reason;
    if (reason === 'completed') {
      status.state = 'done';
      const asked = trailingQuestion(acc.responseText);
      status.hasQuestion = !!asked;
      status.question = asked;
    } else if (reason === 'cancelled') {
      status.state = 'interrupted';
    } else {
      status.state = 'error';
      status.detail = acc.ended.error;
    }
    status.since = acc.ended.at ?? status.since;
  } else if (acc.cancelledAt !== null) {
    status.state = 'interrupted';
  } else if (!acc.sawTurn) {
    status.state = 'idle';
  } else if (tools.length === 0 && finish === 'interrupted') {
    status.state = 'interrupted';
  } else if (tools.length === 0 && finish === 'error') {
    status.state = 'error';
  } else if (
    tools.length === 0 &&
    finish !== null &&
    finish !== 'tool_use' &&
    finish !== 'unknown'
  ) {
    // end_turn, max_tokens…: the answer is complete
    status.state = 'done';
    const asked = trailingQuestion(acc.responseText);
    status.hasQuestion = !!asked;
    status.question = asked;
  } else {
    status.state = 'working';
    status.since = turnStart;
    // older journals have no approval records: a stalled call in manual
    // mode probably waits for one
    const delay = options.permissionDelayMs ?? PERMISSION_DELAY_MS;
    const stalled = tools
      .filter(t => !NEVER_ASKS.has(t.name) && t.at !== null)
      .sort((a, b) => (a.at as number) - (b.at as number))[0];
    const legacy =
      !acc.durable &&
      (acc.protocol === null || acc.protocol < DURABLE_PROTOCOL);
    if (
      legacy &&
      acc.permissionMode === 'manual' &&
      stalled &&
      now - Math.max(stalled.at as number, lastActivity ?? 0) >= delay
    ) {
      status.state = 'permission';
      status.confident = false;
      status.since = stalled.at;
      status.tool = describeKimiTool(stalled.name, stalled.input);
    }
  }

  return decay(status, now, idleMs);
}

/**
 * Time-based decay shared by every Kimi status: finished states go idle
 * after idleMs, "working" after STALE_WORKING_MS without a write (a killed
 * `kimi` leaves no end record), waiting states after STALE_WAITING_MS.
 */
export function decay(
  status: SessionStatus,
  now: number,
  idleMs: number,
  keepDone = false
): SessionStatus {
  const age =
    status.lastActivity === null ? Infinity : now - status.lastActivity;
  const finished =
    status.state === 'done' ||
    status.state === 'interrupted' ||
    status.state === 'error';
  const kept = keepDone && status.state === 'done' && age <= STALE_WAITING_MS;
  if (finished && age > idleMs && !kept) {
    status.state = 'idle';
    status.hasQuestion = false;
    status.question = null;
  } else if (status.state === 'working' && age > STALE_WORKING_MS) {
    status.state = 'idle';
  } else if (ATTENTION_STATES.has(status.state) && age > STALE_WAITING_MS) {
    status.state = 'idle';
    status.hasQuestion = false;
  }
  if (status.state === 'idle') status.since = status.lastActivity;
  return status;
}
