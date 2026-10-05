// Tests for the Gemini usage source (src/providers/gemini/usage*.ts), run
// against the tsc output of `npm run test:gemini-usage`
// (.test-build-gemini-usage/). Rules: synthetic fixtures only (see
// CLAUDE.md), no network (fetch is stubbed), never read the real home folder
// (HOME points at an empty temp folder) and never search the real install
// folders for the CLI, token-shaped strings are built at runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-usage-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
for (const name of [
  'GEMINI_CLI_HOME',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
]) {
  delete process.env[name];
}
globalThis.fetch = async () => {
  throw new Error('network is disabled in tests');
};
after(() => fs.rmSync(empty, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build =
  process.env.GEMINI_USAGE_TEST_BUILD ??
  path.join(here, '..', '.test-build-gemini-usage');
const req = p => require(path.join(build, p));
const U = req('providers/gemini/usage.js');
const M = req('providers/gemini/usageMetrics.js');
const A = req('providers/gemini/usageApi.js');
const C = req('providers/gemini/usageCreds.js');
const L = req('providers/gemini/usageCli.js');
const T = req('providers/gemini/usageText.js');
const Kit = req('providers/kit.js');
const { UsageKeys } = req('usageKey.js');
const { GEMINI_BRAND } = req('providers/gemini/brand.js');

const CONFIG = {
  geminiDir: path.join(empty, 'gemini'),
  geminiPath: path.join(empty, 'no-gemini'),
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- synthetic credentials (built at runtime, never real) -------------------
const ACCESS = ['ya29', 'FAKE-ACCESS-0001'].join('.');
const ACCESS_NEW = ['ya29', 'FAKE-ACCESS-0002'].join('.');
const ACCESS_NEWER = ['ya29', 'FAKE-ACCESS-0003'].join('.');
const REFRESH = ['1', '', 'FAKE-REFRESH-0001'].join('/');
const REFRESH_OTHER = ['1', '', 'FAKE-REFRESH-0002'].join('/');
const CID = [['000000000000', 'fakeclient'].join('-'), 'apps', 'googleusercontent', 'com'].join('.');
const CSEC = ['GOCSPX', 'FAKE_SECRET_00000000000000'].join('-');
const PROJECT = ['example', 'project', '000'].join('-');

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const RESET = '2026-10-06T07:00:00Z';

let tmpCount = 0;
function tmpDir(name) {
  const dir = path.join(empty, `${name}-${++tmpCount}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A Gemini CLI home with settings.json and (optionally) a login. */
function geminiHome({ authType = 'oauth-personal', creds = 'valid', settings } = {}) {
  const home = tmpDir('gemini-home');
  const body =
    settings ??
    (authType === null
      ? '{}'
      : JSON.stringify({ security: { auth: { selectedType: authType } } }));
  fs.writeFileSync(path.join(home, 'settings.json'), body);
  if (creds === 'valid' || creds === 'expired') {
    fs.writeFileSync(
      path.join(home, 'oauth_creds.json'),
      JSON.stringify({
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: 'openid',
        token_type: 'Bearer',
        expiry_date: creds === 'valid' ? T0 + 24 * 3_600_000 : T0 - 1000,
      })
    );
  } else if (typeof creds === 'string') {
    fs.writeFileSync(path.join(home, 'oauth_creds.json'), creds);
  }
  return home;
}

/** A Homebrew-like Gemini CLI install whose bundle declares the client. */
function cliInstall({ withClient = true, version = '0.36.0' } = {}) {
  const prefix = tmpDir('cli');
  const pkg = path.join(prefix, 'lib', 'node_modules', '@google', 'gemini-cli');
  fs.mkdirSync(path.join(pkg, 'bundle'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@google/gemini-cli', version })
  );
  fs.writeFileSync(path.join(pkg, 'bundle', 'gemini.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(pkg, 'bundle', 'chunk-small.js'), 'var x = 1;\n');
  const decl = withClient
    ? `var OAUTH_CLIENT_ID = "${CID}";\nvar OAUTH_CLIENT_SECRET = "${CSEC}";\n`
    : 'var nothing = "here";\n';
  fs.writeFileSync(
    path.join(pkg, 'bundle', 'chunk-big.js'),
    `${'// filler\n'.repeat(2000)}${decl}${'// more\n'.repeat(200)}`
  );
  fs.mkdirSync(path.join(prefix, 'bin'));
  const bin = path.join(prefix, 'bin', 'gemini');
  fs.symlinkSync(path.join('..', 'lib', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), bin);
  return { prefix, pkg, bin };
}

/** A stub fetch: routes by URL, records every call (headers and body). */
function stubNetwork(routes) {
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    const name = url.includes('oauth2.googleapis.com/token')
      ? 'token'
      : url.endsWith(':loadCodeAssist')
        ? 'load'
        : url.endsWith(':retrieveUserQuota')
          ? 'quota'
          : 'other';
    const call = { name, url, init, body: init.body };
    calls.push(call);
    const route = routes[name];
    if (!route) throw new Error(`unexpected request ${name}`);
    const out = typeof route === 'function' ? await route(call, calls) : route;
    if (out instanceof Error) throw out;
    const headers = new Headers(out.headers ?? {});
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {});
    return new Response(text, { status: out.status ?? 200, headers });
  };
  return { calls, fetch: fetchStub, count: name => calls.filter(c => c.name === name).length };
}

const STANDARD_LOAD = {
  currentTier: { id: 'standard-tier', name: 'Gemini Code Assist Standard', userDefinedCloudaicompanionProject: true },
  allowedTiers: [{ id: 'standard-tier', isDefault: true, userDefinedCloudaicompanionProject: true }],
  cloudaicompanionProject: PROJECT,
};
const PERSONAL_LOAD = {
  allowedTiers: [{ id: 'standard-tier', name: 'Gemini Code Assist', isDefault: true, userDefinedCloudaicompanionProject: true }],
  ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', reasonMessage: 'synthetic', tierId: 'free-tier', tierName: 'Gemini Code Assist for individuals' }],
};
const BUCKETS = [
  { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingAmount: '1350', remainingFraction: 0.9, resetTime: RESET },
  { modelId: 'gemini-2.5-flash', tokenType: 'REQUESTS', remainingAmount: '1500', remainingFraction: 1.0, resetTime: RESET },
  { modelId: 'gemini-3-pro-preview', remainingFraction: 0.25, resetTime: RESET },
];

/** A source with a fake clock, a stub network and a fixture CLI (or none). */
function source({ net, cli = null, clock = { now: T0 } } = {}) {
  return {
    clock,
    src: U.createGeminiUsageSource({
      fetch: () => net.fetch,
      now: () => clock.now,
      env: {},
      home: () => empty,
      credsRetryMs: 5,
      findCli: async () =>
        cli ? { bin: cli.bin, root: cli.pkg, version: '0.36.0' } : null,
    }),
  };
}

async function rejectsWith(promise, check) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected a rejection');
  check(caught);
  return caught;
}

function assertNoSecrets(text) {
  for (const secret of [ACCESS, ACCESS_NEW, REFRESH, CSEC, CID]) {
    assert.ok(!text.includes(secret), `leaked a credential: ${text}`);
  }
}

beforeEach(() => L.clearClientCache());

// --- metrics -----------------------------------------------------------------

describe('quota buckets → metrics', () => {
  test('model labels and families', () => {
    assert.equal(M.modelLabel('gemini-2.5-pro'), '2.5 Pro');
    assert.equal(M.modelLabel('gemini-3-flash-preview'), '3 Flash');
    assert.equal(M.modelLabel('gemini-2.5-flash-lite'), '2.5 Flash Lite');
    assert.equal(M.modelLabel('gemini-3.1-pro-preview-customtools'), '3.1 Pro Tools');
    assert.equal(M.modelLabel('gemini-2.5-flash-preview-05-20'), '2.5 Flash');
    assert.equal(M.modelLabel('models/gemini-2.0-flash-exp'), '2.0 Flash');
    assert.equal(M.modelLabel('other-model'), 'Other Model');
    assert.equal(M.modelFamily('gemini-2.5-flash-lite'), 'flash-lite');
    assert.equal(M.modelFamily('gemini-3-flash-preview'), 'flash');
    assert.equal(M.modelFamily('gemini-3.1-pro-preview'), 'pro');
    assert.equal(M.modelFamily('gemini-embedding-001'), 'other');
  });

  test('a Standard answer gives lowest, pro, flash, pooled and per-model metrics', () => {
    const metrics = M.bucketsToMetrics(BUCKETS);
    assert.deepEqual(
      metrics.map(m => m.id),
      ['lowest', 'pro', 'flash', 'pooled', 'model:gemini-3-pro-preview', 'model:gemini-2.5-pro', 'model:gemini-2.5-flash']
    );
    const byId = Object.fromEntries(metrics.map(m => [m.id, m]));
    assert.deepEqual(byId.lowest, { id: 'lowest', label: '3 Pro', percent: 75, resetsAt: RESET });
    assert.equal(byId.pro.label, 'Pro');
    assert.equal(byId.pro.percent, 75); // the most used Pro model
    assert.equal(byId.flash.percent, 0);
    // pool of 2.5 Pro + 2.5 Flash: (1350 + 1500) / (1500 + 1500) left
    assert.equal(byId.pooled.label, 'Auto');
    assert.equal(byId.pooled.percent, 5);
    assert.equal(byId['model:gemini-2.5-pro'].percent, 10);
    assert.equal(byId['model:gemini-2.5-pro'].label, '2.5 Pro');
    for (const m of metrics) {
      assert.ok(Number.isInteger(m.percent) && m.percent >= 0 && m.percent <= 100);
    }
  });

  test('pooled uses the preview pair when it is there, and remembered limits', () => {
    const limits = new Map();
    const preview = [
      { modelId: 'gemini-3-pro-preview', remainingAmount: '50', remainingFraction: 0.5, resetTime: RESET },
      { modelId: 'gemini-3-flash-preview', remainingAmount: '300', remainingFraction: 0.75, resetTime: '2026-10-06T08:00:00Z' },
      { modelId: 'gemini-2.5-pro', remainingAmount: '1500', remainingFraction: 1, resetTime: RESET },
    ];
    let pooled = M.bucketsToMetrics(preview, limits).find(m => m.id === 'pooled');
    // (50 + 300) / (100 + 400) left → 30% used, latest reset of the pair
    assert.equal(pooled.percent, 30);
    assert.equal(pooled.resetsAt, '2026-10-06T08:00:00Z');
    // Pro used up: its limit is no longer derivable, the remembered one is used
    preview[0] = { ...preview[0], remainingAmount: '0', remainingFraction: 0 };
    pooled = M.bucketsToMetrics(preview, limits).find(m => m.id === 'pooled');
    assert.equal(pooled.percent, 40); // (0 + 300) / (100 + 400)
    // without amounts there is no pool
    assert.equal(
      M.bucketsToMetrics([{ modelId: 'gemini-2.5-pro', remainingFraction: 0.5 }]).find(m => m.id === 'pooled'),
      undefined
    );
  });

  test('malformed buckets are skipped, values clamped, duplicate ids kept apart', () => {
    const metrics = M.bucketsToMetrics([
      null,
      'nope',
      { modelId: 'gemini-2.5-pro' },
      { modelId: 'gemini-2.5-pro', remainingFraction: 'x' },
      { modelId: '', remainingFraction: 0.5 },
      { modelId: 'gemini-2.5-flash', remainingFraction: 1.7, resetTime: 'not a date' },
      { modelId: 'gemini-2.5-flash', remainingFraction: -2, tokenType: 'TOKENS' },
    ]);
    const ids = metrics.map(m => m.id);
    assert.deepEqual(ids, ['lowest', 'flash', 'model:gemini-2.5-flash', 'model:gemini-2.5-flash:TOKENS']);
    assert.equal(metrics[0].percent, 100);
    assert.equal(metrics[2].percent, 0);
    assert.equal(metrics[2].resetsAt, null);
    assert.deepEqual(M.bucketsToMetrics(undefined), []);
    assert.deepEqual(M.bucketsToMetrics([]), []);
  });
});

// --- tier / project ----------------------------------------------------------

describe('loadCodeAssist → project or problem', () => {
  const problemOf = fn => {
    try {
      fn();
    } catch (error) {
      return error.problem ?? error.code;
    }
    return 'ok';
  };

  test('a current tier with a project', () => {
    assert.deepEqual(A.resolveSetup(STANDARD_LOAD, null), {
      project: PROJECT,
      tierId: 'standard-tier',
      tierName: 'Gemini Code Assist Standard',
    });
    const paid = A.resolveSetup({ ...STANDARD_LOAD, paidTier: { id: 'g1-ultra-tier', name: 'Ultra' } }, null);
    assert.equal(paid.tierName, 'Ultra');
  });

  test('a current tier without a project uses the configured one, else asks for it', () => {
    const noProject = { currentTier: { id: 'standard-tier' } };
    assert.equal(A.resolveSetup(noProject, 'my-project-1').project, 'my-project-1');
    assert.equal(problemOf(() => A.resolveSetup(noProject, null)), 'needs-project');
    assert.equal(
      problemOf(() => A.resolveSetup({ ...noProject, ineligibleTiers: PERSONAL_LOAD.ineligibleTiers }, null)),
      'personal-unsupported'
    );
  });

  test('the observed personal-account answer is "personal login unsupported"', () => {
    const error = (() => {
      try {
        A.resolveSetup(PERSONAL_LOAD, null);
      } catch (e) {
        return e;
      }
    })();
    assert.ok(error instanceof Kit.ProviderError);
    assert.equal(error.code, 'unsupported');
    assert.equal(error.problem, 'personal-unsupported');
    assert.match(error.message, /UNSUPPORTED_CLIENT/);
    assert.ok(!error.message.includes('synthetic'), 'reasonMessage is not copied');
    assert.deepEqual(Kit.errorKeyText(error, GEMINI_BRAND, 'en'), {
      title: 'Not supported',
      message: 'Personal login unsupported',
    });
    assert.deepEqual(Kit.errorKeyText(error, GEMINI_BRAND, 'zh'), {
      title: '不支持',
      message: '个人账号已不支持',
    });
  });

  test('reason codes map to problems; unknown codes are handled', () => {
    const tiers = (reasonCode, tierId = 'standard-tier') => ({ ineligibleTiers: [{ reasonCode, tierId }] });
    assert.equal(A.ineligibleProblem([{ reasonCode: 'UNSUPPORTED_LOCATION' }]), 'region');
    assert.equal(A.ineligibleProblem([{ reasonCode: 'UNKNOWN_LOCATION' }]), 'region');
    assert.equal(A.ineligibleProblem([{ reasonCode: 'RESTRICTED_AGE', tierId: 'standard-tier' }]), 'not-eligible');
    assert.equal(A.ineligibleProblem([{ reasonCode: 'SOMETHING_NEW', tierId: 'free-tier' }]), 'personal-unsupported');
    assert.equal(A.ineligibleProblem([{ reasonCode: 'SOMETHING_NEW' }]), 'not-eligible');
    assert.equal(A.ineligibleProblem([{}]), 'not-eligible');
    assert.equal(
      problemOf(() => A.resolveSetup({ ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED', validationUrl: 'https://example.com/verify' }] }, null)),
      'verify-account'
    );
    assert.equal(problemOf(() => A.resolveSetup(tiers('RESTRICTED_NETWORK'), null)), 'not-eligible');
  });

  test('a login the CLI never set up is not onboarded here', () => {
    // free tier would be onboarded by the CLI
    assert.equal(
      problemOf(() => A.resolveSetup({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }, null)),
      'needs-setup'
    );
    // standard tier with a user project needs the project
    assert.equal(
      problemOf(() => A.resolveSetup({ allowedTiers: [{ id: 'standard-tier', isDefault: true, userDefinedCloudaicompanionProject: true }] }, null)),
      'needs-project'
    );
    assert.equal(problemOf(() => A.resolveSetup({}, 'my-project-1')), 'needs-setup');
    assert.equal(problemOf(() => A.resolveSetup(null, null)), 'parse');
  });

  test('request body and User-Agent match the CLI', () => {
    assert.deepEqual(A.loadCodeAssistBody(null), {
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    });
    assert.deepEqual(A.loadCodeAssistBody('p-1'), {
      cloudaicompanionProject: 'p-1',
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', duetProject: 'p-1' },
    });
    assert.match(A.userAgent('0.40.1'), /^GeminiCLI\/0\.40\.1\/gemini-2\.5-pro \(\w+; \w+; flexbar\)$/);
  });
});

// --- files -------------------------------------------------------------------

describe('settings.json and oauth_creds.json', () => {
  test('login type: current and legacy settings, comments, missing or broken files', async () => {
    assert.equal(await C.readAuthType(geminiHome({ authType: 'gemini-api-key' })), 'gemini-api-key');
    const jsonc = geminiHome({
      settings: '// my settings\n{\n  /* auth */ "security": {"auth": {"selectedType": "vertex-ai"}},\n  "url": "https://example.com/a//b" // trailing\n}\n',
    });
    assert.equal(await C.readAuthType(jsonc), 'vertex-ai');
    assert.equal(await C.readAuthType(geminiHome({ settings: '{"selectedAuthType": "oauth-personal"}' })), 'oauth-personal');
    assert.equal(await C.readAuthType(geminiHome({ settings: '{"security": ' })), null);
    assert.equal(await C.readAuthType(geminiHome({ authType: null })), null);
    assert.equal(await C.readAuthType(path.join(empty, 'missing')), null);
    assert.equal(C.stripJsonComments('{"a": "x // y", "b": "\\" /* z */"}'), '{"a": "x // y", "b": "\\" /* z */"}');
  });

  test('the token pair is read; a missing file is no login', async () => {
    const creds = await C.readOAuthCreds(geminiHome());
    assert.deepEqual(creds, { accessToken: ACCESS, refreshToken: REFRESH, expiryDate: T0 + 24 * 3_600_000 });
    assert.equal(await C.readOAuthCreds(geminiHome({ creds: null })), null);
    assert.equal(await C.readOAuthCreds(geminiHome({ creds: '{"scope": "openid"}' })), null);
  });

  test('a half-written file is read again; a broken one never quotes its content', async () => {
    const home = geminiHome({ creds: `{"access_token": "${ACCESS}", "refresh_` });
    const fixed = sleep(10).then(() =>
      fs.writeFileSync(path.join(home, 'oauth_creds.json'), JSON.stringify({ access_token: ACCESS, expiry_date: T0 }))
    );
    const creds = await C.readOAuthCreds(home, 60);
    await fixed;
    assert.equal(creds.accessToken, ACCESS);

    const broken = geminiHome({ creds: `{"access_token": "${ACCESS}", "refresh_token": "${REFRESH}"` });
    const error = await rejectsWith(C.readOAuthCreds(broken, 5), e => {
      assert.equal(e.problem, 'creds-unreadable');
      assert.equal(e.code, 'parse');
    });
    assertNoSecrets(error.message);
    assertNoSecrets(T.geminiErrorText(error));
  });
});

// --- CLI and OAuth client ------------------------------------------------------

describe('Gemini CLI discovery', () => {
  test('a symlinked program leads to its package and client', async () => {
    const cli = cliInstall();
    const found = await L.findGeminiCli({}, { dirs: [path.join(empty, 'nothing'), path.dirname(cli.bin)], home: empty });
    assert.equal(found.bin, cli.bin);
    assert.equal(found.root, fs.realpathSync(cli.pkg));
    assert.equal(found.version, '0.36.0');
    assert.deepEqual(await L.readOAuthClient(found.root), { id: CID, secret: CSEC });
  });

  test('the geminiPath setting is used alone: program, package folder or missing', async () => {
    const cli = cliInstall({ version: '0.46.0' });
    const viaBin = await L.findGeminiCli({ geminiPath: cli.bin }, { dirs: [], home: empty });
    assert.equal(viaBin.version, '0.46.0');
    const viaDir = await L.findGeminiCli({ geminiPath: cli.pkg }, { dirs: [], home: empty });
    assert.equal(viaDir.root, fs.realpathSync(cli.pkg));
    assert.equal(await L.findGeminiCli({ geminiPath: path.join(empty, 'nope') }, { dirs: [path.dirname(cli.bin)], home: empty }), null);
    assert.equal(await L.findGeminiCli({ geminiPath: tmpDir('not-a-package') }, { dirs: [], home: empty }), null);
    assert.equal(await L.findGeminiCli({}, { dirs: [tmpDir('empty-bin')], home: empty }), null);
  });

  test('npm layout: the client comes from gemini-cli-core', async () => {
    const prefix = tmpDir('npm');
    const nm = path.join(prefix, 'lib', 'node_modules', '@google');
    const pkg = path.join(nm, 'gemini-cli');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.30.0' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '');
    const core = path.join(nm, 'gemini-cli-core', 'dist', 'src', 'code_assist');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(core, 'oauth2.js'), `const OAUTH_CLIENT_ID = '${CID}';\nconst OAUTH_CLIENT_SECRET = '${CSEC}';\n`);
    fs.mkdirSync(path.join(prefix, 'bin'));
    fs.symlinkSync(path.join(pkg, 'dist', 'index.js'), path.join(prefix, 'bin', 'gemini'));
    const found = await L.findGeminiCli({}, { dirs: [path.join(prefix, 'bin')], home: empty });
    assert.equal(found.version, '0.30.0');
    assert.deepEqual(await L.readOAuthClient(found.root), { id: CID, secret: CSEC });
  });

  test('no client in the bundle is a cached miss', async () => {
    const cli = cliInstall({ withClient: false });
    assert.equal(await L.readOAuthClient(cli.pkg), null);
    // a cached miss: adding the client later is only seen after an update
    fs.writeFileSync(path.join(cli.pkg, 'bundle', 'chunk-late.js'), `var OAUTH_CLIENT_ID = "${CID}"; var OAUTH_CLIENT_SECRET = "${CSEC}";`);
    assert.equal(await L.readOAuthClient(cli.pkg), null);
    const pj = path.join(cli.pkg, 'package.json');
    fs.writeFileSync(pj, JSON.stringify({ name: '@google/gemini-cli', version: '0.36.1' }));
    fs.utimesSync(pj, new Date(T0 + 5000), new Date(T0 + 5000));
    assert.deepEqual(await L.readOAuthClient(cli.pkg), { id: CID, secret: CSEC });
  });

  test('clientFromSource needs both constants in their real shapes', () => {
    assert.equal(L.clientFromSource('OAUTH_CLIENT_ID = "abc"; OAUTH_CLIENT_SECRET = "x"'), null);
    assert.equal(L.clientFromSource(`OAUTH_CLIENT_ID = "${CID}"`), null);
    assert.deepEqual(L.clientFromSource(`OAUTH_CLIENT_ID="${CID}",OAUTH_CLIENT_SECRET=\`${CSEC}\``), { id: CID, secret: CSEC });
  });
});

// --- the source ----------------------------------------------------------------

describe('Gemini usage source', () => {
  test('a valid login reads tier, project and quota (token never refreshed)', async () => {
    const net = stubNetwork({ load: { body: STANDARD_LOAD }, quota: { body: { buckets: BUCKETS } } });
    const { src } = source({ net });
    const config = { geminiDir: geminiHome() };
    const metrics = await src.fetch(config);
    assert.equal(metrics[0].id, 'lowest');
    assert.equal(src.defaultMetric, 'lowest');
    assert.deepEqual(net.calls.map(c => c.name), ['load', 'quota']);
    const [load, quota] = net.calls;
    assert.equal(load.url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    assert.equal(load.init.method, 'POST');
    assert.equal(load.init.headers.Authorization, `Bearer ${ACCESS}`);
    assert.match(load.init.headers['User-Agent'], /^GeminiCLI\//);
    assert.deepEqual(JSON.parse(load.body), A.loadCodeAssistBody(null));
    assert.deepEqual(JSON.parse(quota.body), { project: PROJECT });
    assert.equal(src.lastSetup().tierName, 'Gemini Code Assist Standard');
  });

  test('the project is looked up hourly; quota every fetch; at most one round per 30 s', async () => {
    const net = stubNetwork({ load: { body: STANDARD_LOAD }, quota: { body: { buckets: BUCKETS } } });
    const { src, clock } = source({ net });
    const config = { geminiDir: geminiHome() };
    await src.fetch(config);
    clock.now += 10_000;
    await src.fetch(config); // within the gap: cached
    assert.equal(net.calls.length, 2);
    clock.now += 30_000;
    await src.fetch(config);
    assert.deepEqual(net.calls.map(c => c.name), ['load', 'quota', 'quota']);
    clock.now += 61 * 60_000;
    await src.fetch({ ...config, geminiDir: config.geminiDir }); // same login
    assert.equal(net.count('load'), 2);
  });

  test('an expired token is refreshed in memory, once, with the CLI client', async () => {
    const net = stubNetwork({
      token: { body: { access_token: ACCESS_NEW, expires_in: 3599, token_type: 'Bearer' } },
      load: { body: STANDARD_LOAD },
      quota: { body: { buckets: BUCKETS } },
    });
    const cli = cliInstall();
    const { src, clock } = source({ net, cli });
    const home = geminiHome({ creds: 'expired' });
    const credsFile = path.join(home, 'oauth_creds.json');
    const before = fs.readFileSync(credsFile, 'utf8');
    const mtime = fs.statSync(credsFile).mtimeMs;

    // two keys asking at once share one refresh
    await Promise.all([src.fetch({ geminiDir: home }), src.describe({ geminiDir: home })]);
    assert.equal(net.count('token'), 1);
    assert.deepEqual(net.calls.map(c => c.name), ['token', 'load', 'quota']);
    const token = net.calls.find(c => c.name === 'token');
    assert.equal(token.url, 'https://oauth2.googleapis.com/token');
    assert.equal(token.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(token.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), REFRESH);
    assert.equal(form.get('client_id'), CID);
    assert.equal(form.get('client_secret'), CSEC);
    for (const call of net.calls.filter(c => c.name !== 'token')) {
      assert.equal(call.init.headers.Authorization, `Bearer ${ACCESS_NEW}`);
    }
    // the refreshed token is reused, and Gemini CLI's file is never written
    clock.now += 31_000;
    await src.fetch({ geminiDir: home });
    assert.equal(net.count('token'), 1);
    assert.equal(fs.readFileSync(credsFile, 'utf8'), before);
    assert.equal(fs.statSync(credsFile).mtimeMs, mtime);
    // a new login (other refresh token) is refreshed again
    clock.now += 31_000;
    fs.writeFileSync(credsFile, JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH_OTHER, expiry_date: T0 - 1 }));
    await src.fetch({ geminiDir: home });
    assert.equal(net.count('token'), 2);
  });

  test('a 401 forces one refresh and a retry; a second 401 is "login expired"', async () => {
    let loads = 0;
    const net = stubNetwork({
      token: { body: { access_token: ACCESS_NEWER, expires_in: 3599 } },
      load: () => (++loads === 1 ? { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } } : { body: STANDARD_LOAD }),
      quota: { body: { buckets: BUCKETS } },
    });
    const { src } = source({ net, cli: cliInstall() });
    const metrics = await src.fetch({ geminiDir: geminiHome() });
    assert.ok(metrics.length > 0);
    assert.deepEqual(net.calls.map(c => c.name), ['load', 'token', 'load', 'quota']);
    assert.equal(net.calls[2].init.headers.Authorization, `Bearer ${ACCESS_NEWER}`);

    const net2 = stubNetwork({
      token: { body: { access_token: ACCESS_NEWER, expires_in: 3599 } },
      load: { status: 401, body: {} },
    });
    const { src: src2 } = source({ net: net2, cli: cliInstall() });
    await rejectsWith(src2.fetch({ geminiDir: geminiHome() }), e => {
      assert.equal(e.problem, 'login-expired');
      assert.equal(e.code, 'unauthorized');
    });
    assert.equal(net2.count('load'), 2);
  });

  test('refresh failures: invalid_grant, no CLI, no client, rate limit, network', async () => {
    const expired = () => ({ geminiDir: geminiHome({ creds: 'expired' }) });

    const grant = stubNetwork({ token: { status: 400, body: { error: 'invalid_grant', error_description: `bad ${REFRESH}` } } });
    let e = await rejectsWith(source({ net: grant, cli: cliInstall() }).src.fetch(expired()), err => {
      assert.equal(err.problem, 'login-expired');
    });
    assert.match(e.message, /HTTP 400 invalid_grant/);
    assertNoSecrets(e.message);

    const none = stubNetwork({});
    await rejectsWith(source({ net: none }).src.fetch(expired()), err => assert.equal(err.problem, 'cli-missing'));
    await rejectsWith(source({ net: none, cli: cliInstall({ withClient: false }) }).src.fetch(expired()), err =>
      assert.equal(err.problem, 'login-expired')
    );
    assert.equal(none.calls.length, 0);

    const limited = stubNetwork({ token: { status: 429, headers: { 'Retry-After': '120' } } });
    e = await rejectsWith(source({ net: limited, cli: cliInstall() }).src.fetch(expired()), err => {
      assert.equal(err.code, 'rate-limited');
    });
    assert.equal(Kit.lockoutSeconds(e), 120);

    const offline = stubNetwork({ token: new TypeError(`fetch failed for ${ACCESS}`) });
    e = await rejectsWith(source({ net: offline, cli: cliInstall() }).src.fetch(expired()), err => {
      assert.equal(err.code, 'network');
    });
    assertNoSecrets(e.message);

    const garbled = stubNetwork({ token: { body: `{"access_token": "${ACCESS_NEW}"` } });
    e = await rejectsWith(source({ net: garbled, cli: cliInstall() }).src.fetch(expired()), err => {
      assert.equal(err.code, 'parse');
    });
    assertNoSecrets(e.message);
  });

  test('the personal-account answer is cached: no requests for hours', async () => {
    const net = stubNetwork({ load: { body: PERSONAL_LOAD } });
    const { src, clock } = source({ net });
    const config = { geminiDir: geminiHome() };
    await rejectsWith(src.fetch(config), e => assert.equal(e.problem, 'personal-unsupported'));
    for (let i = 0; i < 10; i++) {
      clock.now += 180_000;
      await rejectsWith(src.fetch(config), e => assert.equal(e.problem, 'personal-unsupported'));
    }
    assert.equal(net.calls.length, 1);
    assert.equal(src.keepLastOnError(new Kit.ProviderError('network', 'x')), false);
    // a project setting is a new question
    clock.now += 31_000;
    await rejectsWith(src.fetch({ ...config, geminiCloudProject: 'my-project-1' }), e =>
      assert.equal(e.problem, 'needs-setup')
    );
    assert.equal(net.calls.length, 2);
    clock.now += 7 * 60 * 60_000;
    await rejectsWith(src.fetch(config), () => undefined);
    assert.equal(net.calls.length, 3);
  });

  test('a configured project: used when the tier has none, refused → "check project"', async () => {
    const noProjectLoad = { currentTier: { id: 'standard-tier', userDefinedCloudaicompanionProject: true } };
    const net = stubNetwork({ load: { body: noProjectLoad }, quota: { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } } });
    const { src, clock } = source({ net });
    const config = { geminiDir: geminiHome(), geminiCloudProject: ' my-project-1 ' };
    const e = await rejectsWith(src.fetch(config), err => assert.equal(err.problem, 'project-denied'));
    assert.match(e.message, /HTTP 403 PERMISSION_DENIED/);
    assert.deepEqual(JSON.parse(net.calls[0].body).cloudaicompanionProject, 'my-project-1');
    assert.deepEqual(JSON.parse(net.calls[1].body), { project: 'my-project-1' });
    // the setup is looked up again after a refusal
    clock.now += 31_000;
    await rejectsWith(src.fetch(config), () => undefined);
    assert.equal(net.count('load'), 2);

    // GOOGLE_CLOUD_PROJECT works like the setting; without either: "set project"
    assert.equal(U.configuredProject({}, { GOOGLE_CLOUD_PROJECT: 'env-project-1' }), 'env-project-1');
    assert.equal(U.configuredProject({ geminiCloudProject: '' }, { GOOGLE_CLOUD_PROJECT_ID: 'env-project-2' }), 'env-project-2');
    const net2 = stubNetwork({ load: { body: noProjectLoad } });
    await rejectsWith(source({ net: net2 }).src.fetch({ geminiDir: geminiHome() }), err => {
      assert.equal(err.problem, 'needs-project');
      assert.deepEqual(Kit.errorKeyText(err, GEMINI_BRAND, 'zh'), { title: '缺少项目', message: '请在插件设置中填写 Cloud 项目' });
    });
  });

  test('login types without quota never read the login or call Google', async () => {
    const net = stubNetwork({});
    const { src } = source({ net });
    const cases = [
      ['gemini-api-key', 'api-key', 'API key login', 'API Key 登录'],
      ['vertex-ai', 'vertex', 'Vertex AI login', 'Vertex AI 登录'],
      ['cloud-shell', 'other-auth', 'Use Login with Google', '请使用 Google 登录'],
      ['compute-default-credentials', 'other-auth', 'Use Login with Google', '请使用 Google 登录'],
    ];
    for (const [authType, problem, en, zh] of cases) {
      // an unreadable oauth_creds.json proves the login is not read
      const home = geminiHome({ authType, creds: '{broken' });
      await rejectsWith(src.fetch({ geminiDir: home, geminiPath: authType }), e => {
        assert.equal(e.problem, problem);
        assert.equal(e.code, 'unsupported');
        assert.equal(Kit.errorKeyText(e, GEMINI_BRAND, 'en').message, en);
        assert.equal(Kit.errorKeyText(e, GEMINI_BRAND, 'zh').message, zh);
      });
    }
    assert.equal(net.calls.length, 0);
  });

  test('no login: "not installed" without CLI and folder, else "not logged in"', async () => {
    const net = stubNetwork({});
    await rejectsWith(source({ net }).src.fetch({ geminiDir: path.join(empty, 'never-created') }), e => {
      assert.equal(e.problem, 'cli-missing');
      assert.equal(e.code, 'not-installed');
      assert.deepEqual(Kit.errorKeyText(e, GEMINI_BRAND, 'en'), { title: 'Not installed', message: 'Gemini CLI not found' });
      assert.deepEqual(Kit.errorKeyText(e, GEMINI_BRAND, 'zh'), { title: '未安装', message: '未找到 Gemini CLI' });
    });
    await rejectsWith(source({ net }).src.fetch({ geminiDir: geminiHome({ creds: null }) }), e => {
      assert.equal(e.problem, 'logged-out');
      assert.deepEqual(Kit.errorKeyText(e, GEMINI_BRAND, 'zh'), { title: '未登录', message: '请先登录 gemini' });
    });
    await rejectsWith(
      source({ net, cli: cliInstall() }).src.fetch({ geminiDir: path.join(empty, 'never-created-2') }),
      e => assert.equal(e.problem, 'logged-out')
    );
    assert.equal(net.calls.length, 0);
  });

  test('server errors: rate limit, 5xx, broken JSON, empty quota', async () => {
    const home = geminiHome();
    let e = await rejectsWith(
      source({ net: stubNetwork({ load: { status: 429, headers: { 'Retry-After': '90' } } }) }).src.fetch({ geminiDir: home }),
      err => assert.equal(err.code, 'rate-limited')
    );
    assert.equal(e.retryAfterSeconds, 90);
    e = await rejectsWith(
      source({ net: stubNetwork({ load: { body: STANDARD_LOAD }, quota: { status: 503, body: { error: { status: 'UNAVAILABLE' } } } }) }).src.fetch({ geminiDir: home }),
      err => assert.equal(err.code, 'http')
    );
    assert.match(e.message, /HTTP 503 UNAVAILABLE/);
    assert.deepEqual(Kit.errorKeyText(e, GEMINI_BRAND, 'en'), { title: 'Usage error', message: 'HTTP 503' });
    await rejectsWith(
      source({ net: stubNetwork({ load: { body: '<html>' } }) }).src.fetch({ geminiDir: home }),
      err => assert.equal(err.code, 'parse')
    );
    await rejectsWith(
      source({ net: stubNetwork({ load: { body: STANDARD_LOAD }, quota: { body: { buckets: [] } } }) }).src.fetch({ geminiDir: home }),
      err => assert.equal(err.problem, 'no-quota')
    );
    await rejectsWith(
      source({ net: stubNetwork({ load: { status: 500 } }) }).src.fetch({ geminiDir: home }),
      err => assert.match(err.message, /loadCodeAssist failed with HTTP 500/)
    );
  });

  test('the last meter stays through blips for 30 minutes after a success', async () => {
    let fail = false;
    const net = stubNetwork({
      load: { body: STANDARD_LOAD },
      quota: () => (fail ? new TypeError('fetch failed') : { body: { buckets: BUCKETS } }),
    });
    const { src, clock } = source({ net });
    const config = { geminiDir: geminiHome() };
    assert.equal(src.keepLastOnError(new Kit.ProviderError('network', 'x')), false);
    await src.fetch(config);
    fail = true;
    clock.now += 31_000;
    const e = await rejectsWith(src.fetch(config), err => assert.equal(err.code, 'network'));
    assert.equal(src.keepLastOnError(e), true);
    assert.equal(src.keepLastOnError(new Kit.ProviderError('http', 'HTTP 502')), true);
    assert.equal(src.keepLastOnError(new T.GeminiUsageError('login-expired', 'x')), false);
    assert.equal(src.keepLastOnError(new Error('x')), false);
    clock.now += 31 * 60_000;
    assert.equal(src.keepLastOnError(e), false);
  });

  test('describe: metrics and tier for the settings page, or a safe error', async () => {
    const net = stubNetwork({ load: { body: STANDARD_LOAD }, quota: { body: { buckets: BUCKETS } } });
    const { src } = source({ net });
    const home = geminiHome();
    const ok = await src.describe({ geminiDir: home });
    assert.equal(ok.success, true);
    assert.equal(ok.tier, 'Gemini Code Assist Standard');
    assert.equal(ok.metrics[0].id, 'lowest');
    await src.describe({ geminiDir: home }); // fresh: no new requests
    assert.equal(net.calls.length, 2);

    const bad = await source({ net: stubNetwork({ load: { body: PERSONAL_LOAD } }) }).src.describe({ geminiDir: home });
    assert.equal(bad.success, false);
    assert.equal(bad.problem, 'personal-unsupported');
    assert.match(bad.error, /no Gemini CLI quota for this personal Google account/);
    assert.doesNotMatch(bad.error, /2026/, 'no unverified date');
  });
});

