// Tests for the Claude proxy support: proxy resolution (src/proxyConfig.ts:
// claudeProxy setting, HTTPS_PROXY / NO_PROXY, `scutil --proxy` output), the
// CONNECT tunnel and its direct fallback (src/proxyTunnel.ts, src/proxy.ts),
// the 403 "forbidden" mapping of the usage client (src/api.ts,
// src/providers/claude/usage.ts), the token refresh through the proxy and the
// Keychain write through `security -i` (src/credentials.ts, src/keychain.ts).
// Claude Code's login state and refresh lock: scripts/test-claude-login.mjs.
// Run against the tsc output of `npm run test:claude-proxy`
// (.test-build-claude-proxy/). Rules: synthetic fixtures only (see CLAUDE.md),
// no network (fetch is stubbed; proxies and targets are local servers on
// 127.0.0.1), no programs (child_process is stubbed: never the real Keychain
// or scutil), HOME points at an empty temp folder, token-shaped strings are
// built at runtime.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-test-'));
process.env.HOME = empty;
process.env.USERPROFILE = empty;
process.env.USER = 'you';
for (const name of [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CREDENTIALS_PATH',
  'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
]) {
  delete process.env[name];
}
after(() => fs.rmSync(empty, { recursive: true, force: true }));

// --- network: fetch is a stub that records its calls ----------------------------
const fetched = [];
let fetchReply = null;
globalThis.fetch = async (url, init = {}) => {
  fetched.push({ url: String(url), init });
  if (!fetchReply) throw new Error('network is disabled in tests');
  return fetchReply(String(url), init);
};
beforeEach(() => {
  fetched.length = 0;
  fetchReply = null;
});

// --- programs: child_process is stubbed before any module under test loads ------
const proc = { execFile: null, spawn: null, calls: [] };
const blocked = name => () => {
  throw new Error(`${name} is disabled in tests`);
};
function execFileStub(file, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  proc.calls.push({ kind: 'execFile', file, args: [...args] });
  if (!proc.execFile) throw new Error('execFile is disabled in tests');
  const result = proc.execFile(file, args);
  setImmediate(() =>
    result.error
      ? cb(result.error, '', result.stderr ?? '')
      : cb(null, result.stdout ?? '', '')
  );
  return new EventEmitter();
}
execFileStub[promisify.custom] = (file, args, options) =>
  new Promise((resolve, reject) =>
    execFileStub(file, args, options ?? {}, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr })
    )
  );
childProcess.execFile = execFileStub;
childProcess.spawn = (file, args, options) => {
  proc.calls.push({ kind: 'spawn', file, args: [...args] });
  if (!proc.spawn) throw new Error('spawn is disabled in tests');
  return proc.spawn(file, args, options);
};
for (const name of ['exec', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
  childProcess[name] = blocked(name);
}
beforeEach(() => {
  proc.execFile = null;
  proc.spawn = null;
  proc.calls.length = 0;
});

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const build =
  process.env.CLAUDE_PROXY_TEST_BUILD ??
  path.join(root, '.test-build-claude-proxy');
// the usage client loads the FlexDesigner SDK; the real one connects to the
// app on load, so a stand-in is cached
const sdk = require.resolve('@eniac/flexdesigner', { paths: [build] });
require.cache[sdk] = {
  id: sdk,
  filename: sdk,
  loaded: true,
  exports: { logger: undefined, plugin: undefined },
};
const req = p => require(path.join(build, p));
const PC = req('proxyConfig.js');
const P = req('proxy.js');
const T = req('proxyTunnel.js');
const K = req('keychain.js');
const Api = req('api.js');
const Creds = req('credentials.js');
const ClaudeUsage = req('providers/claude/usage.js');

// --- synthetic values (built at runtime, never real) ------------------------------
const fakeToken = (kind, n) =>
  ['sk', 'ant', kind, 'FAKE', String(n).padStart(24, '0')].join('-');
const ACCESS = fakeToken('oat01', 1);
const ACCESS_NEW = fakeToken('oat01', 2);
const REFRESH = fakeToken('ort01', 1);
const REFRESH_NEW = fakeToken('ort01', 2);
const PROXY_USER = 'you';
const PROXY_PASS = ['fake', 'pw', '7'].join('-');
const SERVICE = 'Claude Code-credentials';
const HOUR = 3_600_000;

function logs() {
  const lines = [];
  const push = level => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

let tmpCount = 0;
function credentialsFile(fields) {
  const file = path.join(empty, `credentials-${++tmpCount}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: Date.now() + HOUR,
        scopes: ['user:inference'],
        ...fields,
      },
      mcpOAuth: { example: { note: 'kept as is' } },
    })
  );
  return file;
}

// --- local servers ----------------------------------------------------------------
const servers = [];
async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const entry = {
    server,
    port: server.address().port,
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(entry);
  return entry;
}
after(async () => {
  for (const entry of servers) await entry.close();
});

/** A port nothing listens on. */
async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** A local HTTP target that records each request and answers with `handler`. */
async function target(handler) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      handler(entry, response);
    });
  });
  const entry = await listen(server);
  return { ...entry, seen };
}

/**
 * A fake HTTP proxy: records each CONNECT (method, path, headers). Modes:
 * 'tunnel' answers 200 and pipes to `upstreamPort` on 127.0.0.1 whatever
 * host the CONNECT names, 'status' answers `status`, 'silent' never answers.
 */
async function fakeProxy({ mode = 'tunnel', status = 502, upstreamPort } = {}) {
  const seen = [];
  const server = net.createServer(client => {
    client.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const [requestLine, ...lines] = buffered
        .subarray(0, end)
        .toString('latin1')
        .split('\r\n');
      const rest = buffered.subarray(end + 4);
      const [method, target] = requestLine.split(' ');
      const headers = Object.fromEntries(
        lines.map(line => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        })
      );
      seen.push({ method, path: target, headers });
      if (mode === 'silent') return;
      if (mode === 'status') {
        client.end(`HTTP/1.1 ${status} Proxy Error\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  const entry = await listen(server);
  return { ...entry, seen, url: `http://127.0.0.1:${entry.port}` };
}

/** A router that never looks at the real environment or system proxy. */
function router(overrides = {}) {
  return P.createProxyRouter({
    env: {},
    platform: 'linux',
    readSystemProxy: async () => {
      throw new Error('no system proxy in this test');
    },
    ...overrides,
  });
}

// --- scutil --proxy output (synthetic) --------------------------------------------

const SCUTIL_HTTPS_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSEnable : 1
      HTTPSPort : 9999
      HTTPSProxy : 10.0.0.9
    }
  }
}
`;

const SCUTIL_HTTP_ONLY = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 10.1.2.3
  HTTPSEnable : 0
  HTTPSPort : 9443
  HTTPSProxy : 10.9.9.9
  ProxyAutoConfigEnable : 0
}
`;

const SCUTIL_OFF = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}
`;

const SCUTIL_EXCEPTIONS = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : *.example.com
    3 : example.org
    4 : 10.0.0.0/8
    5 : 192.168.1.*
  }
  ExcludeSimpleHostnames : 1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}
`;

const SCUTIL_PAC = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:9/proxy.pac
}
`;

const SCUTIL_SOCKS_ONLY = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}
`;

const HTTPS_TARGET = new URL('https://api.anthropic.com/api/oauth/usage');
const at = host => new URL(`https://${host}/x`);

