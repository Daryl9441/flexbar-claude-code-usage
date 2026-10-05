// Tests for the Session Status key's transcript parser, file follower, view
// builder, running-sessions list and key, run against the tsc output (see
// `npm run test:session`). All fixtures are synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.SESSION_TEST_BUILD ?? path.join(here, '..', '.test-build');
const S = require(path.join(build, 'session.js'));
const Src = require(path.join(build, 'sessionSource.js'));
const V = require(path.join(build, 'sessionView.js'));
// rendering needs @napi-rs/canvas; those tests are skipped without it
let R = null;
let K = null;
try {
  R = require(path.join(build, 'sessionRender.js'));
  K = require(path.join(build, 'sessionKey.js'));
} catch {
  R = K = null;
}

// --- fixture helpers -------------------------------------------------------

const T0 = Date.parse('2026-10-05T08:00:00.000Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const base = {
  cwd: '/Users/dev/work/demo-app',
  sessionId: 'sess-1',
  gitBranch: 'main',
  isSidechain: false,
};

const prompt = (text, s) => ({
  ...base,
  type: 'user',
  timestamp: at(s),
  message: { role: 'user', content: text },
});
const userBlocks = (content, s, extra = {}) => ({
  ...base,
  type: 'user',
  timestamp: at(s),
  message: { role: 'user', content },
  ...extra,
});
const result = (id, s, content = 'ok', isError = false) =>
  userBlocks(
    [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    s
  );
const assistant = (blocks, stop, s, msgId = `msg-${s}`, extra = {}) => ({
  ...base,
  type: 'assistant',
  timestamp: at(s),
  requestId: `req-${msgId}`,
  message: {
    id: msgId,
    role: 'assistant',
    model: 'claude-test',
    content: blocks,
    stop_reason: stop,
  },
  ...extra,
});
const text = t => ({ type: 'text', text: t });
const thinking = () => ({ type: 'thinking', thinking: '…' });
const tool = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

function accOf(entries) {
  const acc = S.createAccumulator();
  S.observeLines(acc, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return acc;
}

const IDLE = 15 * 60_000;
function statusOf(entries, nowSeconds, opts = {}) {
  return S.deriveStatus(accOf(entries), {
    now: T0 + nowSeconds * 1000,
    idleMs: IDLE,
    ...opts,
  });
}

// --- states ----------------------------------------------------------------

describe('state', () => {
  test('a new prompt means working', () => {
    const st = statusOf([prompt('Fix the login bug', 0)], 2);
    assert.equal(st.state, 'working');
    assert.equal(st.turnStartedAt, T0);
    assert.equal(st.since, T0);
    assert.equal(st.project, 'demo-app');
    assert.equal(st.branch, 'main');
    assert.equal(st.title, 'Fix the login bug');
  });

  test('a running tool call is working at first', () => {
    const entries = [
      prompt('Run the tests', 0),
      assistant(
        [tool('t1', 'Bash', { command: 'npm test', description: 'Run tests' })],
        'tool_use',
        1
      ),
    ];
    const st = statusOf(entries, 5);
    assert.equal(st.state, 'working');
    assert.equal(st.tool, 'Bash: Run tests');
  });

  test('a tool call stalled for 10s probably waits for permission', () => {
    const entries = [
      prompt('Run the tests', 0),
      assistant([tool('t1', 'Bash', { command: 'npm test' })], 'tool_use', 1),
    ];
    const st = statusOf(entries, 12);
    assert.equal(st.state, 'permission');
    assert.equal(st.confident, false);
    assert.equal(st.tool, 'Bash: npm test');
    assert.equal(st.since, T0 + 1000);
  });

  test('no permission guess in bypassPermissions mode', () => {
    const entries = [
      { ...prompt('Run the tests', 0), permissionMode: 'bypassPermissions' },
      assistant([tool('t1', 'Bash', { command: 'npm test' })], 'tool_use', 1),
    ];
    assert.equal(statusOf(entries, 60).state, 'working');
  });

  test('no permission guess for tools that never ask', () => {
    const entries = [
      prompt('Investigate', 0),
      assistant(
        [tool('t1', 'Agent', { description: 'Explore' })],
        'tool_use',
        1
      ),
    ];
    const st = statusOf(entries, 120);
    assert.equal(st.state, 'working');
    assert.equal(st.tool, 'Agent: Explore');
  });

  test('recent subagent writes suppress the permission guess', () => {
    const entries = [
      prompt('Go', 0),
      assistant([tool('t1', 'Bash', { command: 'make' })], 'tool_use', 1),
    ];
    assert.equal(
      statusOf(entries, 30, { subagentActiveAt: T0 + 25_000 }).state,
      'working'
    );
  });

  test('a partial result does not hide a stalled parallel call', () => {
    const entries = [
      prompt('Go', 0),
      assistant(
        [tool('a', 'Read', { file_path: '/x/a.ts' })],
        'tool_use',
        1,
        'm1'
      ),
      assistant(
        [tool('b', 'Bash', { command: 'rm -rf build' })],
        'tool_use',
        1,
        'm1'
      ),
      result('a', 2),
    ];
    assert.equal(statusOf(entries, 5).state, 'working');
    const st = statusOf(entries, 20);
    assert.equal(st.state, 'permission');
    assert.equal(st.tool, 'Bash: rm -rf build');
  });

  test('a pending AskUserQuestion is a question', () => {
    const entries = [
      prompt('Set it up', 0),
      assistant(
        [
          tool('q1', 'AskUserQuestion', {
            questions: [
              {
                question: '要使用哪个数据库？',
                header: 'DB',
                multiSelect: false,
                options: [
                  { label: 'Postgres', description: 'a' },
                  { label: 'SQLite', description: 'b' },
                ],
              },
            ],
          }),
        ],
        'tool_use',
        3
      ),
      { type: 'last-prompt', lastPrompt: 'Set it up', sessionId: 'sess-1' },
    ];
    const st = statusOf(entries, 400);
    assert.equal(st.state, 'question');
    assert.equal(st.hasQuestion, true);
    assert.equal(st.question, '要使用哪个数据库？');
    assert.deepEqual(st.options, ['Postgres', 'SQLite']);
    assert.equal(st.since, T0 + 3000);
  });

  test('several questions are counted', () => {
    const q = n => ({ question: `Q${n}?`, header: 'h', options: [] });
    const entries = [
      prompt('x', 0),
      assistant(
        [tool('q', 'AskUserQuestion', { questions: [q(1), q(2), q(3)] })],
        'tool_use',
        1
      ),
    ];
    assert.equal(statusOf(entries, 2).question, 'Q1? (+2)');
  });

  test('an answered question goes back to working', () => {
    const entries = [
      prompt('Set it up', 0),
      assistant(
        [
          tool('q1', 'AskUserQuestion', {
            questions: [{ question: 'Which?', options: [] }],
          }),
        ],
        'tool_use',
        1
      ),
      result('q1', 30, 'User has answered your questions: "Which?"="A".'),
    ];
    assert.equal(statusOf(entries, 31).state, 'working');
  });

  test('a pending ExitPlanMode is a plan to review', () => {
    const entries = [
      prompt('Plan the migration', 0),
      assistant(
        [
          tool('p1', 'ExitPlanMode', {
            plan: '\n# **Migrate to Postgres**\n\n1. Dump\n2. Load',
          }),
        ],
        'tool_use',
        2
      ),
    ];
    const st = statusOf(entries, 3);
    assert.equal(st.state, 'plan');
    assert.equal(st.detail, 'Migrate to Postgres');
    assert.equal(st.hasQuestion, false);
  });

  test('EnterPlanMode always waits for the user', () => {
    const entries = [
      prompt('x', 0),
      assistant([tool('e', 'EnterPlanMode', {})], 'tool_use', 1),
    ];
    const st = statusOf(entries, 2);
    assert.equal(st.state, 'permission');
    assert.equal(st.confident, true);
  });

  test('end_turn is done', () => {
    const entries = [
      prompt('Fix it', 0),
      assistant([thinking()], 'end_turn', 10, 'm9'),
      assistant(
        [text('Fixed the bug and added a test.')],
        'end_turn',
        11,
        'm9'
      ),
      {
        type: 'system',
        subtype: 'stop_hook_summary',
        level: 'suggestion',
        timestamp: at(12),
        ...base,
      },
      { type: 'custom-title', customTitle: 'Login fix', sessionId: 'sess-1' },
    ];
    const st = statusOf(entries, 20);
    assert.equal(st.state, 'done');
    assert.equal(st.hasQuestion, false);
    assert.equal(st.title, 'Login fix');
    assert.equal(st.since, T0 + 12_000);
  });

  test('a reply ending in a question is flagged', () => {
    const entries = [
      prompt('Fix it', 0),
      assistant(
        [
          text(
            'I found two causes. The cache is stale.\n\nShould I also clear the CDN cache?'
          ),
        ],
        'end_turn',
        5
      ),
    ];
    const st = statusOf(entries, 6);
    assert.equal(st.state, 'done');
    assert.equal(st.hasQuestion, true);
    assert.equal(st.question, 'Should I also clear the CDN cache?');
  });

  test('a Chinese reply ending in a question is flagged', () => {
    const entries = [
      prompt('修复', 0),
      assistant(
        [text('已经修复了登录问题。要我顺便更新文档吗？')],
        'end_turn',
        5
      ),
    ];
    const st = statusOf(entries, 6);
    assert.equal(st.hasQuestion, true);
    assert.equal(st.question, '要我顺便更新文档吗？');
  });

  test('markdown around a trailing question is ignored', () => {
    const entries = [
      prompt('x', 0),
      assistant(
        [text('Done.\n\n**Want me to open a PR (e.g. against main)?**')],
        'end_turn',
        5
      ),
    ];
    assert.equal(
      statusOf(entries, 6).question,
      'Want me to open a PR (e.g. against main)?'
    );
  });

  test('only the final response counts for the question flag', () => {
    const entries = [
      prompt('x', 0),
      assistant(
        [
          text('Should I check the logs?'),
          tool('t', 'Read', { file_path: '/a' }),
        ],
        'tool_use',
        1,
        'm1'
      ),
      result('t', 2),
      assistant([text('All good, nothing to change.')], 'end_turn', 3, 'm2'),
    ];
    const st = statusOf(entries, 4);
    assert.equal(st.state, 'done');
    assert.equal(st.hasQuestion, false);
  });

  test('a streaming response is working', () => {
    const entries = [prompt('x', 0), assistant([thinking()], null, 1)];
    assert.equal(statusOf(entries, 2).state, 'working');
  });

  test('an interrupt marker is interrupted', () => {
    const entries = [
      prompt('x', 0),
      assistant([tool('t', 'Bash', { command: 'sleep 100' })], 'tool_use', 1),
      result(
        't',
        4,
        "The user doesn't want to proceed with this tool use.",
        true
      ),
      userBlocks([text('[Request interrupted by user for tool use]')], 4),
    ];
    assert.equal(statusOf(entries, 5).state, 'interrupted');
    const plain = [
      prompt('x', 0),
      assistant([thinking()], null, 1),
      prompt('[Request interrupted by user]', 2),
    ];
    assert.equal(statusOf(plain, 3).state, 'interrupted');
  });

  test('an API error message is an error', () => {
    const entries = [
      prompt('x', 0),
      assistant(
        [text('API Error: 529 Overloaded\nretry later')],
        'stop_sequence',
        3,
        'e1',
        { isApiErrorMessage: true }
      ),
    ];
    const st = statusOf(entries, 4);
    assert.equal(st.state, 'error');
    assert.equal(st.detail, 'API Error: 529 Overloaded');
  });

  test('API retries are still working', () => {
    const entries = [
      prompt('x', 0),
      {
        ...base,
        type: 'system',
        subtype: 'api_error',
        level: 'error',
        timestamp: at(2),
        retryAttempt: 3,
        maxRetries: 10,
        retryInMs: 2000,
        error: {},
      },
    ];
    const st = statusOf(entries, 3);
    assert.equal(st.state, 'working');
    assert.equal(st.detail, 'API retry 3/10');
  });

  test('a finished local command is done', () => {
    const entries = [
      prompt(
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
        0
      ),
      prompt(
        '<local-command-stdout>Set model to Opus</local-command-stdout>',
        1
      ),
    ];
    assert.equal(statusOf(entries, 2).state, 'done');
  });

  test('done turns idle after the idle threshold', () => {
    const entries = [prompt('x', 0), assistant([text('ok')], 'end_turn', 1)];
    assert.equal(statusOf(entries, 60).state, 'done');
    const st = statusOf(entries, 16 * 60);
    assert.equal(st.state, 'idle');
    assert.equal(st.since, T0 + 1000);
  });

  test('working with no output for 30 minutes is stale', () => {
    const entries = [
      prompt('x', 0),
      assistant([tool('t', 'Agent', {})], 'tool_use', 1),
    ];
    assert.equal(statusOf(entries, 29 * 60).state, 'working');
    assert.equal(statusOf(entries, 31 * 60).state, 'idle');
  });

  test('a question still counts hours later', () => {
    const entries = [
      prompt('x', 0),
      assistant(
        [
          tool('q', 'AskUserQuestion', {
            questions: [{ question: 'A or B?' }],
          }),
        ],
        'tool_use',
        1
      ),
    ];
    assert.equal(statusOf(entries, 3 * 3600).state, 'question');
    assert.equal(statusOf(entries, 13 * 3600).state, 'idle');
  });

  test('subagent transcripts in the main file are ignored', () => {
    const entries = [
      prompt('x', 0),
      assistant([text('done')], 'end_turn', 5),
      {
        ...assistant([tool('s', 'Bash', {})], 'tool_use', 6),
        isSidechain: true,
      },
    ];
    assert.equal(statusOf(entries, 7).state, 'done');
  });

  test('metadata alone is idle', () => {
    const st = statusOf(
      [{ type: 'custom-title', customTitle: 'Empty', sessionId: 's' }],
      1
    );
    assert.equal(st.state, 'idle');
    assert.equal(st.title, 'Empty');
  });
});

// --- live registry ---------------------------------------------------------

describe('live registry', () => {
  const running = [
    prompt('Deploy', 0),
    assistant(
      [tool('t', 'Bash', { command: 'npm run deploy' })],
      'tool_use',
      1
    ),
  ];

  test('waiting confirms a permission prompt right away', () => {
    const st = statusOf(running, 2, {
      live: {
        status: 'waiting',
        waitingFor: 'permission prompt',
        statusUpdatedAt: T0 + 1500,
      },
    });
    assert.equal(st.state, 'permission');
    assert.equal(st.confident, true);
    assert.equal(st.live, true);
    assert.equal(st.tool, 'Bash: npm run deploy');
  });

  test('busy means a long tool call is just running', () => {
    assert.equal(
      statusOf(running, 300, { live: { status: 'busy' } }).state,
      'working'
    );
  });

  test('busy after the turn ended means background work', () => {
    const entries = [
      prompt('x', 0),
      assistant([text('Started 2 agents.')], 'end_turn', 2),
    ];
    const st = statusOf(entries, 60, {
      live: { status: 'busy', statusUpdatedAt: T0 + 1000 },
    });
    assert.equal(st.state, 'working');
    assert.equal(st.background, true);
  });

  test('idle without a finished turn means it was interrupted', () => {
    const st = statusOf(running, 30, {
      live: { status: 'idle', statusUpdatedAt: T0 + 20_000 },
    });
    assert.equal(st.state, 'interrupted');
  });

  test('a waiting MCP elicitation is a question', () => {
    const entries = [
      prompt('x', 0),
      assistant([tool('m', 'mcp__srv__login', {})], 'tool_use', 1),
    ];
    const st = statusOf(entries, 2, {
      live: { status: 'waiting', waitingFor: 'input needed' },
    });
    assert.equal(st.state, 'question');
    assert.equal(st.tool, 'login');
  });

  test('subagents writing after the turn ended (no registry)', () => {
    const entries = [
      prompt('x', 0),
      assistant([text('Launched in background.')], 'end_turn', 2),
    ];
    assert.equal(
      statusOf(entries, 10, { subagentActiveAt: T0 + 8000 }).state,
      'working'
    );
    assert.equal(
      statusOf(entries, 10, { subagentActiveAt: T0 + 1000 }).state,
      'done'
    );
  });
});

// --- progress --------------------------------------------------------------

describe('progress', () => {
  const todos = items =>
    tool(`todo-${Math.random()}`, 'TodoWrite', { todos: items });
  const item = (content, status) => ({
    content,
    status,
    activeForm: `${content}ing`,
  });

  test('latest TodoWrite gives completed/total and the active item', () => {
    const entries = [
      prompt('x', 0),
      assistant(
        [todos([item('Plan', 'in_progress'), item('Build', 'pending')])],
        'tool_use',
        1
      ),
      assistant(
        [
          todos([
            item('Plan', 'completed'),
            item('Build', 'in_progress'),
            item('Test', 'pending'),
            item('Ship', 'pending'),
          ]),
        ],
        'tool_use',
        5
      ),
    ];
    const st = statusOf(entries, 6);
    assert.deepEqual(st.progress, {
      completed: 1,
      total: 4,
      active: 'Building',
    });
  });

  test('a finished list from an earlier turn is hidden, an unfinished one kept', () => {
    const done = [
      prompt('x', 0),
      assistant(
        [todos([item('A', 'completed'), item('B', 'completed')])],
        'tool_use',
        1
      ),
      assistant([text('ok')], 'end_turn', 2),
    ];
    assert.deepEqual(statusOf(done, 3).progress, {
      completed: 2,
      total: 2,
      active: null,
    });
    assert.equal(statusOf([...done, prompt('next', 4)], 5).progress, null);
    const open = [
      prompt('x', 0),
      assistant(
        [todos([item('A', 'completed'), item('B', 'pending')])],
        'tool_use',
        1
      ),
      prompt('next', 4),
    ];
    assert.deepEqual(statusOf(open, 5).progress, {
      completed: 1,
      total: 2,
      active: null,
    });
  });

  test('TaskCreate/TaskUpdate build a task list', () => {
    const entries = [
      prompt('x', 0),
      assistant(
        [
          tool('c1', 'TaskCreate', {
            subject: 'Write parser',
            activeForm: 'Writing parser',
          }),
        ],
        'tool_use',
        1,
        'm1'
      ),
      assistant(
        [tool('c2', 'TaskCreate', { subject: 'Render key', description: 'd' })],
        'tool_use',
        1,
        'm1'
      ),
      assistant(
        [tool('c3', 'TaskCreate', { subject: 'Obsolete' })],
        'tool_use',
        1,
        'm1'
      ),
      result('c1', 2, 'Task #1 created successfully: Write parser'),
      result('c2', 2, [
        { type: 'text', text: 'Task #2 created successfully: Render key' },
      ]),
      result('c3', 2, 'Task #3 created successfully: Obsolete'),
      assistant(
        [tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })],
        'tool_use',
        3,
        'm2'
      ),
      assistant(
        [tool('u2', 'TaskUpdate', { task_id: '2', status: 'in_progress' })],
        'tool_use',
        3,
        'm2'
      ),
      assistant(
        [tool('u3', 'TaskUpdate', { taskId: '3', status: 'deleted' })],
        'tool_use',
        3,
        'm2'
      ),
      result('u1', 4),
      result('u2', 4),
      result('u3', 4),
    ];
    assert.deepEqual(statusOf(entries, 5).progress, {
      completed: 1,
      total: 2,
      active: 'Render key',
    });
  });

  test('no todos, no progress', () => {
    assert.equal(statusOf([prompt('x', 0)], 1).progress, null);
  });
});