describe('log text', () => {
  test('Google tokens, client secrets and ids are masked', () => {
    const text = T.geminiErrorText(new Error(`boom ${ACCESS} ${REFRESH} ${CSEC} ${CID} Bearer ${ACCESS_NEW}`));
    assertNoSecrets(text);
    assert.match(text, /^boom \[redacted\]/);
    assert.equal(T.redactGoogle('path/1//x is fine? '), 'path/1//x is fine? ');
    const own = new T.GeminiUsageError('logged-out', 'No login');
    assert.equal(T.geminiErrorText(own), 'No login');
    assert.ok(T.geminiErrorText(new Error('x'.repeat(500))).length <= 241);
  });

  test('every problem has en and zh texts and a known code', () => {
    const problems = ['cli-missing', 'logged-out', 'creds-unreadable', 'login-expired', 'personal-unsupported', 'not-eligible', 'region', 'verify-account', 'api-key', 'vertex', 'other-auth', 'needs-project', 'project-denied', 'needs-setup', 'no-quota'];
    for (const problem of problems) {
      const text = T.problemText(problem);
      for (const lang of ['en', 'zh']) {
        assert.ok(text[lang].title && text[lang].message, `${problem} ${lang}`);
      }
      const error = new T.GeminiUsageError(problem, 'x');
      assert.ok(error instanceof Kit.ProviderError);
      assert.equal(Kit.errorKeyText(error, GEMINI_BRAND, 'zh').title, text.zh.title);
    }
  });
});