describe('scutil --proxy output', () => {
  test('HTTPS on: the top-level HTTPS proxy, exceptions and flags', () => {
    const config = PC.parseScutilProxy(SCUTIL_HTTPS_ON);
    assert.deepEqual(config.https, { host: '127.0.0.1', port: 7897 });
    assert.deepEqual(config.http, { host: '127.0.0.1', port: 7897 });
    assert.deepEqual(config.exceptions, ['*.local', '169.254/16']);
    assert.equal(config.excludeSimpleHostnames, true);
    assert.equal(config.autoConfig, false);
    assert.equal(config.socks, true);
  });

  test('keys inside nested dictionaries (__SCOPED__) are ignored', () => {
    const config = PC.parseScutilProxy(SCUTIL_HTTPS_ON);
    assert.notEqual(config.https.host, '10.0.0.9');
    assert.notEqual(config.https.port, 9999);
  });

  test('only HTTP on: no HTTPS proxy, a disabled group is not reported', () => {
    const config = PC.parseScutilProxy(SCUTIL_HTTP_ONLY);
    assert.equal(config.https, null);
    assert.deepEqual(config.http, { host: '10.1.2.3', port: 8080 });
    assert.deepEqual(config.exceptions, []);
    assert.equal(config.excludeSimpleHostnames, false);
  });

  test('both off: no proxy', () => {
    const config = PC.parseScutilProxy(SCUTIL_OFF);
    assert.equal(config.https, null);
    assert.equal(config.http, null);
    assert.equal(config.socks, false);
  });

  test('a missing port is 80, an invalid one disables the group', () => {
    const noPort = PC.parseScutilProxy(
      '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n}\n'
    );
    assert.deepEqual(noPort.https, { host: '127.0.0.1', port: 80 });
    for (const port of ['abc', '0', '70000']) {
      const bad = PC.parseScutilProxy(
        `<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : ${port}\n  HTTPSProxy : 127.0.0.1\n}\n`
      );
      assert.equal(bad.https, null, port);
    }
    const noHost = PC.parseScutilProxy(
      '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n}\n'
    );
    assert.equal(noHost.https, null);
  });

  test('output that is not a proxy dictionary is null', () => {
    for (const text of [
      '',
      'scutil: command not found',
      'No such key',
      '{ "HTTPSEnable": 1 }',
      undefined,
      null,
      42,
    ]) {
      assert.equal(PC.parseScutilProxy(text), null, String(text));
    }
  });

  test('unbalanced output still yields its top-level keys', () => {
    const config = PC.parseScutilProxy(
      '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n'
    );
    assert.deepEqual(config.https, { host: '127.0.0.1', port: 7897 });
  });
});

describe('system proxy for a target', () => {
  test('an https target uses the HTTPS proxy', () => {
    const { route } = PC.systemProxyFor(HTTPS_TARGET, PC.parseScutilProxy(SCUTIL_HTTPS_ON));
    assert.deepEqual(route, {
      kind: 'proxy',
      source: 'system',
      proxy: { host: '127.0.0.1', port: 7897 },
    });
  });

  test('without an HTTPS proxy an https target uses the HTTP one', () => {
    const { route } = PC.systemProxyFor(HTTPS_TARGET, PC.parseScutilProxy(SCUTIL_HTTP_ONLY));
    assert.deepEqual(route.proxy, { host: '10.1.2.3', port: 8080 });
  });

  test('nothing enabled: no system route', () => {
    const { route, warning } = PC.systemProxyFor(HTTPS_TARGET, PC.parseScutilProxy(SCUTIL_OFF));
    assert.equal(route, null);
    assert.equal(warning, undefined);
  });

  test('ExceptionsList and ExcludeSimpleHostnames send the target direct', () => {
    const config = PC.parseScutilProxy(SCUTIL_EXCEPTIONS);
    const direct = { kind: 'direct', reason: 'exception' };
    for (const host of [
      ['printer', 'local'].join('.'),
      '169.254.10.20',
      'api.example.com',
      'example.org',
      'deep.sub.example.org',
      '10.20.30.40',
      '192.168.1.77',
      'intranet',
    ]) {
      assert.deepEqual(PC.systemProxyFor(at(host), config).route, direct, host);
    }
    for (const host of [
      'api.anthropic.com',
      'example.com',
      'notexample.org',
      '169.255.0.1',
      '11.0.0.1',
      '192.168.2.77',
    ]) {
      assert.equal(PC.systemProxyFor(at(host), config).route.kind, 'proxy', host);
    }
  });

  test('a simple host name goes through the proxy unless excluded', () => {
    const config = PC.parseScutilProxy(SCUTIL_HTTPS_ON.replace('ExcludeSimpleHostnames : 1', 'ExcludeSimpleHostnames : 0'));
    assert.equal(PC.systemProxyFor(at('intranet'), config).route.kind, 'proxy');
  });

  test('PAC and SOCKS-only setups are not supported and say so', () => {
    const pac = PC.systemProxyFor(HTTPS_TARGET, PC.parseScutilProxy(SCUTIL_PAC));
    assert.equal(pac.route, null);
    assert.match(pac.warning, /automatic proxy configuration|PAC/i);
    const socks = PC.systemProxyFor(HTTPS_TARGET, PC.parseScutilProxy(SCUTIL_SOCKS_ONLY));
    assert.equal(socks.route, null);
    assert.match(socks.warning, /SOCKS/);
  });
});

// --- setting, environment, NO_PROXY ---------------------------------------------------

describe('claudeProxy setting', () => {
  test('empty, missing or auto means automatic', () => {
    for (const value of [undefined, null, '', '   ', 'auto', 'AUTO', 42, {}]) {
      assert.deepEqual(PC.parseProxySetting(value), { mode: 'auto' }, String(value));
    }
  });

  test('direct, none and off force a direct connection', () => {
    for (const value of ['direct', 'none', 'off', ' Direct ', 'OFF']) {
      assert.deepEqual(PC.parseProxySetting(value), { mode: 'direct' }, value);
    }
  });

  test('an http proxy URL, with or without credentials or scheme', () => {
    assert.deepEqual(PC.parseProxySetting('http://127.0.0.1:7890'), {
      mode: 'proxy',
      proxy: { host: '127.0.0.1', port: 7890 },
    });
    assert.deepEqual(PC.parseProxySetting(' http://127.0.0.1:7890/ '), {
      mode: 'proxy',
      proxy: { host: '127.0.0.1', port: 7890 },
    });
    assert.deepEqual(PC.parseProxySetting('127.0.0.1:7890'), {
      mode: 'proxy',
      proxy: { host: '127.0.0.1', port: 7890 },
    });
    assert.deepEqual(
      PC.parseProxySetting(`http://${PROXY_USER}:${encodeURIComponent(`${PROXY_PASS}@x`)}@127.0.0.1:7890`),
      {
        mode: 'proxy',
        proxy: { host: '127.0.0.1', port: 7890, username: PROXY_USER, password: `${PROXY_PASS}@x` },
      }
    );
    assert.deepEqual(PC.parseProxySetting('http://[::1]:7890').proxy, { host: '::1', port: 7890 });
    assert.deepEqual(PC.parseProxySetting('http://proxy.example.com').proxy, {
      host: 'proxy.example.com',
      port: 80,
    });
  });

  test('anything else is invalid, and the problem never repeats the value', () => {
    for (const value of [
      `socks5://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:7891`,
      `https://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:7890`,
      'http://127.0.0.1:7890/some/path',
      'http://127.0.0.1:99999',
      'http://:7890',
      'not a proxy',
      'http://127.0.0.1:7890?x=1',
    ]) {
      const parsed = PC.parseProxySetting(value);
      assert.equal(parsed.mode, 'invalid', value);
      assert.equal(typeof parsed.problem, 'string');
      assert.ok(!parsed.problem.includes(PROXY_PASS), value);
      assert.ok(!parsed.problem.includes('127.0.0.1'), value);
    }
    assert.match(PC.parseProxySetting('socks5://127.0.0.1:7891').problem, /socks5/);
  });
});

