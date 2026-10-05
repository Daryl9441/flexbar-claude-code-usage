// Tests for the privacy scanner (scripts/check-privacy.mjs), the git hooks
// and the log redaction helper (src/redact.ts, compiled by
// `npm run test:privacy`).
//
// Every token-, email- and path-shaped sample is assembled at runtime from
// fragments, so this file contains no literal secret and passes the scanner
// itself (checked below). All values are synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isSensitiveFileName,
  parseAllowlist,
  redact,
  scanDiff,
  scanFile,
  scanIdentity,
  scanLine,
  scanText,
} from './check-privacy.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const checker = path.join(here, 'check-privacy.mjs');
const build =
  process.env.PRIVACY_TEST_BUILD ?? path.join(repoRoot, '.test-build');

// --- synthetic samples -------------------------------------------------------

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64URL = `${ALNUM}-_`;

/** Deterministic pseudo-random string (xorshift), different per seed. */
function randomString(length, alphabet = ALNUM, seed = 1) {
  let x = (seed * 2654435761) >>> 0 || 1;
  let out = '';
  while (out.length < length) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

const join = (...parts) => parts.join('');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

const SAMPLES = {
  ghp: join('gh', 'p_', randomString(36, ALNUM, 1)),
  gho: join('gh', 'o_', randomString(36, ALNUM, 2)),
  ghs: join('gh', 's_', randomString(36, ALNUM, 3)),
  ghu: join('gh', 'u_', randomString(36, ALNUM, 4)),
  ghr: join('gh', 'r_', randomString(36, ALNUM, 5)),
  githubPat: join(
    'github',
    '_pat_',
    randomString(22, ALNUM, 6),
    '_',
    randomString(59, ALNUM, 7)
  ),
  anthropicKey: join('sk-', 'ant-', 'api03-', randomString(93, B64URL, 8)),
  anthropicOauth: join('sk-', 'ant-', 'oat01-', randomString(95, B64URL, 9)),
  openaiProject: join('sk-', 'proj-', randomString(48, B64URL, 10)),
  openaiLegacy: join('sk-', randomString(48, ALNUM, 11)),
  aws: join('AK', 'IA', randomString(16, UPPER_DIGITS, 12)),
  slack: join('xo', 'xb-', '1234567890', '-', randomString(24, ALNUM, 13)),
  google: join('AI', 'za', randomString(35, B64URL, 14)),
  jwt: [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub: '1234567890', iat: 1 }),
    randomString(43, B64URL, 15),
  ].join('.'),
  pemHeader: join('-----BEGIN ', 'RSA PRIV', 'ATE KEY-----'),
  opensshHeader: join('-----BEGIN ', 'OPENSSH PRIV', 'ATE KEY-----'),
  bearer: randomString(40, B64URL, 16),
  secretValue: randomString(24, ALNUM, 17),
  email: ['jane.doe', 'mail-provider.net'].join('@'),
  macHostEmail: ['jdoe', ['janes-macbook', 'lo' + 'cal'].join('.')].join('@'),
  host: ['janes-macbook', 'lo' + 'cal'].join('.'),
  serial: join('FX', '24', '07A3B9C1'),
  highEntropy: randomString(40, ALNUM, 18),
  words: ['correct', 'horse', 'battery', 'staple'].join('-'),
};

const USER = 'jdoe';
const macHome = ['', 'Users', USER, 'work', 'app'].join('/');
const linuxHome = ['', 'home', USER, '.config'].join('/');
const winHome = ['C:', 'Users', USER, 'AppData'].join('\\');
const winHomeJson = ['C:', 'Users', USER, 'AppData'].join('\\\\');

const repoAllowlist = parseAllowlist(
  fs.readFileSync(path.join(repoRoot, '.privacy-allowlist'), 'utf8')
);
const clientId = /OAUTH_CLIENT_ID = '([^']+)'/.exec(
  fs.readFileSync(path.join(repoRoot, 'src', 'credentials.ts'), 'utf8')
)?.[1];

const errorsOf = findings => findings.filter(f => f.severity === 'error');

