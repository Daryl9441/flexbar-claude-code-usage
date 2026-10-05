// Classifies the Claude Code session transcripts on this machine with the
// Session Status parser, read-only. Prints state and progress only — no
// titles, prompts or other transcript content.
//
//   npm run test:session            # builds .test-build
//   node scripts/session-report.mjs [claudeDir] [--replay]
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.SESSION_TEST_BUILD ?? path.join(here, '..', '.test-build');
const S = require(path.join(build, 'session.js'));
const Src = require(path.join(build, 'sessionSource.js'));

const claudeDir = Src.resolveClaudeDir(
  process.argv.slice(2).find(a => !a.startsWith('--'))
);
const projectsDir = path.join(claudeDir, 'projects');
const now = Date.now();
const IDLE = 15 * 60_000;

const files = [];
for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(projectsDir, dir.name))) {
    if (f.endsWith('.jsonl')) files.push(path.join(projectsDir, dir.name, f));
  }
}
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

// the monitor reads the live registry the same way the key does
const monitor = new Src.SessionMonitor({ claudeDir, onChange: () => {} });
await monitor.rescan();

const counts = {};
const ago = ms =>
  ms < 120_000
    ? `${Math.round(ms / 1000)}s`
    : ms < 7200_000
      ? `${Math.round(ms / 60_000)}m`
      : `${Math.round(ms / 3600_000)}h`;
console.log(
  'age    size    state        conf  ask   progress  live  bg    no-registry  session'
);
for (const file of files) {
  const t = new Src.TranscriptFile(file);
  await t.sync();
  const sessionId = path.basename(file, '.jsonl');
  const live = monitor['live'].get(sessionId) ?? null;
  const st = S.deriveStatus(t.acc, {
    now,
    idleMs: IDLE,
    live,
    subagentActiveAt: monitor['subagentAt'].get(sessionId) ?? null,
  });
  // the same transcript judged without the live registry
  const tx = S.deriveStatus(t.acc, {
    now,
    idleMs: IDLE,
    subagentActiveAt: monitor['subagentAt'].get(sessionId) ?? null,
  });
  counts[st.state] = (counts[st.state] ?? 0) + 1;
  const size = fs.statSync(file).size;
  const progress = st.progress
    ? `${st.progress.completed}/${st.progress.total}`
    : '-';
  console.log(
    [
      ago(now - fs.statSync(file).mtimeMs).padEnd(6),
      `${Math.round(size / 1024)}K`.padEnd(7),
      st.state.padEnd(12),
      String(st.confident).padEnd(5),
      String(st.hasQuestion).padEnd(5),
      progress.padEnd(9),
      (live ? live.status : '-').padEnd(5),
      String(st.background).padEnd(5),
      tx.state.padEnd(12),
      sessionId.slice(0, 8),
    ].join(' ')
  );
}
console.log('\ncounts:', counts);
const pick = monitor.getStatus('', now, IDLE);
console.log(
  'key would show:',
  pick.status?.state ?? 'none',
  pick.status?.sessionId?.slice(0, 8) ?? '',
  `others=${pick.others}`
);
monitor.stop();

// --replay: feed every transcript entry by entry and classify each point in
// time as the key would have seen it live: 1s after each entry, and 15s
// after it when nothing else was written for 15s (stalls). Summarises how
// often each state occurs; still prints no content.
if (process.argv.includes('--replay')) {
  const tally = { at1s: {}, stalled15s: {} };
  const stalledTools = {};
  const checks = {
    askPending: [0, 0],
    planPending: [0, 0],
    endTurn: [0, 0],
    interrupt: [0, 0],
    apiRetry: [0, 0],
  };
  const check = (name, ok) => {
    checks[name][0]++;
    if (ok) checks[name][1]++;
  };
  for (const file of files) {
    const acc = S.createAccumulator();
    const entries = [];
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        if (raw) entries.push(JSON.parse(raw));
      } catch {
        // partial line
      }
    }
    const times = entries.map(e => Date.parse(e.timestamp ?? ''));
    entries.forEach((e, i) => {
      S.observeEntry(acc, e);
      const t = times[i];
      if (Number.isNaN(t) || e.isSidechain) return;
      const next = times.slice(i + 1).find(x => !Number.isNaN(x)) ?? Infinity;
      const s1 = S.deriveStatus(acc, { now: t + 1000, idleMs: IDLE });
      tally.at1s[s1.state] = (tally.at1s[s1.state] ?? 0) + 1;
      if (next - t >= 15_000) {
        const s15 = S.deriveStatus(acc, { now: t + 15_000, idleMs: IDLE });
        tally.stalled15s[s15.state] = (tally.stalled15s[s15.state] ?? 0) + 1;
        if (s15.state === 'permission') {
          const key = `${(s15.tool ?? '').split(':')[0]} (${acc.permissionMode ?? 'mode?'})`;
          stalledTools[key] = (stalledTools[key] ?? 0) + 1;
        }
      }
      const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
      const uses = name =>
        e.type === 'assistant' &&
        blocks.some(b => b.type === 'tool_use' && b.name === name);
      if (uses('AskUserQuestion')) check('askPending', s1.state === 'question');
      if (uses('ExitPlanMode')) check('planPending', s1.state === 'plan');
      if (
        e.type === 'assistant' &&
        e.message?.stop_reason === 'end_turn' &&
        blocks.some(b => b.type === 'text')
      )
        check('endTurn', s1.state === 'done');
      if (
        e.type === 'user' &&
        JSON.stringify(e.message?.content ?? '').includes(
          '[Request interrupted by user'
        )
      )
        check('interrupt', s1.state === 'interrupted');
      if (e.type === 'system' && e.subtype === 'api_error')
        check('apiRetry', s1.state === 'working');
    });
  }
  console.log('\nreplay, state 1s after each entry:', tally.at1s);
  console.log('replay, state after 15s without writes:', tally.stalled15s);
  console.log('permission guesses by tool (mode):', stalledTools);
  console.log('replay checks [seen, as expected]:', checks);
}