describe('NO_PROXY', () => {
  const cases = [
    ['api.anthropic.com', 443, '*', true],
    ['api.anthropic.com', 443, '.anthropic.com', true],
    ['anthropic.com', 443, '.anthropic.com', true],
    ['api.anthropic.com', 443, 'anthropic.com', true],
    ['api.anthropic.com', 443, '*.anthropic.com', true],
    ['notanthropic.com', 443, 'anthropic.com', false],
    ['api.anthropic.com', 443, 'localhost,127.0.0.1,::1,.local', false],
    ['127.0.0.1', 80, 'localhost,127.0.0.1', true],
    ['localhost', 80, 'localhost', true],
    ['::1', 443, '::1', true],
    ['::1', 443, '[::1]:443', true],
    ['api.anthropic.com', 443, 'api.anthropic.com:8443', false],
    ['api.anthropic.com', 443, 'api.anthropic.com:443', true],
    ['API.Anthropic.com', 443, ' other.com , anthropic.com ', true],
    ['api.anthropic.com', 443, 'other.com anthropic.com', true],
    ['api.anthropic.com', 443, '', false],
    ['api.anthropic.com', 443, ' , ', false],
  ];
  for (const [host, port, list, expected] of cases) {
    test(`${host}:${port} with "${list}" is ${expected ? 'excluded' : 'proxied'}`, () => {
      assert.equal(PC.matchesNoProxy(host, port, list), expected);
    });
  }
});

describe('environment proxy', () => {
  const proxy = { host: '127.0.0.1', port: 7897 };

  test('HTTPS_PROXY / https_proxy for an https target', () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy']) {
      const { route } = PC.envProxyFor(HTTPS_TARGET, { [name]: 'http://127.0.0.1:7897' });
      assert.deepEqual(route, { kind: 'proxy', source: 'env', proxy }, name);
    }
  });

  test('HTTP_PROXY / http_proxy only for an http target', () => {
    const httpTarget = new URL('http://api.example.com/x');
    for (const name of ['HTTP_PROXY', 'http_proxy']) {
      const env = { [name]: 'http://127.0.0.1:7897' };
      assert.deepEqual(PC.envProxyFor(httpTarget, env).route, { kind: 'proxy', source: 'env', proxy }, name);
      assert.equal(PC.envProxyFor(HTTPS_TARGET, env).route, null, name);
    }
    assert.equal(
      PC.envProxyFor(httpTarget, { HTTPS_PROXY: 'http://127.0.0.1:7897' }).route,
      null
    );
  });

  test('NO_PROXY / no_proxy send a matching target direct', () => {
    for (const name of ['NO_PROXY', 'no_proxy']) {
      const { route } = PC.envProxyFor(HTTPS_TARGET, {
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        [name]: 'localhost,.anthropic.com',
      });
      assert.deepEqual(route, { kind: 'direct', reason: 'no-proxy' }, name);
    }
    const { route } = PC.envProxyFor(HTTPS_TARGET, {
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'localhost,127.0.0.1,::1,.local',
    });
    assert.equal(route.kind, 'proxy');
  });

  test('NO_PROXY alone changes nothing', () => {
    assert.equal(PC.envProxyFor(HTTPS_TARGET, { NO_PROXY: '*' }).route, null);
  });

  test('empty values are unset', () => {
    assert.equal(PC.envProxyFor(HTTPS_TARGET, { HTTPS_PROXY: '' }).route, null);
    assert.equal(PC.envProxyFor(HTTPS_TARGET, { HTTPS_PROXY: '  ' }).route, null);
  });

  test('a socks or https proxy is ignored with a warning that hides the value', () => {
    for (const value of [
      `socks5://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:7891`,
      `https://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:7890`,
    ]) {
      const { route, warning } = PC.envProxyFor(HTTPS_TARGET, { HTTPS_PROXY: value });
      assert.equal(route, null);
      assert.match(warning, /HTTPS_PROXY/);
      assert.ok(!warning.includes(PROXY_PASS));
    }
  });

  test('credentials in the URL are decoded', () => {
    const { route } = PC.envProxyFor(HTTPS_TARGET, {
      https_proxy: `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:7897`,
    });
    assert.deepEqual(route.proxy, { ...proxy, username: PROXY_USER, password: PROXY_PASS });
  });
});

describe('describeRoute', () => {
  const proxy = { host: '127.0.0.1', port: 7897, username: PROXY_USER, password: PROXY_PASS };
  test('names the source and the proxy, never its credentials', () => {
    assert.equal(P.describeRoute({ kind: 'proxy', source: 'system', proxy }), 'via system proxy 127.0.0.1:7897');
    assert.equal(P.describeRoute({ kind: 'proxy', source: 'env', proxy }), 'via environment proxy 127.0.0.1:7897');
    assert.equal(P.describeRoute({ kind: 'proxy', source: 'setting', proxy }), 'via proxy setting 127.0.0.1:7897');
    assert.equal(
      P.describeRoute({ kind: 'proxy', source: 'setting', proxy: { host: '::1', port: 7890 } }),
      'via proxy setting [::1]:7890'
    );
  });
  test('direct, with the reason when there is one', () => {
    assert.equal(P.describeRoute({ kind: 'direct', reason: 'none' }), 'direct');
    assert.equal(P.describeRoute({ kind: 'direct', reason: 'setting' }), 'direct (proxy setting)');
    assert.equal(P.describeRoute({ kind: 'direct', reason: 'no-proxy' }), 'direct (NO_PROXY)');
    assert.equal(P.describeRoute({ kind: 'direct', reason: 'exception' }), 'direct (system proxy exception)');
  });
});

