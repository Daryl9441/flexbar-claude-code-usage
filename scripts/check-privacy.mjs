#!/usr/bin/env node
// Privacy scanner: keeps tokens, API keys, personal email addresses, local
// paths and other private data out of this repository. No dependencies,
// Node >= 18. See "Privacy rules" in CLAUDE.md.
//
//   node scripts/check-privacy.mjs                   tracked files + staged changes
//   node scripts/check-privacy.mjs --staged          staged diff + commit identity (pre-commit)
//   node scripts/check-privacy.mjs --history [range] every commit in range: added lines,
//                                                    message, author/committer name + email
//                                                    (default range: upstream/main..HEAD,
//                                                    falling back to origin/main..HEAD)
//   add --json for machine-readable output
//
// The history range is passed to `git log`, so "A..B" and "<sha> --not
// --remotes" both work. Exit code: 1 when an error-level finding remains, 0
// otherwise (warnings never fail), 2 on usage or git errors.
//
// Every mode reads the content of binary files too (staged blobs, and in
// --history the blob each commit added), and also scans a URL-decoded copy of
// every line that contains %XX escapes.
//
// Matches are always printed redacted, so CI logs never repeat a secret.
// Verified-public values go in .privacy-allowlist (one regex per line, tested
// against the matched text), each with a comment explaining why it is public.
// Commits whose author/committer identity the repository owner accepted are
// listed by full id in .privacy-accepted-commits: --history skips only their
// identity check, never their message or changes.
//
// Your own identifiers (user name, real name, hostname, device serial, personal
// email addresses, ...) go in the git-ignored .privacy-denylist.local, or in
// the file the PRIVACY_DENYLIST environment variable names: one literal per
// line (matched case-insensitively as a whole word) or `re:<regex>`. They are
// never committed. The session ids of this machine's Claude Code transcripts
// (file names in ~/.claude/projects, never their content) are denied too; set
// PRIVACY_LOCAL_SESSIONS=0 to skip that.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- rules -----------------------------------------------------------------

const ERROR = 'error';
const WARN = 'warn';

/** Home-directory names that are placeholders, not a real account. */
const PLACEHOLDER_USERS = new Set([
  'you',
  'your',
  'yourname',
  'your-name',
  'your_name',
  'user',
  'username',
  'me',
  'name',
  'runner', // GitHub Actions
  'shared', // macOS /Users/Shared
  'example',
  'someone',
]);

/** Email domains that can never be a real mailbox (RFC 2606 / RFC 6761). */
const RESERVED_EMAIL_DOMAIN =
  /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/** "icon@2x.png" and similar are file names, not addresses. */
const FILE_EXTENSION_TLD =
  /^(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff?|avif|js|mjs|cjs|ts|tsx|jsx|json|css|scss|vue|md|html?|txt|ya?ml|map|woff2?|ttf|otf)$/i;

/** Labels before ".local" that are file names (settings.local, .env.local). */
const FILE_LIKE_LOCAL_LABELS = new Set(['env', 'settings', 'config', 'conf']);