// --- titles & helpers ------------------------------------------------------

describe('titles', () => {
  test('priority: custom > summary > ai > last prompt > first prompt', () => {
    const meta = [
      prompt('first prompt', 0),
      { type: 'last-prompt', lastPrompt: 'latest prompt', sessionId: 's' },
      { type: 'ai-title', aiTitle: 'AI title', sessionId: 's' },
      { type: 'summary', summary: 'Summary title', leafUuid: 'u' },
      { type: 'custom-title', customTitle: 'Custom title', sessionId: 's' },
    ];
    for (let n = meta.length; n >= 1; n--) {
      const expected = [
        'first prompt',
        'latest prompt',
        'AI title',
        'Summary title',
        'Custom title',
      ][n - 1];
      assert.equal(statusOf(meta.slice(0, n), 1).title, expected);
    }
  });

  test('prompt markup is cleaned', () => {
    assert.equal(
      S.cleanPrompt(
        '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>'
      ),
      '/review PR 12'
    );
    assert.equal(
      S.cleanPrompt('Hi <system-reminder>secret</system-reminder> there'),
      'Hi there'
    );
    assert.equal(
      S.cleanPrompt('<task-notification>done</task-notification>'),
      null
    );
  });

  test('tool descriptions', () => {
    assert.equal(
      S.describeTool('Edit', { file_path: '/a/b/render.ts' }),
      'Edit: render.ts'
    );
    assert.equal(
      S.describeTool('WebFetch', { url: 'https://docs.example.com/x' }),
      'WebFetch: docs.example.com'
    );
    assert.equal(
      S.describeTool('mcp__github__create_issue', {}),
      'create_issue'
    );
    assert.equal(
      S.describeTool('Bash', { command: 'git status\ngit log' }),
      'Bash: git status'
    );
  });

  test('trailing question extraction', () => {
    assert.equal(S.trailingQuestion('All done.'), null);
    assert.equal(S.trailingQuestion('Use v1.2?'), 'Use v1.2?');
    assert.equal(S.trailingQuestion('Fixed. Ok?'), 'Fixed. Ok?');
    assert.equal(S.trailingQuestion('第一步完成。继续吗？」'), '继续吗？');
  });
});