describe('resolveProxy: priority', () => {
  const ENV = { HTTPS_PROXY: 'http://127.0.0.1:7001' };
  const counted = (text = SCUTIL_HTTPS_ON) => {
    const calls = { n: 0 };
    return { calls, readSystemProxy: async () => (calls.n++, text) };
  };

  test('the setting "direct" wins over environment and system proxy', async () => {
    const sys = counted();
    const r = router({ env: ENV, platform: 'darwin', readSystemProxy: sys.readSystemProxy });
    assert.deepEqual(await r.resolve(HTTPS_TARGET, 'direct'), { kind: 'direct', reason: 'setting' });
    assert.equal(sys.calls.n, 0);
  });

  test('a proxy URL in the setting wins too', async () => {
    const r = router({ env: ENV, platform: 'darwin', readSystemProxy: counted().readSystemProxy });
    assert.deepEqual(await r.resolve(HTTPS_TARGET, 'http://127.0.0.1:7002'), {
      kind: 'proxy',
      source: 'setting',
      proxy: { host: '127.0.0.1', port: 7002 },
    });
  });

  test('an invalid setting is logged once and treated as automatic', async () => {
    const { lines, logger } = logs();
    const r = router({ env: ENV });
    const bad = `socks5://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:7891`;
    const first = await r.resolve(HTTPS_TARGET, bad, logger);
    const second = await r.resolve(HTTPS_TARGET, bad, logger);
    assert.equal(first.source, 'env');
    assert.deepEqual(second, first);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warn .*proxy setting/i);
    assert.ok(!lines[0].includes(PROXY_PASS));
  });

  test('environment proxy before system proxy', async () => {
    const sys = counted();
    const r = router({ env: ENV, platform: 'darwin', readSystemProxy: sys.readSystemProxy });
    const route = await r.resolve(HTTPS_TARGET);
    assert.equal(route.source, 'env');
    assert.equal(route.proxy.port, 7001);
    assert.equal(sys.calls.n, 0);
  });

  test('NO_PROXY with an environment proxy goes direct without asking the system', async () => {
    const sys = counted();
    const r = router({
      env: { ...ENV, NO_PROXY: 'anthropic.com' },
      platform: 'darwin',
      readSystemProxy: sys.readSystemProxy,
    });
    assert.deepEqual(await r.resolve(HTTPS_TARGET), { kind: 'direct', reason: 'no-proxy' });
    assert.equal(sys.calls.n, 0);
  });

  test('an unsupported environment proxy is logged once, then the system proxy is used', async () => {
    const { lines, logger } = logs();
    const r = router({
      env: { HTTPS_PROXY: 'socks5://127.0.0.1:7891' },
      platform: 'darwin',
      readSystemProxy: counted().readSystemProxy,
    });
    assert.equal((await r.resolve(HTTPS_TARGET, '', logger)).source, 'system');
    r.invalidate();
    assert.equal((await r.resolve(HTTPS_TARGET, '', logger)).source, 'system');
    assert.equal(lines.filter(l => /HTTPS_PROXY/.test(l)).length, 1);
  });

  test('the macOS system proxy when the environment has none', async () => {
    const r = router({ platform: 'darwin', readSystemProxy: counted().readSystemProxy });
    assert.deepEqual(await r.resolve(HTTPS_TARGET), {
      kind: 'proxy',
      source: 'system',
      proxy: { host: '127.0.0.1', port: 7897 },
    });
  });

  test('nothing configured: direct', async () => {
    const r = router({ platform: 'darwin', readSystemProxy: counted(SCUTIL_OFF).readSystemProxy });
    assert.deepEqual(await r.resolve(HTTPS_TARGET), { kind: 'direct', reason: 'none' });
  });

  test('scutil only runs on macOS', async () => {
    const sys = counted();
    const r = router({ platform: 'linux', readSystemProxy: sys.readSystemProxy });
    assert.deepEqual(await r.resolve(HTTPS_TARGET), { kind: 'direct', reason: 'none' });
    assert.equal(sys.calls.n, 0);
  });

  test('a failing scutil means direct, logged once without details that leak', async () => {
    const { lines, logger } = logs();
    const r = router({
      platform: 'darwin',
      readSystemProxy: async () => {
        throw Object.assign(new Error(`spawn failed ${ACCESS}`), { code: 'ENOENT' });
      },
    });
    assert.deepEqual(await r.resolve(HTTPS_TARGET, undefined, logger), { kind: 'direct', reason: 'none' });
    r.invalidate();
    await r.resolve(HTTPS_TARGET, undefined, logger);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(ACCESS));
  });

  test('the default reader runs /usr/sbin/scutil --proxy with a timeout', async () => {
    proc.execFile = () => ({ stdout: SCUTIL_HTTPS_ON });
    assert.equal(await P.readScutilProxy(), SCUTIL_HTTPS_ON);
    assert.deepEqual(proc.calls, [{ kind: 'execFile', file: '/usr/sbin/scutil', args: ['--proxy'] }]);
  });

  test('automatic results are cached per host for about a minute', async () => {
    let now = 1_000_000;
    const sys = counted();
    const r = router({ platform: 'darwin', readSystemProxy: sys.readSystemProxy, now: () => now });
    await r.resolve(HTTPS_TARGET);
    await r.resolve('https://api.anthropic.com/other');
    assert.equal(sys.calls.n, 1);
    await r.resolve('https://platform.claude.com/v1/oauth/token');
    assert.equal(sys.calls.n, 2);
    now += 59_000;
    await r.resolve(HTTPS_TARGET);
    assert.equal(sys.calls.n, 2);
    now += 2_000;
    await r.resolve(HTTPS_TARGET);
    assert.equal(sys.calls.n, 3);
    r.invalidate(HTTPS_TARGET);
    await r.resolve(HTTPS_TARGET);
    assert.equal(sys.calls.n, 4);
  });
});

// --- the tunnel ---------------------------------------------------------------------