/** Asserts no output field (everything but the internal `match`) leaks `secret`. */
function assertRedacted(findings, secret) {
  for (const { match: _match, ...shown } of findings) {
    assert.ok(
      !JSON.stringify(shown).includes(secret),
      `finding output repeats the secret: ${JSON.stringify(shown)}`
    );
  }
}

// --- detection -----------------------------------------------------------------

describe('detects every category', () => {
  const cases = [
    [
      'github-token',
      'ghp_ classic token',
      `token: ${SAMPLES.ghp}`,
      SAMPLES.ghp,
    ],
    ['github-token', 'gho_ OAuth token', `"${SAMPLES.gho}"`, SAMPLES.gho],
    ['github-token', 'ghs_ server token', `x ${SAMPLES.ghs}`, SAMPLES.ghs],
    ['github-token', 'ghu_ user token', SAMPLES.ghu, SAMPLES.ghu],
    ['github-token', 'ghr_ refresh token', SAMPLES.ghr, SAMPLES.ghr],
    [
      'github-token',
      'fine-grained PAT',
      `GH=${SAMPLES.githubPat}`,
      SAMPLES.githubPat,
    ],
    [
      'anthropic-key',
      'Anthropic API key',
      `key = '${SAMPLES.anthropicKey}'`,
      SAMPLES.anthropicKey,
    ],
    [
      'anthropic-key',
      'Claude OAuth token',
      `{"accessToken":"${SAMPLES.anthropicOauth}"}`,
      SAMPLES.anthropicOauth,
    ],
    [
      'openai-key',
      'OpenAI project key',
      `OPENAI=${SAMPLES.openaiProject}`,
      SAMPLES.openaiProject,
    ],
    [
      'openai-key',
      'OpenAI legacy key',
      `k: "${SAMPLES.openaiLegacy}"`,
      SAMPLES.openaiLegacy,
    ],
    ['aws-access-key', 'AWS access key id', `aws ${SAMPLES.aws}`, SAMPLES.aws],
    [
      'slack-token',
      'Slack bot token',
      `slack: ${SAMPLES.slack}`,
      SAMPLES.slack,
    ],
    [
      'google-api-key',
      'Google API key',
      `maps=${SAMPLES.google}`,
      SAMPLES.google,
    ],
    ['jwt', 'JWT', `id: ${SAMPLES.jwt}`, SAMPLES.jwt],
    ['private-key', 'PEM RSA key', SAMPLES.pemHeader, SAMPLES.pemHeader],
    [
      'private-key',
      'OpenSSH key',
      SAMPLES.opensshHeader,
      SAMPLES.opensshHeader,
    ],
    [
      'bearer-token',
      'Bearer header',
      `-H "Authorization: Bearer ${SAMPLES.bearer}"`,
      SAMPLES.bearer,
    ],
    [
      'credential-assignment',
      'apiKey literal',
      `const apiKey = '${SAMPLES.secretValue}';`,
      SAMPLES.secretValue,
    ],
    [
      'credential-assignment',
      'accessToken in JSON',
      `"accessToken": "${SAMPLES.secretValue}"`,
      SAMPLES.secretValue,
    ],
    [
      'credential-assignment',
      'refreshToken literal',
      `refreshToken: \`${SAMPLES.secretValue}\``,
      SAMPLES.secretValue,
    ],
    [
      'credential-assignment',
      'clientSecret literal',
      `clientSecret = "${SAMPLES.secretValue}"`,
      SAMPLES.secretValue,
    ],
    [
      'credential-assignment',
      'password literal',
      `password: '${SAMPLES.secretValue}'`,
      SAMPLES.secretValue,
    ],
    [
      'credential-assignment',
      'token literal',
      `const token = "${SAMPLES.secretValue}";`,
      SAMPLES.secretValue,
    ],
    [
      'credential-assignment',
      'passphrase made of words',
      `passphrase: '${SAMPLES.words}'`,
      SAMPLES.words,
    ],
    [
      'credential-assignment',
      'api_key in .env',
      `API_KEY=${SAMPLES.secretValue}`,
      SAMPLES.secretValue,
      '.env.production',
    ],
    [
      'credential-assignment',
      'secret in YAML',
      `secret: ${SAMPLES.secretValue}`,
      SAMPLES.secretValue,
      'config/app.yml',
    ],
    [
      'email',
      'personal email',
      `Contact ${SAMPLES.email} for access`,
      SAMPLES.email,
    ],
    [
      'email',
      'mac default git email',
      `<${SAMPLES.macHostEmail}>`,
      SAMPLES.macHostEmail,
    ],
    ['home-path', 'macOS home', `cwd: '${macHome}'`, USER],
    [
      'home-path',
      'macOS home, no trailing slash',
      ['', 'Users', USER].join('/'),
      USER,
    ],
    ['home-path', 'Linux home', `HOME=${linuxHome}`, USER],
    ['home-path', 'Windows home', `path ${winHome}`, USER],
    ['home-path', 'Windows home in JSON', `"${winHomeJson}"`, USER],
    ['local-hostname', '.local hostname', `ssh ${SAMPLES.host}`, SAMPLES.host],
    [
      'local-hostname',
      '.local URL',
      `http://${SAMPLES.host}:8080/`,
      SAMPLES.host,
    ],
    [
      'serial-number',
      'labelled serial (camelCase)',
      `{ serialNumber: "${SAMPLES.serial}" }`,
      SAMPLES.serial,
    ],
    [
      'serial-number',
      'labelled serial (snake_case)',
      `serial_number = '${SAMPLES.serial}'`,
      SAMPLES.serial,
    ],
  ];

  for (const [rule, label, line, secret, file = 'src/example.ts'] of cases) {
    test(`${rule}: ${label}`, () => {
      const findings = scanLine(line, { file, line: 7 });
      const hit = findings.find(f => f.rule === rule);
      assert.ok(
        hit,
        `expected ${rule} in ${JSON.stringify(findings.map(f => f.rule))}`
      );
      assert.equal(hit.severity, 'error');
      assert.equal(hit.file, file);
      assert.equal(hit.line, 7);
      assertRedacted(findings, secret);
    });
  }

  test('high-entropy strings are warnings, not errors', () => {
    const s = SAMPLES.highEntropy;
    assert.ok(/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s));
    const findings = scanLine(`const blob = "${s}";`, { file: 'src/x.ts' });
    assert.deepEqual(
      findings.map(f => [f.rule, f.severity]),
      [['high-entropy', 'warn']]
    );
    assertRedacted(findings, s);
  });

  test('one finding per secret even when several rules match', () => {
    const findings = scanLine(`"accessToken": "${SAMPLES.anthropicOauth}"`, {});
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'anthropic-key');
  });

  test('sensitive file names', () => {
    for (const name of [
      '.env',
      '.env.local',
      'config/.credentials.json',
      'certs/server.pem',
      'a.key',
      'b.p12',
      'c.pfx',
      'id_ed25519',
    ]) {
      assert.ok(isSensitiveFileName(name), name);
    }
    for (const name of [
      '.env.example',
      'src/credentials.ts',
      'keys.ts',
      'README.md',
      'pem.md',
    ]) {
      assert.ok(!isSensitiveFileName(name), name);
    }
    const findings = scanFile('.env', Buffer.from('DEBUG=1\n'), {});
    assert.deepEqual(
      findings.map(f => f.rule),
      ['sensitive-file']
    );
  });

  test('binary files are searched for printable secrets', () => {
    const buffer = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      Buffer.from(`tEXtComment\0${macHome}\0author ${SAMPLES.email}\0`),
      Buffer.from(randomString(64, B64URL, 19)),
    ]);
    const findings = scanFile('docs/media/shot.png', buffer, {});
    assert.deepEqual(findings.map(f => f.rule).sort(), ['email', 'home-path']);
    assert.ok(
      findings.every(f => f.line === null && f.file === 'docs/media/shot.png')
    );
  });
});