describe('pickSession', () => {
  const mk = state => ({ status: { state } });
  test('prefers the most recent session that needs the user', () => {
    const r = S.pickSession([
      mk('working'),
      mk('done'),
      mk('question'),
      mk('permission'),
    ]);
    assert.equal(r.chosen.status.state, 'question');
    assert.equal(r.others, 2);
  });
  test('otherwise the most recent', () => {
    const r = S.pickSession([mk('done'), mk('working'), mk('idle')]);
    assert.equal(r.chosen.status.state, 'done');
    assert.equal(r.others, 1);
    assert.deepEqual(S.pickSession([]), { chosen: null, others: 0 });
  });
});

// --- files -----------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-session-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const line = e => JSON.stringify(e) + '\n';

describe('TranscriptFile', () => {
  test('follows appends and leaves partial lines for later', async () => {
    const file = path.join(tmp, 'follow.jsonl');
    fs.writeFileSync(file, line(prompt('x', 0)));
    const t = new Src.TranscriptFile(file);
    assert.equal(await t.sync(), true);
    assert.equal(t.acc.last.kind, 'prompt');
    assert.equal(await t.sync(), false);

    const done = line(assistant([text('ok')], 'end_turn', 2));
    fs.appendFileSync(file, done.slice(0, 20));
    await t.sync();
    assert.equal(t.acc.last.kind, 'prompt');
    fs.appendFileSync(file, done.slice(20));
    await t.sync();
    assert.equal(t.acc.last.kind, 'assistant');
    assert.equal(
      S.deriveStatus(t.acc, { now: T0 + 3000, idleMs: IDLE }).state,
      'done'
    );
  });

  test('reads only the tail of a large file', async () => {
    const file = path.join(tmp, 'big.jsonl');
    const filler = line({
      type: 'attachment',
      attachment: { type: 'x', pad: 'z'.repeat(2000) },
      timestamp: at(0),
    });
    let body = line(prompt('ancient prompt', 0));
    while (body.length < 700 * 1024) body += filler;
    body +=
      line(prompt('recent prompt', 10)) +
      line(assistant([text('hi')], 'end_turn', 11));
    fs.writeFileSync(file, body);
    const t = new Src.TranscriptFile(file);
    await t.sync();
    assert.equal(t.acc.titles.firstPrompt, 'recent prompt');
  });

  test('widens the window until it finds the conversation', async () => {
    const file = path.join(tmp, 'meta-tail.jsonl');
    let body =
      line(prompt('the prompt', 0)) +
      line(assistant([text('ok')], 'end_turn', 1));
    const meta = line({
      type: 'cost-state',
      sessionId: 's',
      pad: 'y'.repeat(4000),
    });
    while (body.length < 900 * 1024) body += meta;
    fs.writeFileSync(file, body);
    const t = new Src.TranscriptFile(file);
    await t.sync();
    assert.equal(t.acc.sawConversation, true);
    assert.equal(t.acc.last.kind, 'assistant');
  });
});