const PLACEHOLDER_VALUE =
  /\$\{|\$\(|\{\{|<[^>]*>|process\.env|secrets\.|example|placeholder|your[-_ ]?|x{4,}|\*{4,}|changeme|redacted|dummy/i;

/** Files whose unquoted `key=value` / `key: value` values are literals. */
const CONFIG_FILE =
  /(?:^|\/)(?:\.env[^/]*|\.npmrc|\.netrc|[^/.]+)$|\.(?:env|ini|cfg|conf|toml|properties|ya?ml|sh|bash|zsh)$/i;

// accessToken, refresh_token, GH_TOKEN, apiKey, client_secret, OAUTH_CLIENT_ID,
// password, ... (client ids are usually public, but each one is reviewed and
// allowlisted explicitly)
const CREDENTIAL_KEY = String.raw`[A-Za-z0-9_.-]*?(?:token|api[_-]?key|client[_-]?secret|client[_-]?id|secret|passw(?:or)?d|passphrase|private[_-]?key)[A-Za-z0-9_.-]*`;

const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(?<![\w-])(["']?)(${CREDENTIAL_KEY})\1\s*(?:=>|:=|(?<![=!<>])[:=](?!=))\s*(?:(["'\x60])((?:(?!\3).){16,}?)\3|([^\s"'\x60,;#]{16,}))`,
  'gi'
);

function shannonEntropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const hasDigit = s => /\d/.test(s);
const hasLetter = s => /[A-Za-z]/.test(s);

function isPlaceholderUser(name) {
  const n = name.toLowerCase();
  return (
    PLACEHOLDER_USERS.has(n) ||
    /^\$\{?\w+\}?$/.test(name) || // $USER, ${USER}
    /^%\w+%$/.test(name) || // %USERNAME%
    /^<[^>]*>$/.test(name) || // <name>
    /^\{[^}]*\}$/.test(name) || // {user}
    /^\.+$/.test(name)
  );
}

const UUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;
const UUID_EXACT = new RegExp(`^${UUID}$`);

/** Well-known example UUIDs; never a real session. */
const EXAMPLE_UUIDS = new Set([
  '123e4567-e89b-12d3-a456-426614174000', // RFC 4122 / Wikipedia example
  '00000000-0000-0000-0000-000000000000', // nil UUID
  'ffffffff-ffff-ffff-ffff-ffffffffffff', // max UUID
]);

/**
 * Synthetic UUIDs (examples, few distinct digits such as
 * 00000000-0000-4000-8000-000000000001, or runs such as 12345678): a random
 * UUID practically never looks like this.
 */
export function isSyntheticUuid(uuid) {
  const u = uuid.toLowerCase();
  if (EXAMPLE_UUIDS.has(u)) return true;
  const hex = u.replace(/-/g, '');
  return new Set(hex).size <= 8 || hasAscendingRun(hex, 7);
}

// Where a Claude Code session id shows up: transcript/hook JSON keys, the
// CLI's resume flags, and the per-session folders and files under ~/.claude.
const SESSION_CONTEXT = [
  String.raw`\b[A-Za-z_]*session[_-]?id["']?\s*(?:[!=]==?|[:=])\s*["'\x60]?`,
  String.raw`(?:--resume|--session-id|/resume|(?<![\w-])-r)(?:=|\s+)["'\x60]?`,
  String.raw`(?:projects[/\\][^\s/\\"'\x60]+|sessions|todos|file-history|session-env|shell-snapshots|debug)[/\\]`,
].join('|');

/** Built-in safe addresses; everything else needs an allowlist entry. */
export function isBuiltinSafeEmail(email) {
  const e = email.toLowerCase();
  const domain = e.slice(e.lastIndexOf('@') + 1);
  return (
    e.endsWith('@users.noreply.github.com') ||
    e === 'noreply@anthropic.com' ||
    RESERVED_EMAIL_DOMAIN.test(domain)
  );
}

/**
 * Each rule finds candidate matches in one line. `group` selects the capture
 * group holding the sensitive value; `check` drops false positives.
 */
export const RULES = [
  {
    id: 'private-key',
    category: 'PEM private key block',
    re: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/g,
    binary: true,
  },
  {
    id: 'github-token',
    category: 'GitHub token',
    re: /\b(?:gh[opsur]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g,
    binary: true,
  },
  {
    id: 'anthropic-key',
    category: 'Anthropic API key / OAuth token',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    binary: true,
  },
  {
    id: 'openai-key',
    category: 'OpenAI-style secret key',
    re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    check: m => hasDigit(m) && hasLetter(m) && shannonEntropy(m) >= 3.5,
    binary: true,
  },
  {
    id: 'aws-access-key',
    category: 'AWS access key id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    binary: true,
  },
  {
    id: 'slack-token',
    category: 'Slack token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    binary: true,
  },
  {
    id: 'google-api-key',
    category: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    binary: true,
  },
  {
    id: 'jwt',
    category: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    binary: true,
  },
  {
    id: 'bearer-token',
    category: 'Bearer token',
    re: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g,
    group: 1,
    check: m => hasDigit(m) && hasLetter(m),
  },
  {
    id: 'session-id',
    category: 'Claude Code session id',
    re: new RegExp(
      String.raw`(?:${SESSION_CONTEXT})(${UUID})(?![0-9a-fA-F])|(?<![0-9a-fA-F-])(${UUID})(?=\.jsonl\b)`,
      'gi'
    ),
    value: m =>
      m[1] !== undefined
        ? { text: m[1], index: m.index + m[0].length - m[1].length }
        : { text: m[2], index: m.index },
    check: m => !isSyntheticUuid(m),
    binary: true,
  },
  {
    id: 'credential-assignment',
    category: 'credential assigned a literal value',
    re: CREDENTIAL_ASSIGNMENT,
    value: (m, ctx) => {
      if (m[4] !== undefined)
        return { text: m[4], index: m.index + m[0].length - m[4].length - 1 };
      // unquoted values are only literals in config-style files
      if (m[5] !== undefined && ctx.file && CONFIG_FILE.test(ctx.file)) {
        return { text: m[5], index: m.index + m[0].length - m[5].length };
      }
      return null;
    },
    check: m =>
      !PLACEHOLDER_VALUE.test(m) &&
      !/\s/.test(m) && // prose, e.g. a UI label
      !/^[a-z][a-z0-9+.-]*:\/\/[^@\s]*$/i.test(m) && // URL without credentials
      !/^(?:~|\.{1,2})?\/[^:@]*$/.test(m) && // file path
      shannonEntropy(m) >= 2.5,
  },
  {
    id: 'email',
    category: 'email address',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,})(?![A-Za-z0-9-])/g,
    check: (m, match) =>
      !FILE_EXTENSION_TLD.test(match[1]) && !isBuiltinSafeEmail(m),
    binary: true,
  },
  {
    id: 'home-path',
    category: 'local home directory path',
    re: /(?<![\w.-])(?:\/(?:Users|home)\/|\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))(\$\{?\w+\}?|%\w+%|<[^>\s]*>|\{[^}\s]*\}|[^\s/\\"'\x60<>:;,()[\]{}|*?]+)/g,
    check: (m, match) => !isPlaceholderUser(match[1]),
    // keep the directory prefix readable, mask the account name
    preview: (m, match) =>
      `${m.slice(0, m.length - match[1].length)}${redact(match[1])}`,
    binary: true,
  },
  {
    // Claude Code's project folder names (~/.claude/projects/-Users-<name>-app)
    // and other encodings that turn every "/" into "-"
    id: 'encoded-home-path',
    category: 'local home directory in an encoded path',
    re: /(?<![\w-])(?:[A-Za-z]-)?-(?:Users|home)-([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g,
    check: (m, match) => !isPlaceholderUser(match[1]),
    preview: (m, match) =>
      `${m.slice(0, m.length - match[1].length)}${redact(match[1])}`,
    binary: true,
  },
  {
    id: 'local-hostname',
    category: '.local hostname',
    re: /(?<![\w.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?))\.local(?![\w-]|\.\w)/gi,
    check: (m, match) => !FILE_LIKE_LOCAL_LABELS.has(match[2].toLowerCase()),
  },
  {
    // serialNumber: '…', serial_no = "…", sn: '…', deviceSerial === '…',
    // "Serial Number (system): …" (system_profiler). A synthetic serial must
    // say so (TEST, FAKE, MOCK, ...).
    id: 'serial-number',
    category: 'device serial number',
    re: /\b(?:serial[ _-]?(?:number|num|no)?|device[_-]?serial(?:[_-]?(?:number|num|no))?|sn)(?:\s*\([^)\n]{0,20}\))?["']?\s*(?:[!=]==?|[:=])\s*(?:(["'\x60])([A-Za-z0-9][A-Za-z0-9:_-]{5,})\1|([A-Za-z0-9]{8,})(?![\w-]))/gi,
    value: m => {
      if (m[2] !== undefined)
        return { text: m[2], index: m.index + m[0].length - m[2].length - 1 };
      // unquoted: only serial-shaped values (upper-case letters and digits),
      // never an identifier such as `payload`
      if (/^[A-Z0-9]+$/.test(m[3]) && hasLetter(m[3]))
        return { text: m[3], index: m.index + m[0].length - m[3].length };
      return null;
    },
    check: m =>
      hasDigit(m) &&
      !/test|fake|mock|dummy|sample|example|demo|placeholder|synthetic/i.test(
        m
      ),
  },
  {
    // a bare Flexbar serial (12 upper-case hex digits), e.g. in a pasted log
    // line; the local denylist is the reliable way to catch your own
    id: 'hex-serial',
    category: 'possible device serial number (12 upper-case hex digits)',
    severity: WARN,
    re: /(?<![A-Za-z0-9_-])[0-9A-F]{12}(?![A-Za-z0-9_-])/g,
    check: m => /[A-F]/.test(m) && hasDigit(m) && !hasAscendingRun(m),
  },
];

const DENYLIST = {
  id: 'denylist',
  category: 'value from your local privacy denylist',
};

const LOCAL_SESSION = {
  id: 'local-session-id',
  category: 'session id of a Claude Code transcript on this machine',
};

const HIGH_ENTROPY = {
  id: 'high-entropy',
  category: 'high-entropy string (possible secret)',
  severity: WARN,
};

/** "ABCDEF", "012345": alphabets and sequences, never a random secret. */
function hasAscendingRun(text, length = 6) {
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    run = text.charCodeAt(i) === text.charCodeAt(i - 1) + 1 ? run + 1 : 1;
    if (run >= length) return true;
  }
  return false;
}

/** Runs of base64-ish characters that look like random secrets (warn only). */
function highEntropyMatches(line) {
  const out = [];
  for (const m of line.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    const run = m[0];
    // embedded assets (base64 images) and integrity hashes are not secrets
    if (run.length > 256) continue;
    if (/^sha(?:1|256|384|512)-/.test(run)) continue;
    if (/^[0-9a-f-]+$/i.test(run)) continue; // hex: commit ids, digests, uuids
    if (
      run.includes('//') ||
      run.startsWith('/') ||
      (run.match(/\//g) ?? []).length > 2
    )
      continue;
    if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !hasDigit(run)) continue;
    if (shannonEntropy(run) < 4.3 || hasAscendingRun(run)) continue;
    out.push({ text: run, index: m.index });
  }
  return out;
}

// --- allowlist ---------------------------------------------------------------

/**
 * Parses .privacy-allowlist: one regular expression per line, tested against
 * the matched text; `#` starts a comment line; a leading `(?i)` makes the
 * entry case-insensitive.
 */
export function parseAllowlist(text) {
  const entries = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const insensitive = line.startsWith('(?i)');
    const source = insensitive ? line.slice(4) : line;
    try {
      entries.push(new RegExp(source, insensitive ? 'i' : ''));
    } catch (error) {
      throw new Error(`.privacy-allowlist line ${i + 1}: ${error.message}`);
    }
  }
  return entries;
}

const isAllowed = (text, allowlist) => allowlist.some(re => re.test(text));

// --- accepted commits --------------------------------------------------------

const FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Parses .privacy-accepted-commits: one full commit id (40 or 64 hex digits)
 * per line, optionally followed by `# comment`; `#` starts a comment line.
 * The repository owner accepted the author/committer identity of a listed
 * commit (see CLAUDE.md), so --history skips only that identity check; the
 * commit's message and changes are still scanned. Abbreviated ids are
 * rejected, so an entry can never match a commit other than the one meant.
 */
export function parseAcceptedCommits(text) {
  const ids = new Set();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim().toLowerCase();
    if (!line) continue;
    if (!FULL_COMMIT_ID.test(line)) {
      throw new Error(
        `.privacy-accepted-commits line ${i + 1}: expected a full commit id`
      );
    }
    ids.add(line);
  }
  return ids;
}

// --- denylist ----------------------------------------------------------------

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parses a denylist (.privacy-denylist.local, PRIVACY_DENYLIST): one entry per
 * line, `#` starts a comment line. A plain entry is a literal matched
 * case-insensitively where it is not part of a longer run of letters/digits
 * ("jdoe" matches "jdoe@host" and "jdoe_mac", not "jdoe42"); `re:<regex>`
 * is a regular expression (`re:(?i)…` for case-insensitive). Denied values are
 * reported even when .privacy-allowlist would allow them.
 */
export function parseDenylist(text, source = '.privacy-denylist.local') {
  const entries = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const where = `${source} line ${i + 1}`;
    let re;
    if (line.startsWith('re:')) {
      let body = line.slice(3);
      const insensitive = body.startsWith('(?i)');
      if (insensitive) body = body.slice(4);
      try {
        re = new RegExp(body, insensitive ? 'gi' : 'g');
      } catch (error) {
        throw new Error(`${where}: ${error.message}`);
      }
      if (re.test('')) throw new Error(`${where}: matches the empty string`);
    } else {
      if (line.length < 3)
        throw new Error(`${where}: entries need at least 3 characters`);
      re = new RegExp(
        `(?<![A-Za-z0-9])${escapeRegExp(line)}(?![A-Za-z0-9])`,
        'gi'
      );
    }
    entries.push(re);
  }
  return entries;
}

function loadDenylist(root) {
  const entries = [];
  const local = path.join(root, '.privacy-denylist.local');
  if (fs.existsSync(local)) {
    entries.push(...parseDenylist(fs.readFileSync(local, 'utf8')));
  }
  const named = process.env.PRIVACY_DENYLIST?.trim();
  if (named) {
    const file = path.resolve(
      root,
      named.replace(/^~(?=$|[/\\])/, os.homedir())
    );
    if (!fs.existsSync(file))
      throw new Error(`PRIVACY_DENYLIST names a missing file: ${named}`);
    entries.push(
      ...parseDenylist(fs.readFileSync(file, 'utf8'), 'PRIVACY_DENYLIST')
    );
  }
  return entries;
}

/**
 * Session ids of this machine's Claude Code transcripts, from the file and
 * folder names in <config dir>/projects/<project>/. Contents are never read.
 */
function loadLocalSessionIds() {
  const ids = new Set();
  if (/^(?:0|false|no|off)$/i.test(process.env.PRIVACY_LOCAL_SESSIONS ?? ''))
    return ids;
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const projects = path.join(claudeDir, 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return ids; // no Claude Code here (e.g. CI)
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let names;
    try {
      names = fs.readdirSync(path.join(projects, dir.name));
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.replace(/\.jsonl$/, '');
      if (UUID_EXACT.test(id) && !isSyntheticUuid(id))
        ids.add(id.toLowerCase());
    }
  }
  return ids;
}

// --- scanning ----------------------------------------------------------------

/** Masks a match so output never repeats the secret itself. */
export function redact(value) {
  const v = String(value);
  // Never echo any part of a match: CI logs of a public repo are public too
  if (v.length <= 8) return '*'.repeat(v.length);
  return `****…(${v.length} chars)`;
}

function finding(rule, text, ctx, extra = {}) {
  return {
    rule: rule.id,
    category: rule.category,
    severity: rule.severity ?? ERROR,
    file: ctx.file ?? null,
    line: ctx.line ?? null,
    commit: ctx.commit ?? null,
    field: ctx.field ?? null,
    preview: redact(text),
    ...extra,
    // kept out of output; used for allowlisting and de-duplication
    match: text,
  };
}

const URL_ESCAPE = /%[0-9A-Fa-f]{2}/;

/**
 * The line with its %XX escapes decoded (up to three times, for double
 * encoding), or null when there is nothing to decode. Invalid UTF-8 sequences
 * keep their ASCII escapes decoded.
 */
function urlDecoded(text) {
  if (!URL_ESCAPE.test(text)) return null;
  let out = text;
  for (let i = 0; i < 3 && URL_ESCAPE.test(out); i++) {
    const next = out.replace(/(?:%[0-9A-Fa-f]{2})+/g, seq => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );
      }
    });
    if (next === out) break;
    out = next;
  }
  return out === text ? null : out;
}