// --- false positives -----------------------------------------------------------------

describe('ignores placeholders and public values', () => {
  const clean = [
    ['/Users/you/project'],
    ['/Users/<name>/Library'],
    ['/Users/$USER/.claude'],
    ['/home/user/app'],
    ['/home/username/app'],
    ['/home/runner/work/repo/repo'],
    ['/Users/me/x'],
    ['C:\\Users\\<name>\\AppData'],
    ['C:\\Users\\you\\AppData'],
    ['/Users/Shared/data'],
    ['~/.claude/.credentials.json'],
    ['https://example.com/home/page'],
    ['author: 12345+someone@users.noreply.github.com'],
    ['Co-Authored-By: Claude <noreply@anthropic.com>'],
    ['mail someone@example.com or ops@example.org'],
    ['bot@ci.test'],
    ['srcset="icon@2x.png 2x"'],
    ['"@napi-rs/canvas": "0.1.100", "rollup@4.0.2"'],
    ['cp .env.example .env.local'],
    ['.claude/settings.local.json'],
    ['http://localhost:3000 and 127.0.0.1'],
    ['accessToken: data.access_token,', 'src/credentials.ts'],
    ['refresh_token: latest.refreshToken,', 'src/credentials.ts'],
    ["grant_type: 'refresh_token',", 'src/credentials.ts'],
    ['headers: { Authorization: `Bearer ${token}` },', 'src/api.ts'],
    ['apiKey: process.env.ANTHROPIC_API_KEY,', 'src/x.ts'],
    ["password: 'Enter the password from your vault'", 'src/x.ts'],
    ['token: "<your token here>"', 'README.md'],
    ['GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', '.github/workflows/release.yml'],
    ['if (typeof parsed.accessToken === "string") {', 'src/x.ts'],
    ["tokenUrl: 'https://platform.claude.com/v1/oauth/token',", 'src/x.ts'],
    ["credentialsPath: '~/.claude/.credentials.json',", 'src/x.ts'],
    ['serialNumber: payload?.serialNumber', 'src/plugin.ts'],
    ["serialNumber: 'TEST-SERIAL-0001'", 'scripts/test.mjs'],
    [
      'Anthropic keys start with sk-ant- and GitHub ones with ghp_',
      'CLAUDE.md',
    ],
    ['commit 2319505e470490ae2a3284b8e77701a0100bc37'],
    ['id 123e4567-e89b-12d3-a456-426614174000'],
    ['dev.sese.flexbar_claude_code_usage.plugin/backend/plugin.cjs'],
  ];
  for (const [line, file = 'notes.md'] of clean) {
    test(line, () => {
      assert.deepEqual(scanLine(line, { file }), []);
    });
  }

  test('alphabet constants are not high-entropy secrets', () => {
    assert.deepEqual(scanLine(`const ALPHABET = '${ALNUM}-_';`, {}), []);
  });

  test('npm integrity hashes and embedded base64 assets are not flagged', () => {
    const integrity = `"integrity": "sha512-${randomString(86, `${ALNUM}+/`, 20)}=="`;
    const asset = `'${randomString(2000, `${ALNUM}+/`, 21)}'`;
    assert.deepEqual(scanLine(integrity, {}), []);
    assert.deepEqual(scanLine(asset, {}), []);
  });

  test('the public Claude Code OAuth client id is allowlisted', () => {
    assert.ok(clientId, 'client id found in src/credentials.ts');
    const line = `const OAUTH_CLIENT_ID = '${clientId}';`;
    assert.equal(
      errorsOf(scanLine(line, { file: 'src/credentials.ts' })).length,
      1
    );
    assert.deepEqual(
      scanLine(line, { file: 'src/credentials.ts', allowlist: repoAllowlist }),
      []
    );
  });

  test('allowlist syntax: comments, blank lines, (?i)', () => {
    const allowlist = parseAllowlist('# comment\n\n(?i)^JANE\\.DOE@\n');
    assert.equal(allowlist.length, 1);
    assert.deepEqual(scanLine(SAMPLES.email, { allowlist }), []);
    assert.throws(() => parseAllowlist('([unclosed'), /line 1/);
  });
});