describe('SessionMonitor', () => {
  test('finds the latest session, honours filters and the registry', async () => {
    const claudeDir = path.join(tmp, 'claude');
    const projA = path.join(claudeDir, 'projects', '-Users-dev-work-alpha');
    const projB = path.join(claudeDir, 'projects', '-Users-dev-work-beta-app');
    fs.mkdirSync(path.join(projA, 'aaa', 'subagents'), { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });

    const now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    const a = path.join(projA, 'aaa.jsonl');
    fs.writeFileSync(
      a,
      line({
        ...prompt('alpha work', 0),
        cwd: '/Users/dev/work/alpha',
        sessionId: 'aaa',
        timestamp: iso(now - 60_000),
      }) +
        line({
          ...assistant(
            [tool('t1', 'Bash', { command: 'deploy' })],
            'tool_use',
            0
          ),
          cwd: '/Users/dev/work/alpha',
          sessionId: 'aaa',
          timestamp: iso(now - 59_000),
        })
    );
    // subagent transcripts are never candidates
    fs.writeFileSync(
      path.join(projA, 'aaa', 'subagents', 'agent-1.jsonl'),
      line(prompt('sub', 0))
    );
    const subFile = path.join(projA, 'aaa', 'subagents', 'agent-1.jsonl');
    fs.utimesSync(subFile, new Date(now - 120_000), new Date(now - 120_000));
    const b = path.join(projB, 'bbb.jsonl');
    fs.writeFileSync(
      b,
      line({
        ...prompt('beta work', 0),
        cwd: '/Users/dev/work/beta_app',
        sessionId: 'bbb',
        timestamp: iso(now - 10_000),
      }) +
        line({
          ...assistant([text('Done here.')], 'end_turn', 0),
          cwd: '/Users/dev/work/beta_app',
          sessionId: 'bbb',
          timestamp: iso(now - 9_000),
        })
    );
    fs.utimesSync(a, new Date(now - 59_000), new Date(now - 59_000));

    const monitor = new Src.SessionMonitor({ claudeDir, onChange: () => {} });
    monitor.setFilters(['', 'alpha', 'beta_app']);
    await monitor.rescan();

    // newest overall is beta (done), but alpha's stalled call needs the user
    let pick = monitor.getStatus('', now, IDLE);
    assert.equal(pick.status.sessionId, 'aaa');
    assert.equal(pick.status.state, 'permission');
    assert.equal(pick.status.confident, false);
    assert.equal(pick.others, 0);

    pick = monitor.getStatus('beta_app', now, IDLE);
    assert.equal(pick.status.sessionId, 'bbb');
    assert.equal(pick.status.state, 'done');
    assert.equal(pick.status.project, 'beta_app');
    assert.equal(
      monitor.getStatus('/Users/dev/work/alpha', now, IDLE).status.sessionId,
      'aaa'
    );
    assert.equal(
      monitor.getStatus('nothing-like-this', now, IDLE).status,
      null
    );

    // a live registry entry (this process stands in for Claude Code)
    fs.writeFileSync(
      path.join(claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: 'aaa',
        status: 'busy',
        statusUpdatedAt: now - 59_000,
      })
    );
    fs.writeFileSync(
      path.join(claudeDir, 'sessions', '999999999.json'),
      JSON.stringify({
        pid: 999999999,
        sessionId: 'bbb',
        status: 'waiting',
        waitingFor: 'permission prompt',
      })
    );
    await monitor.rescan();
    pick = monitor.getStatus('', now, IDLE);
    assert.equal(
      pick.status.sessionId,
      'bbb',
      'dead registry pids are ignored'
    );
    assert.equal(monitor.getStatus('alpha', now, IDLE).status.state, 'working');
    assert.equal(monitor.getStatus('alpha', now, IDLE).status.live, true);
    monitor.stop();
  });

  test('resolves the Claude config dir', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/opt/claude-cfg';
    assert.equal(Src.resolveClaudeDir(''), path.resolve('/opt/claude-cfg'));
    assert.equal(Src.resolveClaudeDir('~/alt'), path.join(os.homedir(), 'alt'));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(Src.resolveClaudeDir(), path.join(os.homedir(), '.claude'));
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
    assert.equal(
      Src.normalizeFilter('/Users/x/my_app.v2'),
      '-users-x-my-app-v2'
    );
  });
});