describe('proxiedFetch through a CONNECT tunnel', () => {
  test('GET: status, headers and body come back as a standard Response', async () => {
    const t = await target((_, res) => {
      res.writeHead(201, 'Created', { 'X-Test': 'yes', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await fakeProxy({ upstreamPort: t.port });
    const { lines, logger } = logs();
    const r = router({ fetch: globalThis.fetch });
    const response = await r.fetch(
      `http://api.example.com:${t.port}/path?q=1`,
      { headers: { 'X-Hello': 'there' } },
      { proxy: proxy.url, logger, label: 'Claude requests' }
    );
    assert.ok(response instanceof Response);
    assert.equal(response.status, 201);
    assert.equal(response.statusText, 'Created');
    assert.equal(response.ok, true);
    assert.equal(response.headers.get('x-test'), 'yes');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0].method, 'CONNECT');
    assert.equal(proxy.seen[0].path, `api.example.com:${t.port}`);
    assert.equal(proxy.seen[0].headers['proxy-authorization'], undefined);
    assert.equal(t.seen.length, 1);
    assert.equal(t.seen[0].method, 'GET');
    assert.equal(t.seen[0].url, '/path?q=1');
    assert.equal(t.seen[0].headers['x-hello'], 'there');
    assert.equal(t.seen[0].headers.host, `api.example.com:${t.port}`);
    assert.equal(fetched.length, 0);
    assert.deepEqual(lines, [
      `info Claude requests to api.example.com: via proxy setting 127.0.0.1:${proxy.port}`,
    ]);
    // the same route again is not logged again
    await (await r.fetch(`http://api.example.com:${t.port}/`, {}, { proxy: proxy.url, logger, label: 'Claude requests' })).text();
    assert.equal(lines.length, 1);
  });

  test('POST bodies: string, Buffer, URLSearchParams, and Headers objects', async () => {
    const t = await target((_, res) => res.end('done'));
    const proxy = await fakeProxy({ upstreamPort: t.port });
    const r = router();
    const url = `http://api.example.com:${t.port}/v1/oauth/token`;
    const json = JSON.stringify({ grant_type: 'refresh_token', n: 'é' });
    await r.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }, { proxy: proxy.url });
    await r.fetch(url, { method: 'PUT', headers: new Headers({ 'x-kind': 'buffer' }), body: Buffer.from([1, 2, 3]) }, { proxy: proxy.url });
    await r.fetch(url, { method: 'POST', body: new URLSearchParams({ a: '1', b: 'two words' }) }, { proxy: proxy.url });
    await r.fetch(url, { method: 'POST', body: 'plain' }, { proxy: proxy.url });
    const [a, b, c, d] = t.seen;
    assert.equal(a.method, 'POST');
    assert.equal(a.body, json);
    assert.equal(a.headers['content-type'], 'application/json');
    assert.equal(Number(a.headers['content-length']), Buffer.byteLength(json));
    assert.equal(b.method, 'PUT');
    assert.equal(b.headers['x-kind'], 'buffer');
    assert.equal(b.body, Buffer.from([1, 2, 3]).toString('utf8'));
    assert.equal(c.body, 'a=1&b=two+words');
    assert.equal(c.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(d.headers['content-type'], 'text/plain;charset=UTF-8');
    assert.equal(fetched.length, 0);
  });

  test('proxy credentials go in Proxy-Authorization and nowhere in the logs', async () => {
    const t = await target((_, res) => res.end('ok'));
    const proxy = await fakeProxy({ upstreamPort: t.port });
    const { lines, logger } = logs();
    const setting = `http://${PROXY_USER}:${encodeURIComponent(PROXY_PASS)}@127.0.0.1:${proxy.port}`;
    const response = await router().fetch(`http://api.example.com:${t.port}/`, {}, { proxy: setting, logger });
    assert.equal(await response.text(), 'ok');
    assert.equal(
      proxy.seen[0].headers['proxy-authorization'],
      `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')}`
    );
    // the target never sees the proxy's credentials
    assert.equal(t.seen[0].headers['proxy-authorization'], undefined);
    assert.ok(lines.length > 0);
    assert.ok(lines.every(l => !l.includes(PROXY_PASS) && !l.includes(PROXY_USER + ':')));
  });

  test('a gzip-encoded body is decoded', async () => {
    const t = await target((_, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' });
      res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
    });
    const proxy = await fakeProxy({ upstreamPort: t.port });
    const response = await router().fetch(`http://api.example.com:${t.port}/`, {}, { proxy: proxy.url });
    assert.deepEqual(await response.json(), { zipped: true });
    assert.equal(t.seen[0].headers['accept-encoding'], 'identity');
  });

  test('a status without a body (204) still makes a Response', async () => {
    const t = await target((_, res) => {
      res.writeHead(204);
      res.end();
    });
    const proxy = await fakeProxy({ upstreamPort: t.port });
    const response = await router().fetch(`http://api.example.com:${t.port}/`, {}, { proxy: proxy.url });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });

  test('a body over the size limit fails, without a direct retry', async () => {
    const t = await target((_, res) => res.end('x'.repeat(4096)));
    const proxy = await fakeProxy({ upstreamPort: t.port });
    fetchReply = async () => new Response('direct');
    await assert.rejects(
      router().fetch(`http://api.example.com:${t.port}/`, {}, { proxy: proxy.url, maxBodyBytes: 1024 }),
      /larger than 1024 bytes/
    );
    assert.equal(fetched.length, 0);
  });

  test('an https target gets TLS with the target as server name (SNI)', async () => {
    const received = [];
    const capture = await listen(
      net.createServer(socket => {
        socket.on('error', () => undefined);
        socket.once('data', chunk => {
          received.push(chunk);
          socket.destroy();
        });
      })
    );
    const proxy = await fakeProxy({ upstreamPort: capture.port });
    fetchReply = async () => new Response('direct');
    await assert.rejects(
      router().fetch('https://api.anthropic.com/api/oauth/usage', {}, { proxy: proxy.url })
    );
    assert.equal(proxy.seen[0].path, 'api.anthropic.com:443');
    const hello = Buffer.concat(received);
    assert.equal(hello[0], 0x16, 'a TLS handshake record');
    assert.ok(hello.includes(Buffer.from('api.anthropic.com')), 'SNI names the target');
    // the tunnel was up: a TLS failure is never retried directly
    assert.equal(fetched.length, 0);
  });

  test('the source never turns certificate checks off', () => {
    for (const file of ['proxy.ts', 'proxyTunnel.ts', 'proxyConfig.ts']) {
      const text = fs.readFileSync(path.join(root, 'src', file), 'utf8');
      assert.doesNotMatch(text, /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity/, file);
    }
  });
});

describe('proxiedFetch: falling back to a direct request', () => {
  test('a proxy port nothing listens on: one direct request, logged once', async () => {
    const port = await closedPort();
    const { lines, logger } = logs();
    fetchReply = async () => new Response('direct answer', { status: 200 });
    const r = router();
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
    const response = await r.fetch('https://api.anthropic.com/api/oauth/usage', init, {
      proxy: `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${port}`,
      logger,
      label: 'Claude requests',
    });
    assert.equal(await response.text(), 'direct answer');
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(fetched[0].init.method, 'POST');
    assert.equal(fetched[0].init.body, '{}');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^warn Claude requests to api\\.anthropic\\.com: direct \\(proxy setting 127\\.0\\.0\\.1:${port} failed`));
    assert.ok(!lines[0].includes(PROXY_PASS));
    // the same failure again is not logged again
    await r.fetch('https://api.anthropic.com/api/oauth/usage', init, {
      proxy: `http://127.0.0.1:${port}`,
      logger,
      label: 'Claude requests',
    });
    assert.equal(fetched.length, 2);
    assert.equal(lines.length, 1);
  });

  test('CONNECT answered with 502: direct', async () => {
    const proxy = await fakeProxy({ mode: 'status', status: 502 });
    fetchReply = async () => new Response('direct');
    const response = await router().fetch('https://api.anthropic.com/x', {}, { proxy: proxy.url });
    assert.equal(await response.text(), 'direct');
    assert.equal(proxy.seen.length, 1);
    assert.equal(fetched.length, 1);
  });

  test('CONNECT answered with 407 (proxy login): direct', async () => {
    const proxy = await fakeProxy({ mode: 'status', status: 407 });
    fetchReply = async () => new Response('direct');
    await router().fetch('https://api.anthropic.com/x', {}, { proxy: proxy.url });
    assert.equal(fetched.length, 1);
  });

  test('no CONNECT answer within the connect timeout: direct', async () => {
    const proxy = await fakeProxy({ mode: 'silent' });
    fetchReply = async () => new Response('direct');
    const started = Date.now();
    await router().fetch('https://api.anthropic.com/x', {}, { proxy: proxy.url, connectTimeoutMs: 150 });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(fetched.length, 1);
  });

  test('a failed system proxy is looked up again next time', async () => {
    const port = await closedPort();
    let reads = 0;
    const r = router({
      platform: 'darwin',
      readSystemProxy: async () => (reads++, SCUTIL_HTTPS_ON.replaceAll('7897', String(port))),
    });
    fetchReply = async () => new Response('direct');
    await r.fetch('https://api.anthropic.com/x');
    await r.fetch('https://api.anthropic.com/x');
    assert.equal(reads, 2);
    assert.equal(fetched.length, 2);
  });

  test('an error after the request went out is not retried', async () => {
    let requests = 0;
    const dropper = await listen(
      net.createServer(socket => {
        socket.on('error', () => undefined);
        socket.on('data', () => {
          requests++;
          socket.destroy();
        });
      })
    );
    const proxy = await fakeProxy({ upstreamPort: dropper.port });
    fetchReply = async () => new Response('direct');
    const error = await router()
      .fetch(`http://api.example.com:${dropper.port}/v1/oauth/token`, { method: 'POST', body: 'grant' }, { proxy: proxy.url })
      .catch(e => e);
    assert.equal(requests, 1);
    assert.equal(fetched.length, 0);
    // callers can tell it apart from a failure before anything was sent
    assert.equal(typeof P.RequestSentError, 'function');
    assert.ok(error instanceof P.RequestSentError, String(error));
    assert.match(error.message, /^Request via proxy setting 127\.0\.0\.1:\d+ failed: /);
  });

  test('a failed CONNECT or a failed direct request is no RequestSentError', async () => {
    const proxy = await fakeProxy({ mode: 'status', status: 502 });
    fetchReply = async () => {
      throw new TypeError('fetch failed');
    };
    const error = await router().fetch('https://api.anthropic.com/x', {}, { proxy: proxy.url }).catch(e => e);
    assert.equal(fetched.length, 1);
    assert.ok(error instanceof TypeError);
    assert.ok(!(error instanceof P.RequestSentError));
  });

  test('a target that never answers times out, without a direct retry', async () => {
    const t = await target(() => undefined);
    const proxy = await fakeProxy({ upstreamPort: t.port });
    fetchReply = async () => new Response('direct');
    await assert.rejects(
      router().fetch(`http://api.example.com:${t.port}/`, {}, { proxy: proxy.url, timeoutMs: 200 }),
      /timed out/
    );
    assert.equal(t.seen.length, 1);
    assert.equal(fetched.length, 0);
  });

  test('a direct route calls fetch as it is', async () => {
    fetchReply = async () => new Response('plain');
    const response = await P.proxiedFetch('https://api.anthropic.com/x', { headers: { a: 'b' } }, { proxy: 'direct' });
    assert.equal(await response.text(), 'plain');
    assert.deepEqual(fetched[0], { url: 'https://api.anthropic.com/x', init: { headers: { a: 'b' } } });
  });
});