// --- diffs and commit metadata ----------------------------------------------------------

describe('diffs and identities', () => {
  test('only added lines are scanned, with new-file line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,0 +4,2 @@ export {}',
      '+const ok = 1;',
      `+const apiKey = '${SAMPLES.secretValue}';`,
      '@@ -10 +12 @@',
      `-old ${SAMPLES.email}`,
      `++ ${SAMPLES.ghp}`,
      'diff --git a/.env b/.env',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.env',
      '@@ -0,0 +1 @@',
      '+DEBUG=1',
      'diff --git a/cert.p12 b/cert.p12',
      'new file mode 100644',
      'Binary files /dev/null and b/cert.p12 differ',
    ].join('\n');
    const findings = scanDiff(diff, { commit: 'abc123' });
    assert.deepEqual(
      findings.map(f => [f.rule, f.file, f.line]),
      [
        ['credential-assignment', 'src/a.ts', 5],
        ['github-token', 'src/a.ts', 12],
        ['sensitive-file', '.env', null],
        ['sensitive-file', 'cert.p12', null],
      ]
    );
    assert.ok(findings.every(f => f.commit === 'abc123'));
  });

  test('personal commit emails are errors; noreply and allowlisted are not', () => {
    const personal = scanIdentity('author', 'Jane Doe', SAMPLES.email, {
      commit: 'abc',
    });
    assert.deepEqual(
      personal.map(f => [f.field, f.severity]),
      [['author-email', 'error']]
    );
    assertRedacted(personal, SAMPLES.email);
    assert.deepEqual(
      scanIdentity('author', 'jdoe', '12345+jdoe@users.noreply.github.com'),
      []
    );
    assert.deepEqual(
      scanIdentity('committer', 'Claude', 'noreply@anthropic.com'),
      []
    );
    assert.deepEqual(
      scanIdentity('committer', 'GitHub', 'noreply@github.com', {
        allowlist: repoAllowlist,
      }),
      []
    );
    const hostEmail = scanIdentity('author', 'jdoe', SAMPLES.macHostEmail);
    assert.equal(hostEmail.length, 1);
    const nameLeak = scanIdentity(
      'author',
      `Jane ${SAMPLES.email}`,
      '1+j@users.noreply.github.com'
    );
    assert.deepEqual(
      nameLeak.map(f => f.field),
      ['author-name']
    );
  });

  test('redact never returns the whole value', () => {
    assert.equal(redact('short'), '*****');
    assert.equal(redact(SAMPLES.ghp), `ghp_…(${SAMPLES.ghp.length} chars)`);
  });
});