// --- view ------------------------------------------------------------------

describe('view', () => {
  const now = T0 + 300_000;
  const view = (entries, lang = 'en', opts = {}) =>
    V.buildSessionView(statusOf(entries, 300, opts), {
      lang,
      showProject: true,
      now,
    });

  test('labels and text per state', () => {
    const q = view(
      [
        prompt('x', 0),
        assistant(
          [
            tool('q', 'AskUserQuestion', {
              questions: [{ question: '继续吗？', options: [{ label: '是' }] }],
            }),
          ],
          'tool_use',
          60
        ),
      ],
      'zh'
    );
    assert.equal(q.label, '待回答');
    assert.equal(q.tone, 'attention');
    assert.equal(q.text, '继续吗？');
    assert.equal(q.time, '4分钟');

    const asked = view([
      prompt('x', 0),
      assistant([text('Shall I push?')], 'end_turn', 240),
    ]);
    assert.equal(asked.label, 'Asked you');
    assert.equal(asked.tone, 'attention');
    assert.equal(asked.text, 'Shall I push?');
    assert.equal(asked.time, '1m');

    const guess = view([
      prompt('x', 0),
      assistant([tool('t', 'Bash', { command: 'make' })], 'tool_use', 100),
    ]);
    assert.equal(guess.label, 'Approval?');
    assert.equal(guess.text, 'Bash: make');

    const working = view([prompt('Refactor auth', 0)]);
    assert.equal(working.label, 'Working');
    assert.equal(working.text, 'Refactor auth');
    assert.equal(working.project, 'demo-app');
    assert.equal(working.time, '5m');
  });

  test('no session', () => {
    const v = V.buildSessionView(null, { lang: 'zh', showProject: true, now });
    assert.equal(v.label, '无会话');
  });

  test('elapsed time formatting', () => {
    assert.equal(V.formatElapsed(30_000, 'en'), 'now');
    assert.equal(V.formatElapsed(3 * 3600_000, 'en'), '3h');
    assert.equal(V.formatElapsed(50 * 3600_000, 'zh'), '2天');
    assert.equal(V.langOf('zh-CN'), 'zh');
    assert.equal(V.langOf(undefined), 'en');
  });
});