/**
 * Scans one line. ctx: { file, line, commit, field, allowlist, denylist,
 * sessionIds, binary }. Overlapping matches keep only the first (most
 * specific) rule. Lines with %XX escapes are scanned decoded as well, so
 * `%2FUsers%2F<name>` and `<name>%40<domain>` are found too.
 */
export function scanLine(text, ctx = {}) {
  const results = scanLineOnce(text, ctx, false);
  const decoded = urlDecoded(text);
  if (decoded !== null) {
    const seen = new Set(results.map(f => `${f.rule}\0${f.match}`));
    for (const f of scanLineOnce(decoded, ctx, true)) {
      const key = `${f.rule}\0${f.match}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ ...f, category: `${f.category} (URL-encoded)` });
    }
  }
  return results;
}

function scanLineOnce(text, ctx, decodedPass) {
  const allowlist = ctx.allowlist ?? [];
  const results = [];
  const spans = [];
  const overlaps = (start, end) => spans.some(([s, e]) => start < e && s < end);
  // your own identifiers first: they win every overlap and are never allowed
  for (const re of ctx.denylist ?? []) {
    for (const m of text.matchAll(re)) {
      if (!m[0] || overlaps(m.index, m.index + m[0].length)) continue;
      spans.push([m.index, m.index + m[0].length]);
      results.push(finding(DENYLIST, m[0], ctx));
    }
  }
  if (ctx.sessionIds?.size) {
    for (const m of text.matchAll(new RegExp(UUID, 'g'))) {
      if (!ctx.sessionIds.has(m[0].toLowerCase())) continue;
      if (overlaps(m.index, m.index + m[0].length)) continue;
      spans.push([m.index, m.index + m[0].length]);
      results.push(finding(LOCAL_SESSION, m[0], ctx));
    }
  }
  for (const rule of RULES) {
    if (ctx.binary && !rule.binary) continue;
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      let value;
      if (rule.value) {
        value = rule.value(m, ctx);
        if (!value) continue;
      } else if (rule.group) {
        value = {
          text: m[rule.group],
          index: m.index + m[0].lastIndexOf(m[rule.group]),
        };
      } else {
        value = { text: m[0], index: m.index };
      }
      if (rule.check && !rule.check(value.text, m)) continue;
      const start = value.index;
      const end = start + value.text.length;
      if (overlaps(start, end)) continue;
      spans.push([start, end]);
      if (isAllowed(value.text, allowlist)) continue;
      const extra = rule.preview
        ? { preview: rule.preview(value.text, m) }
        : {};
      results.push(finding(rule, value.text, ctx, extra));
    }
  }
  if (!ctx.binary && !decodedPass) {
    for (const value of highEntropyMatches(text)) {
      const end = value.index + value.text.length;
      if (overlaps(value.index, end)) continue;
      if (isAllowed(value.text, allowlist)) continue;
      results.push(finding(HIGH_ENTROPY, value.text, ctx));
    }
  }
  return results;
}

/** Scans a whole text file; ctx as for scanLine (line is filled in). */
export function scanText(text, ctx = {}) {
  const results = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    results.push(...scanLine(lines[i], { ...ctx, line: i + 1 }));
  }
  return results;
}

/** Printable ASCII runs of a binary file, scanned with the high-confidence rules. */
export function scanBinary(buffer, ctx = {}) {
  const results = [];
  const text = buffer.toString('latin1');
  for (const m of text.matchAll(/[\x20-\x7e]{8,}/g)) {
    results.push(...scanLine(m[0], { ...ctx, binary: true, line: null }));
  }
  return results;
}

const SENSITIVE_FILE = {
  id: 'sensitive-file',
  category: 'credential/key file must not be committed',
};

/** File names that hold credentials by convention (see .gitignore). */
export function isSensitiveFileName(file) {
  const base = path.posix.basename(file.replace(/\\/g, '/'));
  if (/^\.env(?:\.|$)/.test(base))
    return !/\.(?:example|sample|template)$/.test(base);
  return (
    /^\.?credentials\.json$/i.test(base) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i.test(base) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(base) ||
    base === '.netrc' ||
    /^\.privacy-denylist(?:\.|$)/.test(base) // your own identifiers
  );
}

export function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** Scans file content: text line by line, binary by its printable runs. */
function scanContent(file, buffer, ctx) {
  return looksBinary(buffer)
    ? scanBinary(buffer, { ...ctx, file })
    : scanText(buffer.toString('utf8'), { ...ctx, file });
}

/** Scans file content (text or binary) plus its name. */
export function scanFile(file, buffer, ctx = {}) {
  const results = [];
  if (isSensitiveFileName(file) && !isAllowed(file, ctx.allowlist ?? [])) {
    results.push(
      finding(SENSITIVE_FILE, file, { ...ctx, file }, { preview: file })
    );
  }
  results.push(...scanContent(file, buffer, ctx));
  return results;
}

const UNREADABLE_BLOB = {
  id: 'unscanned-binary',
  category: 'binary file content could not be read for scanning',
};

/** Undoes git's C-style quoting of a path ("a\tb", "\303\251", ...). */
export function unquoteGitPath(text) {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"')))
    return text;
  const body = text.slice(1, -1);
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      const cp = body.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length - 1;
      continue;
    }
    const next = body[++i] ?? '';
    if (/^[0-7]{3}$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const BINARY_LINE =
  /^Binary files (?:\/dev\/null|"?a\/.*?) and (\/dev\/null|"?b\/.*) differ$/;

/**
 * Scans the added lines of a unified diff (as printed by `git diff -U0` or
 * `git log -p -U0`, with the default a/ b/ prefixes); line numbers refer to
 * the new file. A diff only names a binary file ("Binary files … differ"), so
 * its content comes from ctx.readBlob(path) → Buffer when given: without
 * it, a secret inside a binary file would pass unseen.
 */
export function scanDiff(diffText, ctx = {}) {
  const results = [];
  let file = null;
  let newLine = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      // "+++ b/path" for text, "Binary files a/x and b/path differ" for binary
      const binary = BINARY_LINE.exec(line);
      const target = line.startsWith('+++ ')
        ? line.slice(4).replace(/\t$/, '')
        : binary?.[1];
      if (target !== undefined) {
        const unquoted = unquoteGitPath(target);
        file = unquoted === '/dev/null' ? null : unquoted.replace(/^b\//, '');
        if (
          file &&
          isSensitiveFileName(file) &&
          !isAllowed(file, ctx.allowlist ?? [])
        ) {
          results.push(
            finding(SENSITIVE_FILE, file, { ...ctx, file }, { preview: file })
          );
        }
        if (binary && file && ctx.readBlob) {
          let buffer = null;
          try {
            buffer = ctx.readBlob(file);
          } catch {
            // fail closed: content that cannot be read was not checked
          }
          results.push(
            ...(buffer
              ? scanContent(file, buffer, ctx)
              : [
                  finding(
                    UNREADABLE_BLOB,
                    file,
                    { ...ctx, file },
                    { preview: file }
                  ),
                ])
          );
        }
        continue;
      }
      if (!line.startsWith('@@')) continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (line.startsWith('+')) {
      if (file) {
        results.push(
          ...scanLine(line.slice(1), { ...ctx, file, line: newLine })
        );
      }
      newLine++;
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return results;
}

/**
 * Scans a commit identity (author or committer). Any email that is not a
 * built-in safe address or allowlisted is an error: commit metadata is
 * public forever once pushed.
 */
export function scanIdentity(role, name, email, ctx = {}) {
  const allowlist = ctx.allowlist ?? [];
  const results = [];
  if (email && !isBuiltinSafeEmail(email) && !isAllowed(email, allowlist)) {
    results.push(
      finding(
        { id: 'email', category: `personal email in ${role} metadata` },
        email,
        { ...ctx, field: `${role}-email` }
      )
    );
  }
  if (name) {
    for (const f of scanLine(name, { ...ctx, field: `${role}-name` })) {
      if (f.severity === ERROR) results.push(f);
    }
  }
  return results;
}

// --- git ----------------------------------------------------------------------

function git(args, options = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitOk(args, cwd) {
  try {
    git(args, { cwd });
    return true;
  } catch {
    return false;
  }
}

function loadAllowlist(root) {
  const file = path.join(root, '.privacy-allowlist');
  return fs.existsSync(file)
    ? parseAllowlist(fs.readFileSync(file, 'utf8'))
    : [];
}

function loadAcceptedCommits(root) {
  const file = path.join(root, '.privacy-accepted-commits');
  return fs.existsSync(file)
    ? parseAcceptedCommits(fs.readFileSync(file, 'utf8'))
    : new Set();
}

/** Every file in the index, read from the working tree. */
function scanTrackedFiles(root, base) {
  const results = [];
  const files = git(['ls-files', '-z'], { cwd: root })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    const abs = path.join(root, file);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // deleted in the working tree
    }
    if (stat.isSymbolicLink()) {
      results.push(
        ...scanLine(fs.readlinkSync(abs), { ...base, file, line: 1 })
      );
      continue;
    }
    if (!stat.isFile()) continue;
    results.push(...scanFile(file, fs.readFileSync(abs), base));
  }
  return { results, scanned: `${files.length} tracked files` };
}

/** Options that keep diff output parseable whatever the user's git config. */
const DIFF_OPTIONS = [
  '-U0',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

const readBlob = (root, rev) => file =>
  git(['cat-file', 'blob', `${rev}:${file}`], {
    cwd: root,
    encoding: 'buffer',
  });

function scanStaged(root, base) {
  const diff = git(
    ['diff', '--cached', ...DIFF_OPTIONS, '--diff-filter=ACMR'],
    {
      cwd: root,
    }
  );
  // ":0:<path>" is the staged (stage 0) version of a file
  return scanDiff(diff, { ...base, readBlob: readBlob(root, ':0') });
}

/** The identity the next commit will be made with (pre-commit). */
function scanNextCommitIdentity(root, base) {
  const results = [];
  for (const [role, variable] of [
    ['author', 'GIT_AUTHOR_IDENT'],
    ['committer', 'GIT_COMMITTER_IDENT'],
  ]) {
    let ident;
    try {
      ident = git(['var', variable], { cwd: root }).trim();
    } catch {
      continue; // no identity configured: git refuses the commit anyway
    }
    const m = /^(.*?) <([^>]*)>/.exec(ident);
    if (m)
      results.push(
        ...scanIdentity(role, m[1], m[2], { ...base, commit: 'next commit' })
      );
  }
  return results;
}

/** Default history range: commits not yet in upstream/main (or origin/main). */
function defaultHistoryRange(root) {
  for (const base of ['upstream/main', 'origin/main']) {
    if (gitOk(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], root)) {
      return `${base}..HEAD`;
    }
  }
  throw new Error(
    'no upstream/main or origin/main to compare against; pass --history <range>'
  );
}

const REV_ARG =
  /^(?:--(?:not|all|branches|tags|remotes)(?:=[^\s]*)?|--exclude=[^\s]+|[^-][^\s]*)$/;

const COMMIT_MARK = '\x00\x00commit ';
const PATCH_MARK = '\x00\x00patch';

function scanHistory(root, range, base) {
  const revArgs = range.trim().split(/\s+/).filter(Boolean);
  for (const arg of revArgs) {
    if (!REV_ARG.test(arg))
      throw new Error(`unsupported history argument: ${arg}`);
  }
  // remerge-diff shows what a merge commit itself added beyond the automatic
  // merge (conflict resolutions, "evil" merges); plain commits show their diff
  const mergeDiff = gitSupportsRemerge(root) ? ['--diff-merges=remerge'] : [];
  const out = git(
    [
      'log',
      // argv cannot carry NUL bytes; git expands %x00 into the markers
      '--format=%x00%x00commit %H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00%x00patch',
      '-p',
      ...DIFF_OPTIONS,
      ...mergeDiff,
      ...revArgs,
      '--',
    ],
    { cwd: root }
  );
  const accepted = base.acceptedCommits ?? new Set();
  const results = [];
  let commits = 0;
  let acceptedIdentities = 0;
  for (const chunk of out.split(COMMIT_MARK).slice(1)) {
    commits++;
    const patchAt = chunk.indexOf(PATCH_MARK);
    const header = chunk.slice(0, patchAt);
    const patch = chunk.slice(patchAt + PATCH_MARK.length);
    const [sha, an, ae, cn, ce, ...messageParts] = header.split('\x00');
    const message = messageParts.join('\x00');
    const ctx = { ...base, commit: sha.slice(0, 12) };
    // an identity the owner accepted (.privacy-accepted-commits); the
    // message and the changes below are scanned all the same
    if (accepted.has(sha)) {
      acceptedIdentities++;
    } else {
      results.push(...scanIdentity('author', an, ae, ctx));
      results.push(...scanIdentity('committer', cn, ce, ctx));
    }
    message.split('\n').forEach((line, i) => {
      results.push(
        ...scanLine(line, { ...ctx, field: 'message', line: i + 1 })
      );
    });
    // binary files: the blob as this commit left it
    results.push(...scanDiff(patch, { ...ctx, readBlob: readBlob(root, sha) }));
  }
  const note = acceptedIdentities
    ? ` (identity accepted for ${acceptedIdentities}, see .privacy-accepted-commits)`
    : '';
  return { results, scanned: `${commits} commits in ${range}${note}` };
}

function gitSupportsRemerge(root) {
  try {
    const [major, minor] = git(['version'], { cwd: root })
      .match(/(\d+)\.(\d+)/)
      .slice(1)
      .map(Number);
    return major > 2 || (major === 2 && minor >= 36);
  } catch {
    return false;
  }
}

// --- output -------------------------------------------------------------------

function dedupe(results) {
  const seen = new Set();
  return results.filter(f => {
    const key = [f.commit, f.file, f.line, f.field, f.rule, f.match].join(
      '\x00'
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function location(f) {
  const parts = [];
  if (f.commit) parts.push(f.commit);
  if (f.file)
    parts.push(
      `${f.line ? `${f.file}:${f.line}` : f.file}${f.field === 'staged' ? ' (staged)' : ''}`
    );
  else if (f.field)
    parts.push(f.line && f.field === 'message' ? `message:${f.line}` : f.field);
  return parts.join(' ');
}

function printText(results, scanned, mode) {
  for (const f of results) {
    const tag = f.severity === ERROR ? 'error' : 'warn ';
    process.stdout.write(
      `${tag}  ${location(f)}  ${f.category}  [${f.preview}]\n`
    );
  }
  const errors = results.filter(f => f.severity === ERROR).length;
  const warnings = results.length - errors;
  process.stdout.write(
    `privacy check (${mode}): ${errors} error(s), ${warnings} warning(s) in ${scanned}\n`
  );
  if (errors > 0) {
    process.stdout.write(
      [
        '',
        'Remove the private data before committing or pushing (and rotate any real',
        'credential that was exposed). Commit identities must use the GitHub noreply',
        'address. Only a value verified to be public may be added to',
        '.privacy-allowlist, with a comment explaining why. See CLAUDE.md.',
        '',
      ].join('\n')
    );
  }
}

function usage() {
  return 'usage: check-privacy.mjs [--staged | --history [range]] [--json]';
}

export function main(argv = process.argv.slice(2)) {
  let mode = 'default';
  let range = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--staged') mode = 'staged';
    else if (arg === '--history') {
      mode = 'history';
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-'))
        range = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else {
      process.stderr.write(`unknown argument: ${arg}\n${usage()}\n`);
      return 2;
    }
  }

  let root;
  let results = [];
  let scanned = '';
  try {
    root = git(['rev-parse', '--show-toplevel']).trim();
    const base = {
      allowlist: loadAllowlist(root),
      denylist: loadDenylist(root),
      sessionIds: loadLocalSessionIds(),
      acceptedCommits: loadAcceptedCommits(root),
    };
    if (mode === 'staged') {
      results = [
        ...scanStaged(root, base),
        ...scanNextCommitIdentity(root, base),
      ];
      scanned = 'staged changes';
    } else if (mode === 'history') {
      const r = range ?? defaultHistoryRange(root);
      ({ results, scanned } = scanHistory(root, r, base));
    } else {
      // staged content usually equals the working tree: report it only when
      // the staged version holds something the working tree no longer does
      const tracked = scanTrackedFiles(root, base);
      const known = new Set(
        tracked.results.map(f => [f.file, f.rule, f.match].join('\x00'))
      );
      const staged = scanStaged(root, base).filter(
        f => !known.has([f.file, f.rule, f.match].join('\x00'))
      );
      results = [
        ...tracked.results,
        ...staged.map(f => ({ ...f, field: 'staged' })),
      ];
      scanned = `${tracked.scanned} + staged changes`;
    }
  } catch (error) {
    const detail = error.stderr ? `${error.stderr}`.trim() : error.message;
    process.stderr.write(`privacy check failed: ${detail}\n`);
    return 2;
  }

  results = dedupe(results);

  const errors = results.filter(f => f.severity === ERROR).length;
  if (json) {
    const findings = results.map(({ match: _match, ...rest }) => rest);
    process.stdout.write(
      `${JSON.stringify({ mode, scanned, errors, warnings: results.length - errors, findings }, null, 2)}\n`
    );
  } else {
    printText(results, scanned, mode);
  }
  return errors > 0 ? 1 : 0;
}

function invokedDirectly() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(path.resolve(process.argv[1])) === self
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main();