// --- the repository itself ---------------------------------------------------------------

describe('repository', () => {
  test('this test file and the scanner contain no private data', () => {
    for (const file of [
      'scripts/test-privacy.mjs',
      'scripts/check-privacy.mjs',
    ]) {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      const findings = errorsOf(
        scanText(text, { file, allowlist: repoAllowlist })
      );
      assert.deepEqual(
        findings.map(f => `${f.file}:${f.line} ${f.rule}`),
        []
      );
    }
  });
});

// --- end to end: git repository, CLI and hooks -----------------------------------------------

describe('CLI and hooks in a scratch repository', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-test-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const repo = path.join(tmp, 'repo');
  const emptyConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const noreply = '1+tester@users.noreply.github.com';

  // isolated from the user's git config (hooks, signing, identity)
  const env = (email = noreply) => ({
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: email,
  });
  const git = (args, email) =>
    execFileSync('git', args, {
      cwd: repo,
      env: env(email),
      encoding: 'utf8',
    }).trim();
  const run = (args, email) =>
    spawnSync(
      process.execPath,
      [path.join(repo, 'scripts', 'check-privacy.mjs'), ...args],
      {
        cwd: repo,
        env: env(email),
        encoding: 'utf8',
      }
    );
  const hook = (name, args, input, email) =>
    spawnSync('sh', [path.join(repo, '.githooks', name), ...args], {
      cwd: repo,
      env: env(email),
      input,
      encoding: 'utf8',
    });
  const commit = (file, content, message, email) => {
    fs.writeFileSync(path.join(repo, file), content);
    git(['add', file], email);
    git(['commit', '-q', '--no-verify', '-m', message], email);
    return git(['rev-parse', 'HEAD']);
  };

  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.copyFileSync(checker, path.join(repo, 'scripts', 'check-privacy.mjs'));
  for (const name of ['pre-commit', 'pre-push']) {
    fs.copyFileSync(
      path.join(repoRoot, '.githooks', name),
      path.join(repo, '.githooks', name)
    );
  }
  const clean = commit('README.md', '# demo\n', 'docs: start');
  // pretend the clean commit is already on the remote, without pushing
  git(['update-ref', 'refs/remotes/origin/main', clean]);
  const leaky = commit(
    'config.ts',
    `export const ok = 1;\nexport const apiKey = '${SAMPLES.secretValue}';\n`,
    'feat: add config',
    SAMPLES.email
  );
  const zero = '0'.repeat(clean.length);

  test('default mode passes on a clean tree and fails on a leak', () => {
    const tmpRepoClean = run(['--json']);
    // config.ts holds a credential literal, so the default scan fails
    assert.equal(tmpRepoClean.status, 1);
    const report = JSON.parse(tmpRepoClean.stdout);
    assert.deepEqual(
      report.findings.map(f => [f.file, f.line, f.rule]),
      [['config.ts', 2, 'credential-assignment']]
    );
    assert.ok(!tmpRepoClean.stdout.includes(SAMPLES.secretValue));

    fs.writeFileSync(
      path.join(repo, '.privacy-allowlist'),
      `# synthetic test value\n^${SAMPLES.secretValue}$\n`
    );
    try {
      const allowed = run([]);
      assert.equal(allowed.status, 0, allowed.stdout);
    } finally {
      fs.rmSync(path.join(repo, '.privacy-allowlist'));
    }
  });

  test('--history reports added lines and author/committer emails by commit', () => {
    const result = run(['--history', `${clean}..HEAD`, '--json']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    const short = leaky.slice(0, 12);
    assert.deepEqual(
      report.findings.map(f => [
        f.commit,
        f.field ?? `${f.file}:${f.line}`,
        f.rule,
      ]),
      [
        [short, 'author-email', 'email'],
        [short, 'committer-email', 'email'],
        [short, 'config.ts:2', 'credential-assignment'],
      ]
    );
    assert.ok(!result.stdout.includes(SAMPLES.email));
    assert.ok(!result.stdout.includes(SAMPLES.secretValue));

    const text = run(['--history', `${clean}..HEAD`]);
    assert.match(text.stdout, new RegExp(`error {2}${short} author-email`));
    assert.ok(!text.stdout.includes(SAMPLES.email));

    assert.equal(run(['--history', `${clean}..${clean}`]).status, 0);
    // without a range: upstream/main..HEAD, else origin/main..HEAD
    const fallback = run(['--history', '--json']);
    assert.equal(fallback.status, 1);
    assert.match(JSON.parse(fallback.stdout).scanned, /origin\/main\.\.HEAD/);
  });

  test('--history rejects unexpected git options', () => {
    const result = run(['--history', 'HEAD --output=/tmp/x']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported history argument/);
  });

  test('--staged and pre-commit check staged lines and the commit identity', () => {
    fs.writeFileSync(path.join(repo, 'notes.md'), `ping ${SAMPLES.ghp}\n`);
    git(['add', 'notes.md']);
    try {
      const staged = run(['--staged', '--json']);
      assert.equal(staged.status, 1);
      assert.deepEqual(
        JSON.parse(staged.stdout).findings.map(f => [f.file, f.rule]),
        [['notes.md', 'github-token']]
      );
      assert.equal(hook('pre-commit', [], '').status, 1);

      // the default mode also reports what is staged but no longer on disk
      fs.writeFileSync(path.join(repo, 'notes.md'), 'ping\n');
      const report = JSON.parse(run(['--json']).stdout);
      assert.deepEqual(
        report.findings
          .filter(f => f.file === 'notes.md')
          .map(f => [f.rule, f.field]),
        [['github-token', 'staged']]
      );
    } finally {
      git(['rm', '-q', '-f', '--cached', 'notes.md']);
      fs.rmSync(path.join(repo, 'notes.md'));
    }
    assert.equal(run(['--staged']).status, 0);
    const identity = run(['--staged', '--json'], SAMPLES.email);
    assert.equal(identity.status, 1);
    assert.deepEqual(
      JSON.parse(identity.stdout).findings.map(f => [f.commit, f.field]),
      [
        ['next commit', 'author-email'],
        ['next commit', 'committer-email'],
      ]
    );
    assert.equal(hook('pre-commit', [], '', SAMPLES.email).status, 1);
    assert.equal(hook('pre-commit', [], '').status, 0);
  });

  test('pre-push blocks new commits with private data and allows clean pushes', () => {
    const url = 'https://example.invalid/demo.git';
    const update = `refs/heads/main ${leaky} refs/heads/main ${clean}\n`;
    const blocked = hook('pre-push', ['origin', url], update);
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stdout, new RegExp(leaky.slice(0, 12)));
    assert.ok(!blocked.stdout.includes(SAMPLES.email));

    const newBranch = hook(
      'pre-push',
      ['origin', url],
      `refs/heads/feat ${leaky} refs/heads/feat ${zero}\n`
    );
    assert.equal(newBranch.status, 1);

    const upToDate = hook(
      'pre-push',
      ['origin', url],
      `refs/heads/main ${clean} refs/heads/main ${clean}\n`
    );
    assert.equal(upToDate.status, 0, upToDate.stdout);
    const deletion = hook(
      'pre-push',
      ['origin', url],
      `(delete) ${zero} refs/heads/old ${clean}\n`
    );
    assert.equal(deletion.status, 0);

    // commits another remote already has (e.g. upstream) are public there
    git(['update-ref', 'refs/remotes/upstream/main', leaky]);
    try {
      assert.equal(hook('pre-push', ['origin', url], update).status, 0);
    } finally {
      git(['update-ref', '-d', 'refs/remotes/upstream/main']);
    }
  });
});