// --- running-sessions list -------------------------------------------------

const mkStatus = (state, extra = {}) => ({
  state,
  title: null,
  project: null,
  sessionId: null,
  hasQuestion: false,
  ...extra,
});

describe('running list', () => {
  test('states map to colour groups', () => {
    const group = (state, extra) => S.runningGroup(mkStatus(state, extra));
    assert.equal(group('question'), 'attention');
    assert.equal(group('plan'), 'attention');
    assert.equal(group('permission'), 'attention');
    assert.equal(group('permission', { confident: false }), 'attention');
    assert.equal(group('working'), 'working');
    assert.equal(group('interrupted'), 'stopped');
    assert.equal(group('error'), 'stopped');
    assert.equal(group('done'), 'done');
    // "asked you" is a finished turn: green in the list
    assert.equal(group('done', { hasQuestion: true }), 'done');
    // a live session idle at the prompt
    assert.equal(group('idle'), 'done');
  });

  test('groups get amber, blue, red and green dots', () => {
    assert.equal(V.listTone('attention'), 'attention');
    assert.equal(V.listTone('working'), 'working');
    assert.equal(V.listTone('stopped'), 'error');
    assert.equal(V.listTone('done'), 'done');
    assert.equal(V.TONE_COLORS.attention, '#f0a830');
    assert.equal(V.TONE_COLORS.working, '#5b9bf0');
    assert.equal(V.TONE_COLORS.error, '#d9534f');
    assert.equal(V.TONE_COLORS.done, '#61aa5c');
  });

  test('sorted amber, blue, red, green; most recent first in a group', () => {
    const mk = (id, group, at) => ({
      status: mkStatus('x', { sessionId: id }),
      group,
      at,
    });
    const sorted = S.sortRunning([
      mk('g-old', 'done', 1),
      mk('b-old', 'working', 2),
      mk('r', 'stopped', 9),
      mk('g-new', 'done', 8),
      mk('a-old', 'attention', 3),
      mk('b-new', 'working', 7),
      mk('a-new', 'attention', 4),
    ]);
    assert.deepEqual(
      sorted.map(s => s.status.sessionId),
      ['a-new', 'a-old', 'b-new', 'b-old', 'r', 'g-new', 'g-old']
    );
  });

  test('columns by key width, three rows each', () => {
    const cols = w => V.listLayout(w).columns;
    assert.deepEqual(
      [60, 120, 180, 240, 299, 300, 360, 460].map(cols),
      [1, 1, 1, 1, 1, 2, 2, 3]
    );
    assert.equal(V.listLayout(460).perPage, 9);
    assert.equal(V.listPages(0, 240), 1);
    assert.equal(V.listPages(3, 240), 1);
    assert.equal(V.listPages(4, 240), 2);
    assert.equal(V.listPages(12, 460), 2);
  });

  const sessions = n =>
    Array.from({ length: n }, (_, i) => ({
      status: mkStatus('working', { title: `Task ${i + 1}` }),
      group: 'working',
    }));

  test('list view pages, columns and titles', () => {
    let v = V.buildListView(sessions(7), { lang: 'en', width: 180, page: 1 });
    assert.equal(v.pages, 3);
    assert.equal(v.page, 1);
    assert.equal(v.columns, 1);
    assert.deepEqual(
      v.rows.map(r => r.title),
      ['Task 4', 'Task 5', 'Task 6']
    );
    assert.equal(v.rows[0].tone, 'working');
    assert.equal(v.empty, '');

    // a page past the end shows the last one
    v = V.buildListView(sessions(7), { lang: 'en', width: 180, page: 9 });
    assert.equal(v.page, 2);
    assert.deepEqual(
      v.rows.map(r => r.title),
      ['Task 7']
    );

    // one page: only the columns needed
    assert.equal(
      V.buildListView(sessions(3), { lang: 'en', width: 460, page: 0 }).columns,
      1
    );
    assert.equal(
      V.buildListView(sessions(7), { lang: 'en', width: 460, page: 0 }).columns,
      3
    );
    v = V.buildListView(sessions(12), { lang: 'en', width: 460, page: 1 });
    assert.equal(v.columns, 3);
    assert.equal(v.pages, 2);
    assert.equal(v.rows.length, 3);

    // title, else project, else a placeholder
    const untitled = [
      { status: mkStatus('done', { project: 'demo-app' }), group: 'done' },
      { status: mkStatus('done'), group: 'done' },
    ];
    assert.deepEqual(
      V.buildListView(untitled, { lang: 'zh', width: 240, page: 0 }).rows,
      [
        { tone: 'done', title: 'demo-app' },
        { tone: 'done', title: '未命名会话' },
      ]
    );
  });

  test('empty list', () => {
    const en = V.buildListView([], { lang: 'en', width: 240, page: 0 });
    assert.deepEqual(en.rows, []);
    assert.equal(en.pages, 1);
    assert.equal(en.empty, 'No running sessions');
    const zh = V.buildListView([], { lang: 'zh', width: 240, page: 0 });
    assert.equal(zh.empty, '没有运行中的会话');
  });

  test('presses page through the list and back to the normal view', () => {
    const pager = new V.ListPager();
    const t = 1_000_000;
    assert.equal(pager.pageOf('k', t), null);
    assert.equal(pager.press('k', t, 3), 0);
    assert.equal(pager.press('k', t + 1000, 3), 1);
    assert.equal(pager.press('k', t + 2000, 3), 2);
    assert.equal(pager.pageOf('k', t + 2500), 2);
    // a press on the last page goes back
    assert.equal(pager.press('k', t + 3000, 3), null);
    assert.equal(pager.pageOf('k', t + 3000), null);
    // and the next one opens the list again
    assert.equal(pager.press('k', t + 4000, 3), 0);

    // a single page: open, then back
    assert.equal(pager.press('one', t, 1), 0);
    assert.equal(pager.press('one', t + 100, 1), null);

    // keys are independent
    assert.equal(pager.pageOf('k', t + 4000), 0);
    assert.equal(pager.pageOf('one', t + 4000), null);

    // the list shrank while open: the last page is where it ends
    assert.equal(pager.press('s', t, 3), 0);
    pager.press('s', t, 3);
    pager.press('s', t, 3);
    assert.equal(pager.press('s', t, 2), null);

    pager.close();
    assert.equal(pager.pageOf('k', t + 4000), null);
  });

  test('the list closes 15 s after the last press', () => {
    const pager = new V.ListPager();
    const t = 5_000_000;
    assert.equal(V.LIST_TIMEOUT_MS, 15_000);
    pager.press('k', t, 3);
    assert.equal(pager.pageOf('k', t + 14_999), 0);
    assert.equal(pager.pageOf('k', t + 15_000), null);
    // timed out: the next press opens the first page again
    assert.equal(pager.press('k', t + 20_000, 3), 0);
    // every press restarts the timeout
    assert.equal(pager.press('k', t + 30_000, 3), 1);
    assert.equal(pager.pageOf('k', t + 44_000), 1);
    assert.equal(pager.pageOf('k', t + 45_000), null);
  });
});