// --- the key group ---------------------------------------------------------------

/** [width, height] of a PNG data URL. */
function pngSize(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function keyGroup(src, config) {
  const cid = Kit.keyCid('gemini', 'usage');
  const sent = [];
  let chain = Promise.resolve();
  const keys = new UsageKeys({
    enqueue: task => (chain = chain.then(task).catch(() => undefined)),
    send: async (_serial, key, image) => sent.push([key.uid, image]),
    isOffline: () => false,
    keyWidth: key => key.width,
    bgColor: () => undefined,
    loadConfig: async () => config,
    pollIntervalMs: () => 3_600_000,
    provider: { cid, brand: GEMINI_BRAND, source: src },
  });
  const settle = async () => {
    await chain;
    await sleep(5);
    await chain;
  };
  return { cid, sent, keys, settle };
}

describe('Gemini usage key', () => {
  test('exports usageSource', () => {
    assert.equal(typeof U.usageSource.fetch, 'function');
    assert.equal(U.usageSource.defaultMetric, 'lowest');
  });

  test('without Gemini data, fetch rejects with a ProviderError', async () => {
    await assert.rejects(U.usageSource.fetch(CONFIG), error => {
      assert.ok(error instanceof Kit.ProviderError, `${error}`);
      assert.equal(error.problem, 'cli-missing');
      return true;
    });
  });

  test('the key draws a 60px face from that, without network', async () => {
    const { cid, sent, keys, settle } = keyGroup(U.usageSource, CONFIG);
    try {
      await keys.alive('FAKE-DEVICE-1', [
        { uid: 1, cid, width: 120, data: { metric: '' } },
        { uid: 2, cid, width: 60, data: { metric: '', lang: 'zh' } },
      ]);
      await settle();
      assert.ok(sent.length >= 2);
      for (const [uid, image] of sent) {
        assert.deepEqual(pngSize(image), [uid === 1 ? 120 : 60, 60]);
      }
    } finally {
      keys.stop();
    }
  });

  test('meters from a fixture login; the settings page reply', async () => {
    const net = stubNetwork({ load: { body: STANDARD_LOAD }, quota: { body: { buckets: BUCKETS } } });
    const { src } = source({ net });
    const config = { geminiDir: geminiHome() };
    const { cid, sent, keys, settle } = keyGroup(src, config);
    try {
      await keys.alive('FAKE-DEVICE-1', [
        { uid: 1, cid, width: 240, data: { metric: '' } },
        { uid: 2, cid, width: 360, data: { metric: 'pooled' } },
        { uid: 3, cid, width: 120, data: { metric: 'model:gemini-2.5-flash' } },
      ]);
      await settle();
      assert.ok(sent.length >= 3);
      for (const [uid, image] of sent) {
        assert.deepEqual(pngSize(image), [{ 1: 240, 2: 360, 3: 120 }[uid], 60]);
      }
      const reply = await keys.message({ data: 'usage-status', cid, settings: { metric: '' } });
      assert.equal(reply.success, true);
      assert.equal(net.count('quota'), 1);
    } finally {
      keys.stop();
    }
  });
});