// --- src/redact.ts ---------------------------------------------------------------------------

describe('log redaction (src/redact.ts)', () => {
  const { redactSecrets, safeErrorMessage } = require(
    path.join(build, 'redact.js')
  );
  const secrets = [
    SAMPLES.anthropicOauth,
    SAMPLES.ghp,
    SAMPLES.jwt,
    SAMPLES.secretValue,
  ];

  test('credential JSON, headers and form bodies are redacted', () => {
    const text = [
      `{"claudeAiOauth":{"accessToken":"${SAMPLES.anthropicOauth}","refreshToken":"${SAMPLES.secretValue}"}}`,
      `Authorization: Bearer ${SAMPLES.jwt}`,
      `refresh_token=${SAMPLES.secretValue}&client_id=x`,
      `token ${SAMPLES.ghp}`,
    ].join('\n');
    const out = redactSecrets(text);
    for (const secret of secrets) assert.ok(!out.includes(secret), out);
    assert.match(out, /claudeAiOauth/);
  });

  test('child-process errors lose their command line', () => {
    const error = Object.assign(
      new Error(
        `Command failed: security add-generic-password -U -s x -w {"accessToken":"${SAMPLES.anthropicOauth}"}`
      ),
      {
        cmd: `security add-generic-password -w ${SAMPLES.anthropicOauth}`,
        code: 45,
        stderr: 'security: item could not be saved\n',
      }
    );
    const message = safeErrorMessage(error);
    assert.equal(
      message,
      'Command failed (exit 45): security: item could not be saved'
    );
  });

  test('JSON parse snippets and fetch causes', () => {
    let parseError;
    try {
      JSON.parse(`{"accessToken":"${SAMPLES.anthropicOauth}" x}`);
    } catch (error) {
      parseError = error;
    }
    assert.ok(!safeErrorMessage(parseError).includes(SAMPLES.anthropicOauth));
    assert.match(safeErrorMessage(parseError), /^SyntaxError: /);

    const fetchError = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND api.example.com'),
    });
    assert.equal(
      safeErrorMessage(fetchError),
      'TypeError: fetch failed (getaddrinfo ENOTFOUND api.example.com)'
    );
    assert.equal(safeErrorMessage('plain'), 'plain');
    assert.equal(safeErrorMessage(new Error('x'.repeat(500))).length, 201);
  });

  test('ordinary messages are left alone', () => {
    const text = 'Usage request failed with HTTP 503 for /api/oauth/usage';
    assert.equal(redactSecrets(text), text);
  });
});