/**
 * A Claude config dir with synthetic sessions for the running list:
 * project "alpha" holds one session per case, "beta" one working session.
 */
function makeRunningFixture(now) {
  const claudeDir = path.join(tmp, 'claude-running');
  const alpha = path.join(claudeDir, 'projects', '-Users-dev-work-alpha');
  const beta = path.join(claudeDir, 'projects', '-Users-dev-work-beta');
  const sessionsDir = path.join(claudeDir, 'sessions');
  for (const dir of [alpha, beta, sessionsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const iso = ms => new Date(ms).toISOString();
  const write = (dir, id, cwd, entries, mtime) => {
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(
      file,
      entries
        .map(([e, ms]) =>
          line(
            ms === null ? e : { ...e, sessionId: id, cwd, timestamp: iso(ms) }
          )
        )
        .join('')
    );
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  const cwdA = '/Users/dev/work/alpha';
  const H = 3600_000;
  const M = 60_000;

  // live process, finished hours ago: idle at the prompt (green)
  write(
    alpha,
    'live-old',
    cwdA,
    [
      [prompt('Old but open', 0), now - 3 * H],
      [assistant([text('Done.')], 'end_turn', 0), now - 3 * H + 5000],
    ],
    now - 3 * H + 5000
  );
  // finished within the idle threshold, process gone (green)
  write(
    alpha,
    'recent-done',
    cwdA,
    [
      [prompt('Recently done', 0), now - 150_000],
      [assistant([text('All set.')], 'end_turn', 0), now - 120_000],
    ],
    now - 120_000
  );
  // finished long ago, its registry entry is stale (dead pid): left out
  write(
    alpha,
    'old-done',
    cwdA,
    [
      [prompt('Long finished', 0), now - 2 * H],
      [assistant([text('Done.')], 'end_turn', 0), now - 2 * H + 5000],
    ],
    now - 2 * H + 5000
  );
  // working (blue)
  write(
    alpha,
    'working',
    cwdA,
    [[prompt('Busy one', 0), now - 10_000]],
    now - 10_000
  );
  // waiting for an answer (amber)
  write(
    alpha,
    'question',
    cwdA,
    [
      [prompt('Needs input', 0), now - 90_000],
      [
        assistant(
          [
            tool('q1', 'AskUserQuestion', {
              questions: [{ question: 'Which?' }],
            }),
          ],
          'tool_use',
          0
        ),
        now - 60_000,
      ],
    ],
    now - 60_000
  );
  // interrupted (red)
  write(
    alpha,
    'stopped',
    cwdA,
    [
      [prompt('Cut short', 0), now - 200_000],
      [userBlocks([text('[Request interrupted by user]')], 0), now - 180_000],
    ],
    now - 180_000
  );
  // "working" 40 minutes without output, no process: stale, left out even
  // though a metadata line touched the file recently
  write(
    alpha,
    'stale',
    cwdA,
    [
      [prompt('Abandoned', 0), now - 40 * M],
      [
        { type: 'ai-title', aiTitle: 'Abandoned work', sessionId: 'stale' },
        null,
      ],
    ],
    now - 30_000
  );
  write(
    beta,
    'beta-work',
    '/Users/dev/work/beta',
    [[prompt('Beta task', 0), now - 5000]],
    now - 5000
  );

  // this test process stands in for the live Claude Code process
  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: 'live-old',
      status: 'idle',
      statusUpdatedAt: now - 3 * H + 6000,
    })
  );
  fs.writeFileSync(
    path.join(sessionsDir, '999999999.json'),
    JSON.stringify({ pid: 999999999, sessionId: 'old-done', status: 'idle' })
  );
  return claudeDir;
}