// --- the usage client: 403 forbidden -------------------------------------------------

const usageJson = { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 34, resets_at: null } };
const forbiddenBody = JSON.stringify({ type: 'error', error: { type: 'forbidden', message: 'Request not allowed' } });

describe('usage client: HTTP 403', () => {
  test('error.type "forbidden" is the region/network block', async () => {
    fetchReply = async () => new Response(forbiddenBody, { status: 403, headers: { 'Content-Type': 'application/json' } });
    const error = await Api.fetchUsage({ credentialsPath: credentialsFile(), proxy: 'direct' }).catch(e => e);
    assert.ok(error instanceof Api.UsageError);
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /403/);
    assert.match(error.message, /proxy/i);
    assert.ok(!error.message.includes(ACCESS));
  });

  test('any other 403 stays an HTTP error', async () => {
    for (const body of [
      JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'nope' } }),
      'not json at all',
      '',
      `{"error":{"type":"forbidden"`,
    ]) {
      fetchReply = async () => new Response(body, { status: 403 });
      const error = await Api.fetchUsage({ credentialsPath: credentialsFile(), proxy: 'direct' }).catch(e => e);
      assert.equal(error.code, 'http', body);
      assert.equal(error.message, 'Usage request failed with HTTP 403');
    }
  });

  test('a huge 403 body is read only in part', async () => {
    const big = JSON.stringify({ error: { type: 'forbidden' }, pad: 'x'.repeat(2 * 1024 * 1024) });
    fetchReply = async () => new Response(big, { status: 403 });
    const error = await Api.fetchUsage({ credentialsPath: credentialsFile(), proxy: 'direct' }).catch(e => e);
    assert.equal(error.code, 'http');
  });

  test('the usage request carries the token and returns the usage', async () => {
    fetchReply = async () => new Response(JSON.stringify(usageJson), { status: 200 });
    const usage = await Api.fetchUsage({ credentialsPath: credentialsFile(), proxy: 'direct' });
    assert.deepEqual(usage, usageJson);
    assert.equal(fetched[0].url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(fetched[0].init.headers.Authorization, `Bearer ${ACCESS}`);
  });

  test('the proxy setting reaches the usage request', async () => {
    const proxy = await fakeProxy({ mode: 'status', status: 502 });
    fetchReply = async () => new Response(JSON.stringify(usageJson), { status: 200 });
    await Api.fetchUsage({ credentialsPath: credentialsFile(), proxy: proxy.url });
    assert.equal(proxy.seen[0].path, 'api.anthropic.com:443');
    assert.equal(fetched.length, 1);
  });

  test('claudeErrorText: "Region blocked" / "Check proxy"', () => {
    assert.deepEqual(ClaudeUsage.claudeErrorText(new Api.UsageError('x', 'forbidden')), {
      title: 'Region blocked',
      message: 'Check proxy',
    });
    assert.deepEqual(ClaudeUsage.claudeErrorText(new Api.UsageError('Usage request failed with HTTP 403', 'http')), {
      title: 'Usage error',
      message: 'HTTP 403',
    });
  });

  test('the Claude usage source passes claudeProxy (keys and test-connection)', async () => {
    const proxy = await fakeProxy({ mode: 'status', status: 502 });
    fetchReply = async () => new Response(JSON.stringify(usageJson), { status: 200 });
    const config = { credentialsPath: credentialsFile(), claudeProxy: proxy.url };
    const metrics = await ClaudeUsage.claudeUsageSource.fetch(config);
    assert.deepEqual(metrics.map(m => m.id), ['session', 'weekly']);
    assert.equal(proxy.seen.length, 1);
    fetchReply = async () => new Response(forbiddenBody, { status: 403 });
    const described = await ClaudeUsage.claudeUsageSource.describe({ ...config, claudeProxy: 'direct' });
    assert.equal(described.success, false);
    assert.match(described.error, /proxy/i);
    assert.equal(proxy.seen.length, 1);
  });
});

// --- token refresh through the proxy ------------------------------------------------

