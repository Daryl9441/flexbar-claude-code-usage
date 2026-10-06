/**
 * A small protobuf wire-format reader for the `raw_summary` column of
 * Antigravity's conversation_summaries.db: a serialized
 * `exa.jetski_cortex_pb.CascadeTrajectorySummary` (Antigravity reads it back
 * with RecordToSummary, falling back to the plain columns). Only the fields
 * the session key needs are decoded, into the same shape the language
 * server's Connect-JSON answer has (lowerCamelCase names, enums as their
 * names, timestamps as RFC 3339 strings), so one normaliser
 * (./sessionSummary.ts) reads both. Unknown fields and fields with an
 * unexpected wire type are skipped, never fatal. Pure; never logs.
 *
 * Field numbers: the FileDescriptorProtos embedded in Antigravity's
 * language server (jetski_cortex.proto, cortex.proto, gemini_coder.proto).
 */

type Kind = 'string' | 'bool' | 'uint' | 'enum' | 'timestamp' | 'message';

type Field = {
  name: string;
  kind: Kind;
  repeated?: boolean;
  /** kind 'message': the nested message's fields */
  fields?: Schema;
  /** kind 'enum': value names by number (others stay numbers) */
  names?: Readonly<Record<number, string>>;
};

type Schema = Readonly<Record<number, Field>>;

const RUN_STATUS: Record<number, string> = {
  0: 'CASCADE_RUN_STATUS_UNSPECIFIED',
  1: 'CASCADE_RUN_STATUS_IDLE',
  2: 'CASCADE_RUN_STATUS_RUNNING',
  3: 'CASCADE_RUN_STATUS_CANCELING',
  4: 'CASCADE_RUN_STATUS_BUSY',
};

const TRAJECTORY_TYPE: Record<number, string> = {
  0: 'CORTEX_TRAJECTORY_TYPE_UNSPECIFIED',
  4: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
  17: 'CORTEX_TRAJECTORY_TYPE_INTERACTIVE_CASCADE',
};

const TRAJECTORY_SOURCE: Record<number, string> = {
  1: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
  12: 'CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE',
  16: 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT',
  17: 'CORTEX_TRAJECTORY_SOURCE_CLI',
};

const AGENT_MODE: Record<number, string> = {
  1: 'AGENT_MODE_PLANNING',
  2: 'AGENT_MODE_EXECUTION',
  3: 'AGENT_MODE_VERIFICATION',
};

const EMPTY: Schema = {};

const PERMISSION: Schema = {
  1: {
    name: 'resource',
    kind: 'message',
    fields: {
      1: { name: 'action', kind: 'string' },
      2: { name: 'target', kind: 'string' },
    },
  },
  4: { name: 'reason', kind: 'string' },
  5: { name: 'actionDescription', kind: 'string' },
};

const ASK_QUESTION: Schema = {
  1: {
    name: 'questions',
    kind: 'message',
    repeated: true,
    fields: {
      1: { name: 'question', kind: 'string' },
      2: {
        name: 'options',
        kind: 'message',
        repeated: true,
        fields: {
          1: { name: 'id', kind: 'string' },
          2: { name: 'text', kind: 'string' },
        },
      },
    },
  },
};