describe('SessionMonitor.listRunning', () => {
  test('live processes plus recent activity, idle and stale ones left out', async () => {
    const now = Date.now();
    const claudeDir = makeRunningFixture(now);
    const monitor = new Src.SessionMonitor({ claudeDir, onChange: () => {} });
    monitor.setFilters(['alpha', '']);
    monitor.setRunningWindow(IDLE);
    await monitor.rescan();

    const alpha = monitor.listRunning('alpha', now, IDLE);
    assert.deepEqual(
      alpha.map(s => s.status.sessionId),
      ['question', 'working', 'stopped', 'recent-done', 'live-old']
    );
    assert.deepEqual(
      alpha.map(s => s.group),
      ['attention', 'working', 'stopped', 'done', 'done']
    );
    assert.equal(alpha[4].status.state, 'idle');
    assert.equal(alpha[4].status.live, true);
    assert.equal(alpha[0].status.title, 'Needs input');

    // no filter: beta's newer working session sorts first among the blue
    assert.deepEqual(
      monitor.listRunning('', now, IDLE).map(s => s.status.sessionId),
      ['question', 'beta-work', 'working', 'stopped', 'recent-done', 'live-old']
    );
    // a shorter idle threshold drops the sessions that finished or stopped
    // before it, unless their process still runs
    assert.deepEqual(
      monitor.listRunning('alpha', now, 100_000).map(s => s.status.sessionId),
      ['question', 'working', 'live-old']
    );
    assert.deepEqual(monitor.listRunning('no-such-project', now, IDLE), []);

    // the normal view is unchanged: the session that needs the user
    const pick = monitor.getStatus('alpha', now, IDLE);
    assert.equal(pick.status.sessionId, 'question');
    assert.equal(pick.others, 1);
    monitor.stop();
  });
});

const pngSize = dataUrl => {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

describe('list rendering', () => {
  test('renders at any width, empty to many sessions', async t => {
    if (!R) return t.skip('@napi-rs/canvas is not available');
    const titles = [
      'Fix login bug',
      '重构用户认证模块并补充单元测试',
      'An extremely long session title that can never fit on a key '.repeat(3),
    ];
    const groups = ['attention', 'working', 'stopped', 'done'];
    for (const width of [60, 120, 180, 240, 360, 460]) {
      const seen = new Set();
      for (const n of [0, 1, 3, 7, 12]) {
        const list = Array.from({ length: n }, (_, i) => ({
          status: mkStatus('x', { title: titles[i % titles.length] }),
          group: groups[i % groups.length],
        }));
        for (let page = 0; page < V.listPages(n, width); page++) {
          for (const lang of ['en', 'zh']) {
            const view = V.buildListView(list, { lang, width, page });
            const image = await R.renderSessionList(width, view, {});
            assert.deepEqual(pngSize(image), [width, 60]);
            seen.add(image);
          }
        }
      }
      assert.ok(seen.size > 5, `distinct images at ${width}px`);
    }
  });
});

describe('Session Status key', () => {
  test('a press lists running sessions, pages through them, then goes back', async t => {
    if (!K || !R) return t.skip('@napi-rs/canvas is not available');
    const now = Date.now();
    const claudeDir = makeRunningFixture(now);
    let chain = Promise.resolve();
    const settle = async () => {
      let last;
      do {
        last = chain;
        await last;
      } while (last !== chain);
    };
    const sent = [];
    const keys = new K.SessionKeys({
      enqueue: task => (chain = chain.then(task).catch(() => {})),
      send: async (_serial, key, image) => sent.push([key.uid, image]),
      isOffline: () => false,
      keyWidth: key => key.width,
      bgColor: () => undefined,
      loadConfig: async () => ({ claudeDir }),
    });
    const key = {
      uid: 7,
      cid: K.SESSION_CID,
      width: 180,
      data: { projectFilter: 'alpha', lang: 'en' },
    };
    const last = () => sent.at(-1)[1];
    const listImage = async page => {
      const running = keys['monitor'].listRunning('alpha', Date.now(), IDLE);
      assert.equal(running.length, 5);
      const view = V.buildListView(running, { lang: 'en', width: 180, page });
      return R.renderSessionList(180, view, {});
    };

    try {
      await keys.alive('dev-1', [key]);
      await keys['monitor'].rescan();
      await settle();
      const normal = last();

      await keys.press('dev-1', key);
      await settle();
      assert.equal(last(), await listImage(0));

      await keys.press('dev-1', key);
      await settle();
      assert.equal(last(), await listImage(1));

      // a press on the last page: back to the normal view
      await keys.press('dev-1', key);
      await settle();
      assert.equal(last(), normal);

      // the list closes by itself 15 s after the last press
      await keys.press('dev-1', key);
      await settle();
      assert.equal(last(), await listImage(0));
      const realNow = Date.now;
      Date.now = () => realNow() + 15_500;
      try {
        keys.redraw();
        await settle();
      } finally {
        Date.now = realNow;
      }
      assert.equal(last(), normal);
    } finally {
      await keys.dead('dev-1', []);
    }
  });
});
