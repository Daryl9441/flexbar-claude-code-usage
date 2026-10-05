// Tests for the Session Status key's transcript parser, file follower and
// view builder, run against the tsc output (see `npm run test:session`).
// All fixtures are synthetic.
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
    assert.equal(q.detail, '继续吗？ — 选项：是');
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