/** exa.cortex_pb.RequestedInteraction (a oneof: one field is set) */
const REQUESTED_INTERACTION: Schema = {
  2: { name: 'deploy', kind: 'message', fields: EMPTY },
  3: { name: 'runCommand', kind: 'message', fields: EMPTY },
  4: { name: 'openBrowserUrl', kind: 'message', fields: EMPTY },
  5: { name: 'runExtensionCode', kind: 'message', fields: EMPTY },
  7: { name: 'executeBrowserJavascript', kind: 'message', fields: EMPTY },
  8: { name: 'captureBrowserScreenshot', kind: 'message', fields: EMPTY },
  9: { name: 'clickBrowserPixel', kind: 'message', fields: EMPTY },
  13: { name: 'browserAction', kind: 'message', fields: EMPTY },
  14: { name: 'openBrowserSetup', kind: 'message', fields: EMPTY },
  15: { name: 'confirmBrowserSetup', kind: 'message', fields: EMPTY },
  16: { name: 'sendCommandInput', kind: 'message', fields: EMPTY },
  17: { name: 'readUrlContent', kind: 'message', fields: EMPTY },
  18: { name: 'mcp', kind: 'message', fields: EMPTY },
  19: {
    name: 'filePermission',
    kind: 'message',
    fields: { 1: { name: 'absolutePathUri', kind: 'string' } },
  },
  20: {
    name: 'elicitation',
    kind: 'message',
    fields: { 3: { name: 'message', kind: 'string' } },
  },
  21: { name: 'permission', kind: 'message', fields: PERMISSION },
  22: { name: 'askQuestion', kind: 'message', fields: ASK_QUESTION },
  23: { name: 'approvalInteraction', kind: 'message', fields: EMPTY },
};

/** gemini_coder.Step, only the parts the key reads */
const STEP: Schema = {
  56: {
    name: 'requestedInteraction',
    kind: 'message',
    fields: REQUESTED_INTERACTION,
  },
  28: {
    name: 'runCommand',
    kind: 'message',
    fields: { 23: { name: 'commandLine', kind: 'string' } },
  },
  93: {
    name: 'taskBoundary',
    kind: 'message',
    fields: {
      1: { name: 'taskName', kind: 'string' },
      2: { name: 'taskStatus', kind: 'string' },
      5: { name: 'mode', kind: 'enum', names: AGENT_MODE },
    },
  },
  94: {
    name: 'notifyUser',
    kind: 'message',
    fields: { 3: { name: 'isBlocking', kind: 'bool' } },
  },
  154: { name: 'askQuestion', kind: 'message', fields: ASK_QUESTION },
};

const STEP_WITH_INDEX: Schema = {
  1: { name: 'step', kind: 'message', fields: STEP },
  2: { name: 'stepIndex', kind: 'uint' },
};

const WORKSPACE: Schema = {
  1: { name: 'workspaceFolderAbsoluteUri', kind: 'string' },
  4: { name: 'branchName', kind: 'string' },
};

/** exa.jetski_cortex_pb.CascadeTrajectorySummary */
export const SUMMARY_SCHEMA: Schema = {
  1: { name: 'summary', kind: 'string' },
  2: { name: 'stepCount', kind: 'uint' },
  3: { name: 'lastModifiedTime', kind: 'timestamp' },
  5: { name: 'status', kind: 'enum', names: RUN_STATUS },
  7: { name: 'createdTime', kind: 'timestamp' },
  8: {
    name: 'waitingSteps',
    kind: 'message',
    repeated: true,
    fields: STEP_WITH_INDEX,
  },
  9: {
    name: 'workspaces',
    kind: 'message',
    repeated: true,
    fields: WORKSPACE,
  },
  10: { name: 'lastUserInputTime', kind: 'timestamp' },
  12: {
    name: 'latestNotifyUserStep',
    kind: 'message',
    fields: STEP_WITH_INDEX,
  },
  14: {
    name: 'latestTaskBoundaryStep',
    kind: 'message',
    fields: STEP_WITH_INDEX,
  },
  15: {
    name: 'annotations',
    kind: 'message',
    fields: {
      1: { name: 'title', kind: 'string' },
      4: { name: 'archived', kind: 'bool' },
    },
  },
  16: { name: 'lastUserInputStepIndex', kind: 'uint' },
  17: {
    name: 'trajectoryMetadata',
    kind: 'message',
    fields: {
      1: {
        name: 'workspaces',
        kind: 'message',
        repeated: true,
        fields: WORKSPACE,
      },
      5: { name: 'parentConversationId', kind: 'string' },
      7: { name: 'workspaceUris', kind: 'string', repeated: true },
      16: { name: 'isBattleModeFork', kind: 'bool' },
    },
  },
  18: { name: 'hasActiveChildren', kind: 'bool' },
  20: { name: 'source', kind: 'enum', names: TRAJECTORY_SOURCE },
  21: { name: 'notFullyIdle', kind: 'bool' },
  22: { name: 'trajectoryType', kind: 'enum', names: TRAJECTORY_TYPE },
  23: { name: 'killed', kind: 'bool' },
  25: { name: 'interrupted', kind: 'bool' },
};