describe('token refresh', () => {
  const tokenReply = () =>
    new Response(JSON.stringify({ access_token: ACCESS_NEW, refresh_token: REFRESH_NEW, expires_in: 3600 }), {
      status: 200,
    });

  test('the refresh POST goes through proxiedFetch with the proxy setting', async () => {
    const file = credentialsFile({ expiresAt: Date.now() - HOUR });
    const proxy = await fakeProxy({ mode: 'status', status: 502 });
    fetchReply = async () => tokenReply();
    const { logger } = logs();
    const token = await Creds.getAccessToken(file, { proxy: proxy.url, logger });
    assert.equal(token, ACCESS_NEW);
    assert.equal(proxy.seen[0].path, 'platform.claude.com:443');
    // one request: the CONNECT failed before anything was sent
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].url, 'https://platform.claude.com/v1/oauth/token');
    assert.equal(fetched[0].init.method, 'POST');
    assert.equal(JSON.parse(fetched[0].init.body).refresh_token, REFRESH);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.claudeAiOauth.accessToken, ACCESS_NEW);
    assert.equal(stored.claudeAiOauth.refreshToken, REFRESH_NEW);
    assert.deepEqual(stored.claudeAiOauth.scopes, ['user:inference']);
    assert.deepEqual(stored.mcpOAuth, { example: { note: 'kept as is' } });
  });

  test('a refresh that failed inside the tunnel is not sent to the other endpoint', async () => {
    // the tunnel to platform.claude.com is up, then the connection drops: the
    // request may have reached the server (which then rotated the token)
    let received = 0;
    const dropper = await listen(
      net.createServer(socket => {
        socket.on('error', () => undefined);
        socket.on('data', () => {
          received++;
          socket.destroy();
        });
      })
    );
    const proxy = await fakeProxy({ upstreamPort: dropper.port });
    const file = credentialsFile({ expiresAt: Date.now() - HOUR });
    const before = fs.readFileSync(file, 'utf8');
    fetchReply = async () => tokenReply();
    const { lines, logger } = logs();
    const token = await Creds.getAccessToken(file, { proxy: proxy.url, logger });
    assert.equal(token, ACCESS);
    assert.equal(received, 1);
    assert.deepEqual(
      proxy.seen.map(s => s.path),
      ['platform.claude.com:443']
    );
    assert.equal(fetched.length, 0);
    assert.ok(lines.some(l => /^error Token refresh request to https:\/\/platform\.claude\.com\/v1\/oauth\/token failed/.test(l)), lines.join('\n'));
    assert.ok(lines.every(l => !l.includes('console.anthropic.com')), lines.join('\n'));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  test('a rejection or a failed direct request still tries console.anthropic.com', async () => {
    for (const first of [
      async () => new Response('{"error":"invalid_request"}', { status: 400 }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      fetched.length = 0;
      const file = credentialsFile({ expiresAt: Date.now() - HOUR });
      const replies = [first, async () => tokenReply()];
      fetchReply = async () => replies.shift()();
      const token = await Creds.getAccessToken(file, { proxy: 'direct', logger: logs().logger });
      assert.equal(token, ACCESS_NEW);
      assert.deepEqual(
        fetched.map(f => f.url),
        ['https://platform.claude.com/v1/oauth/token', 'https://console.anthropic.com/v1/oauth/token']
      );
    }
  });

  test('a 401 forces one refresh and one retried usage request, both through the proxy', async () => {
    const file = credentialsFile();
    const proxy = await fakeProxy({ mode: 'status', status: 502 });
    const replies = [
      async () => new Response('{"type":"error","error":{"type":"authentication_error"}}', { status: 401 }),
      async () => tokenReply(),
      async () => new Response(JSON.stringify(usageJson), { status: 200 }),
    ];
    fetchReply = async () => replies.shift()();
    const usage = await Api.fetchUsage({ credentialsPath: file, proxy: proxy.url });
    assert.deepEqual(usage, usageJson);
    assert.deepEqual(
      proxy.seen.map(s => s.path),
      ['api.anthropic.com:443', 'platform.claude.com:443', 'api.anthropic.com:443']
    );
    assert.deepEqual(
      fetched.map(f => f.url),
      [
        'https://api.anthropic.com/api/oauth/usage',
        'https://platform.claude.com/v1/oauth/token',
        'https://api.anthropic.com/api/oauth/usage',
      ]
    );
    assert.equal(fetched[0].init.headers.Authorization, `Bearer ${ACCESS}`);
    assert.equal(JSON.parse(fetched[1].init.body).refresh_token, REFRESH);
    assert.equal(fetched[2].init.headers.Authorization, `Bearer ${ACCESS_NEW}`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.accessToken, ACCESS_NEW);
  });

  test(
    'a Keychain login is written back through security -i, never on the command line',
    { skip: process.platform !== 'darwin' && 'the Keychain is macOS only' },
    async () => {
      const item = JSON.stringify({
        claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() - HOUR },
        mcpOAuth: { example: { note: 'kept as is' } },
      });
      proc.execFile = (file, args) =>
        args[0] === 'find-generic-password' ? { stdout: `${item}\n` } : { error: new Error('unexpected') };
      const child = fakeSpawn();
      proc.spawn = child.spawn;
      fetchReply = async () => tokenReply();
      const { lines, logger } = logs();
      const token = await Creds.getAccessToken(undefined, { proxy: 'direct', logger });
      assert.equal(token, ACCESS_NEW);
      assert.equal(child.calls.length, 1);
      const [call] = child.calls;
      assert.equal(call.file, '/usr/bin/security');
      assert.deepEqual(call.args, ['-i']);
      const match = call.stdin.match(/^add-generic-password -U -a "you" -s "Claude Code-credentials" -X ([0-9a-f]+)\n$/);
      assert.ok(match, 'one add-generic-password line');
      const written = JSON.parse(Buffer.from(match[1], 'hex').toString('utf8'));
      assert.equal(written.claudeAiOauth.accessToken, ACCESS_NEW);
      assert.equal(written.claudeAiOauth.refreshToken, REFRESH_NEW);
      assert.deepEqual(written.mcpOAuth, { example: { note: 'kept as is' } });
      // no security call carried the secret in its arguments
      for (const c of proc.calls) {
        const argv = c.args.join(' ');
        assert.ok(!argv.includes(ACCESS_NEW) && !argv.includes(match[1]), argv);
        assert.ok(!c.args.includes('add-generic-password'), argv);
      }
      assert.ok(lines.every(l => !l.includes(ACCESS_NEW) && !l.includes(REFRESH_NEW)));
    }
  );
});

// --- security -i -----------------------------------------------------------------------

/** A fake child_process.spawn: records stdin, then exits with `code`. */
function fakeSpawn({ code = 0, stderr = '', error = null } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    const call = { file, args: [...args], options, stdin: '', killed: false };
    calls.push(call);
    child.stdout = null;
    child.stderr = new PassThrough();
    child.kill = () => {
      call.killed = true;
      return true;
    };
    const finish = () => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
      setTimeout(() => child.emit('close', code, null), 10);
    };
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        call.stdin += chunk.toString('utf8');
        cb();
      },
      final(cb) {
        cb();
        setImmediate(finish);
      },
    });
    return child;
  };
  return { spawn, calls };
}

/** A fake child_process.execFile (callback style). */
function fakeExecFile(result = {}) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    calls.push({ file, args: [...args] });
    setImmediate(() => (result.error ? cb(result.error, '', '') : cb(null, '', '')));
    return new EventEmitter();
  };
  return { execFile, calls };
}

const SECRET = JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH } });
const SECRET_HEX = Buffer.from(SECRET, 'utf8').toString('hex');
const ITEM = { service: SERVICE, account: 'you', secret: SECRET };