/** Deepest nesting followed (the schema is 6 levels deep) */
const MAX_DEPTH = 12;

class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    readonly end: number = buf.length
  ) {}

  /** A varint as a number (exact up to 2^53; larger ones lose precision). */
  varint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('truncated varint');
      const byte = this.buf[this.pos++];
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error('varint too long');
  }

  bytes(): Uint8Array {
    const length = this.varint();
    if (length > this.end - this.pos) throw new Error('truncated field');
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wireType: number) {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.advance(8);
        return;
      case 2:
        this.bytes();
        return;
      case 5:
        this.advance(4);
        return;
      default:
        // groups (3/4) are not used by these messages
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }

  private advance(n: number) {
    if (n > this.end - this.pos) throw new Error('truncated field');
    this.pos += n;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** google.protobuf.Timestamp {seconds = 1, nanos = 2} as RFC 3339, or null. */
function timestampOf(bytes: Uint8Array): string | null {
  const r = new Reader(bytes);
  let seconds = 0;
  let nanos = 0;
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 0) seconds = r.varint();
    else if (field === 2 && wire === 0) nanos = r.varint();
    else r.skip(wire);
  }
  const ms = seconds * 1000 + Math.floor(nanos / 1e6);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return null;
  return new Date(ms).toISOString();
}

const WIRE: Record<Kind, number> = {
  string: 2,
  bool: 0,
  uint: 0,
  enum: 0,
  timestamp: 2,
  message: 2,
};

function decodeMessage(
  bytes: Uint8Array,
  schema: Schema,
  depth: number
): Record<string, unknown> {
  if (depth > MAX_DEPTH) throw new Error('message nested too deeply');
  const out: Record<string, unknown> = {};
  const r = new Reader(bytes);
  while (r.pos < r.end) {
    const tag = r.varint();
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    const field = schema[number];
    // unknown field, or not the wire type its declaration uses: skip it
    if (!field || WIRE[field.kind] !== wire) {
      r.skip(wire);
      continue;
    }
    let value: unknown;
    switch (field.kind) {
      case 'string':
        value = utf8.decode(r.bytes());
        break;
      case 'bool':
        value = r.varint() !== 0;
        break;
      case 'uint':
        value = r.varint();
        break;
      case 'enum': {
        const n = r.varint();
        value = field.names?.[n] ?? n;
        break;
      }
      case 'timestamp':
        value = timestampOf(r.bytes());
        break;
      case 'message':
        value = decodeMessage(r.bytes(), field.fields ?? EMPTY, depth + 1);
        break;
    }
    if (value === null) continue;
    if (field.repeated) {
      const list = (out[field.name] as unknown[] | undefined) ?? [];
      list.push(value);
      out[field.name] = list;
    } else {
      out[field.name] = value; // the last one wins, as in protobuf
    }
  }
  return out;
}

/**
 * A serialized CascadeTrajectorySummary in its JSON shape, or null when the
 * bytes are not one (truncated, or nothing the key knows in it).
 */
export function decodeSummary(
  bytes: Uint8Array | null | undefined
): Record<string, unknown> | null {
  if (!bytes || bytes.length === 0) return null;
  try {
    const summary = decodeMessage(bytes, SUMMARY_SCHEMA, 0);
    const known =
      'lastModifiedTime' in summary ||
      'status' in summary ||
      'stepCount' in summary;
    return known ? summary : null;
  } catch {
    return null;
  }
}