describe('Keychain: the security -i line', () => {
  test('quotes account and service, hex-encodes the secret, ends with a newline', () => {
    assert.deepEqual(K.interactiveAddLine(ITEM), {
      line: `add-generic-password -U -a "you" -s "Claude Code-credentials" -X ${SECRET_HEX}\n`,
    });
    assert.match(K.interactiveAddLine({ ...ITEM, account: '' }).line, / -a "" -s /);
    assert.match(K.interactiveAddLine({ ...ITEM, account: 'you two' }).line, / -a "you two" -s /);
    assert.match(K.interactiveAddLine({ ...ITEM, secret: 'é' }).line, / -X c3a9\n$/);
  });

  test('a quote, backslash or control character cannot be carried safely', () => {
    for (const account of ['a"b', 'a\\b', 'a\nb', 'a\rb', 'a\tb', 'a\0b']) {
      assert.deepEqual(K.interactiveAddLine({ ...ITEM, account }), { problem: 'unsafe characters' }, JSON.stringify(account));
    }
    assert.deepEqual(K.interactiveAddLine({ ...ITEM, service: 'x"y' }), { problem: 'unsafe characters' });
  });

  test('the line, its newline included, fits security\'s 4096-byte buffer or is refused', () => {
    // fgets into 4096 bytes: 4095 characters, newline included, per read. A
    // 4095-byte command leaves its newline for the next read, an empty
    // command whose exit status 0 would hide a failed write.
    assert.equal(K.INTERACTIVE_LINE_MAX, 4095);
    const command = account => Buffer.byteLength(`add-generic-password -U -a "${account}" -s "Claude Code-credentials" -X `);
    assert.equal(command('you'), 65);
    const secret = 'a'.repeat(2015);
    // 65 + 2 * 2015 = 4095 bytes before the newline: refused
    assert.deepEqual(K.interactiveAddLine({ ...ITEM, secret }), { problem: 'too long' });
    // 64 + 2 * 2015 = 4094 bytes before the newline: 4095 with it, accepted
    const longest = K.interactiveAddLine({ ...ITEM, account: 'yo', secret }).line;
    assert.equal(Buffer.byteLength(longest), 4095);
    assert.ok(longest.endsWith('\n'));
    // 65 + 2 * 2014 = 4093 bytes, 4094 with the newline
    assert.equal(Buffer.byteLength(K.interactiveAddLine({ ...ITEM, secret: secret.slice(1) }).line), 4094);
    // a multi-byte account counts in bytes: as many characters as 'yo', 4 bytes
    const wide = K.interactiveAddLine({ ...ITEM, account: 'é'.repeat(2), secret });
    assert.deepEqual(wide, { problem: 'too long' });
  });
});

describe('Keychain: writeGenericPassword', () => {
  test('writes through /usr/bin/security -i with the secret on stdin only', async () => {
    const child = fakeSpawn();
    const exec = fakeExecFile();
    const way = await K.writeGenericPassword(ITEM, { spawn: child.spawn, execFile: exec.execFile });
    assert.equal(way, 'stdin');
    assert.equal(exec.calls.length, 0);
    const [call] = child.calls;
    assert.equal(call.file, '/usr/bin/security');
    assert.deepEqual(call.args, ['-i']);
    assert.ok(!JSON.stringify(call.args).includes(SECRET_HEX));
    assert.ok(!JSON.stringify(call.args).includes(ACCESS));
    assert.equal(call.stdin, `add-generic-password -U -a "you" -s "Claude Code-credentials" -X ${SECRET_HEX}\n`);
  });

  test('a failed write reports exit code and status, never the input or stderr text', async () => {
    const child = fakeSpawn({
      code: 45,
      stderr:
        'security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.\nadd-generic-password: returned -25299\n',
    });
    const error = await K.writeGenericPassword(ITEM, { spawn: child.spawn, execFile: fakeExecFile().execFile }).catch(e => e);
    assert.ok(error instanceof Error);
    assert.match(error.message, /exit 45/);
    assert.match(error.message, /-25299/);
    assert.ok(!error.message.includes(SECRET_HEX));
    assert.ok(!error.message.includes('already exists'));
  });

  test('a non-zero Keychain status on stderr is a failure even with exit 0', async () => {
    const child = fakeSpawn({ code: 0, stderr: 'add-generic-password: returned -25308\n' });
    const error = await K.writeGenericPassword(ITEM, { spawn: child.spawn, execFile: fakeExecFile().execFile }).catch(e => e);
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, /exit 0, status -25308/);
    // a zero status, or other stderr text, with exit 0 is a success
    for (const stderr of ['add-generic-password: returned 0\n', 'note: something\n']) {
      const ok = fakeSpawn({ code: 0, stderr });
      assert.equal(await K.writeGenericPassword(ITEM, { spawn: ok.spawn, execFile: fakeExecFile().execFile }), 'stdin', stderr);
    }
  });

  test('stderr that echoes the hex never reaches the error', async () => {
    const child = fakeSpawn({ code: 1, stderr: `security: unknown command "${SECRET_HEX.slice(0, 200)}"\n` });
    const error = await K.writeGenericPassword(ITEM, { spawn: child.spawn, execFile: fakeExecFile().execFile }).catch(e => e);
    assert.match(error.message, /exit 1/);
    assert.ok(!error.message.includes(SECRET_HEX.slice(0, 40)));
  });

  test('security that cannot start is an error without the input', async () => {
    const child = fakeSpawn({ error: Object.assign(new Error('spawn /usr/bin/security ENOENT'), { code: 'ENOENT' }) });
    const error = await K.writeGenericPassword(ITEM, { spawn: child.spawn, execFile: fakeExecFile().execFile }).catch(e => e);
    assert.match(error.message, /ENOENT/);
    assert.ok(!error.message.includes(SECRET_HEX));
  });

  test('security that hangs is stopped', async () => {
    const calls = [];
    const spawn = (file, args) => {
      const child = new EventEmitter();
      const call = { file, args, killed: false };
      calls.push(call);
      child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
      child.stderr = new PassThrough();
      child.kill = () => {
        call.killed = true;
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    };
    const error = await K.writeGenericPassword(ITEM, { spawn, execFile: fakeExecFile().execFile, timeoutMs: 50 }).catch(e => e);
    assert.match(error.message, /timed out/);
    assert.equal(calls[0].killed, true);
  });

  test('too long for one line: the old argv write, with a warning', async () => {
    const child = fakeSpawn();
    const exec = fakeExecFile();
    const { lines, logger } = logs();
    const secret = JSON.stringify({ claudeAiOauth: { accessToken: ACCESS }, pad: 'x'.repeat(3000) });
    const way = await K.writeGenericPassword({ ...ITEM, secret }, { spawn: child.spawn, execFile: exec.execFile, logger });
    assert.equal(way, 'argv');
    assert.equal(child.calls.length, 0);
    assert.deepEqual(exec.calls, [
      {
        file: '/usr/bin/security',
        args: ['add-generic-password', '-U', '-s', SERVICE, '-a', 'you', '-w', secret],
      },
    ]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warn .*too long/);
    assert.ok(!lines[0].includes(ACCESS));
  });

  test('an account security -i cannot quote: the argv write', async () => {
    const child = fakeSpawn();
    const exec = fakeExecFile();
    const way = await K.writeGenericPassword({ ...ITEM, account: 'a"b' }, { spawn: child.spawn, execFile: exec.execFile });
    assert.equal(way, 'argv');
    assert.equal(child.calls.length, 0);
    assert.equal(exec.calls.length, 1);
  });

  test('a failed argv write never repeats its command line', async () => {
    const cmd = `/usr/bin/security add-generic-password -w ${SECRET}`;
    const exec = fakeExecFile({ error: Object.assign(new Error(`Command failed: ${cmd}`), { cmd, code: 51, stderr: 'boom' }) });
    const secret = `${SECRET}${'x'.repeat(3000)}`;
    const error = await K.writeGenericPassword({ ...ITEM, secret }, { spawn: fakeSpawn().spawn, execFile: exec.execFile }).catch(e => e);
    assert.ok(error instanceof Error);
    assert.equal(error.cmd, undefined);
    assert.ok(!error.message.includes(ACCESS));
    assert.match(error.message, /exit 51/);
  });
});
