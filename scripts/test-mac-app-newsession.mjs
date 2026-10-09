// Completion and failure tests for the macOS App new-session action.
// Every execFile is a stub; no app, Accessibility query, process or link
// is opened. All paths, device ids and error content are synthetic.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

childProcess.execFile = () => {
  throw new Error('real child_process.execFile is disabled in tests');
};
let networkRequests = 0;
globalThis.fetch = async () => {
  networkRequests++;
  throw new Error('network is disabled in tests');
};

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const build = process.env.MAC_APP_NEW_SESSION_TEST_BUILD ??
  path.join(here, '..', '.test-build-mac-app-newsession');
const req = file => require(path.join(build, file));
const M = req('macAppNewSession.js');
const { NewSessionKeys } = req('newSessionKey.js');
const { DEFAULT_SETTLE_MS } = req('openUrl.js');
const { ProviderError } = req('providers/kit.js');
const SERIAL = 'FAKE-DEVICE-1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runner(execFile, platform = 'darwin') {
  return M.createMacAppNewSessionOpener({ execFile, platform });
}

function keyHarness(opener, options = {}) {
  const views = [];
  const warnings = [];
  const fallbacks = [];
  const requests = [];
  const sent = [];
  const writes = [];
  const commands = [];
  let configLoads = 0;
  let chain = Promise.resolve();
  const cid = options.cid ?? 'dev.sese.flexbar_claude_code_usage.antigravity_newsession';
  const keys = new NewSessionKeys({
    enqueue: task => (chain = chain.then(task)),
    send: async (serial, key, image) => sent.push({ serial, key, image }),
    isOffline: () => false,
    keyWidth: key => key.width,
    bgColor: () => undefined,
    loadConfig: async () => { configLoads++; return options.config ?? {}; },
    // Sentinels for host write operations: the message path has no reason
    // to save plugin config or mutate the user's hardware key layout.
    setConfig: async value => writes.push(['config', value]),
    writeLayout: async value => writes.push(['layout', value]),
    updateKey: async value => writes.push(['key', value]),
    provider: {
      cid,
      brand: {
        name: 'Antigravity',
        productName: 'Antigravity',
        accent: '#4f85e8',
        mark: { draw: () => undefined },
      },
      launcher: {
        appName: 'Antigravity',
        target: request => {
          requests.push(request);
          if (typeof options.target === 'function') return options.target(request);
          return options.target ?? {
            kind: 'mac-app-new-session', bundleId: M.ANTIGRAVITY_APP_BUNDLE,
          };
        },
      },
    },
    launch: async () => fallbacks.push('url'),
    run: async command => { commands.push(command); fallbacks.push('command'); },
    terminal: async () => fallbacks.push('terminal'),
    macAppNewSession: opener,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    render: (_width, view) => {
      views.push({ ...view });
      return `data:image/png;base64,${views.length}`;
    },
    home: '/Users/you',
    platform: 'darwin',
    timings: { openingMs: 60_000, errorMs: 60_000, debounceMs: 0 },
  });
  const key = lang => ({ uid: 1, cid, width: 120, data: { lang } });
  return {
    keys, key, cid, views, warnings, fallbacks, requests, sent, writes, commands,
    get configLoads() { return configLoads; },
    settle: async () => {
      let before;
      do { before = chain; await before; } while (before !== chain);
    },
  };
}

function observePress(keys) {
  const presses = [];
  const actualPress = keys.press.bind(keys);
  keys.press = async (serial, key) => {
    presses.push({ serial, key });
    return actualPress(serial, key);
  };
  return presses;
}

// Executes the exact exported JXA string against a synthetic native API
// facade. Neither osascript nor any real ObjC/AX API is invoked. Clock
// advances on mock AX calls and sleeps, so startup deadlines take ms here.
function nativeScript(options = {}) {
  let clock = 0;
  const bundle = options.bundle ?? M.ANTIGRAVITY_APP_BUNDLE;
  const kimi = bundle === M.KIMI_CODE_APP_BUNDLE;
  let route = options.beforeRoute ?? (kimi ? '/settings' : '/history');
  let focused = false;
  const draft = options.draft ?? '';
  let actionDone = false;
  let fileOpened = false;
  let rendererEnabled = !options.rendererNeedsManual;
  const actions = [];
  const launches = [];
  const bindings = [];
  const reads = [];
  const writes = [];
  let indexLookups = 0;
  const nil = { isNil: () => true };
  const nativeBoolean = value => options.wrappedBooleans ? { nativeValue: value } : value;
  const node = (nodeId, attrs) => ({ nodeId, attrs });
  const entry = {
    nodeId: 'FAKE-sidebar-new',
    attrs: { AXRole: 'AXLink', AXDescription: 'New Conversation' },
  };
  if (!options.missingEnabled) entry.attrs.AXEnabled = options.enabled ?? true;
  const composer = {
    nodeId: 'FAKE-message-input',
    attrs: {
      AXRole: options.composerRole ?? 'AXTextArea', AXDescription: options.composerLabel ??
        (options.chinese ? '消息输入框' : 'Message input'),
      AXFocused: () => nativeBoolean(focused), AXValue: () => options.nilValue ? nil :
        options.opaqueValue ? { nodeId: 'FAKE-unconvertible-value' } : draft,
    },
  };
  if (options.composerLabelAttribute && options.composerLabelAttribute !== 'AXDescription') {
    composer.attrs[options.composerLabelAttribute] = composer.attrs.AXDescription;
    composer.attrs.AXDescription = 'FAKE generic input description';
  }
  let composerTree = composer;
  for (let depth = 2; depth < (options.composerDepth ?? 2); depth++) {
    composerTree = node(`FAKE-composer-container-${depth}`, { AXRole: 'AXGroup', AXChildren: [composerTree] });
  }
  const pageURL = currentRoute => {
    const raw = kimi ? `app://renderer${currentRoute}` :
      `${options.noScheme ? '' : 'http://'}127.0.0.1:12345${currentRoute}`;
    return options.urlAsString ? raw : { absoluteString: raw };
  };
  const webarea = {
    nodeId: 'FAKE-webarea',
    attrs: {
      AXRole: 'AXWebArea',
      AXURL: () => pageURL(route),
      AXChildren: () => {
        const hasComposer = !options.splitWebareas && (actionDone ?
          !options.noComposerAfterAction : !options.noComposerBeforeAction);
        return [...(!kimi && !options.noSidebar ? [entry] : []), ...(hasComposer ? [composerTree] : [])];
      },
    },
  };
  const secondArea = node('FAKE-other-webarea', {
    AXRole: 'AXWebArea', AXURL: () => pageURL('/sessions/FAKE-other-session'), AXChildren: [composerTree],
  });
  const window = node('FAKE-focused-window', {
    AXRole: 'AXWindow', AXChildren: () => rendererEnabled ?
      [webarea, ...(options.splitWebareas ? [secondArea] : [])] : [],
  });
  const otherWindow = node('FAKE-unfocused-window', { AXRole: 'AXWindow', AXChildren: [secondArea] });
  const newMenu = node('FAKE-menu-new-session', {
    AXRole: 'AXMenuItem', AXTitle: options.chinese ? '新建会话' : 'New Session',
    AXEnabled: options.menuEnabled ?? true,
  });
  const menu = node('FAKE-file-menu', {
    AXRole: 'AXMenu', AXChildren: [
      node('FAKE-new-terminal', { AXRole: 'AXMenuItem', AXTitle: 'New Terminal', AXEnabled: true }),
      ...(options.noNewMenu ? [] : [newMenu]),
      node('FAKE-new-browser', { AXRole: 'AXMenuItem', AXTitle: 'New Browser', AXEnabled: true }),
    ],
  });
  const fileMenu = node('FAKE-file-menu-bar-item', {
    AXRole: 'AXMenuBarItem',
    [options.descriptionLabels ? 'AXDescription' : 'AXTitle']: options.chinese ? '文件' : 'File',
    AXChildren: () => !options.menuNeedsOpen || fileOpened ? [menu] : [],
  });
  if (options.descriptionLabels) {
    newMenu.attrs.AXDescription = newMenu.attrs.AXTitle;
    delete newMenu.attrs.AXTitle;
  }
  const bar = node('FAKE-menu-bar', { AXRole: 'AXMenuBar', AXChildren: [fileMenu] });
  const root = node('FAKE-app-root', {
    AXRole: 'AXApplication', AXChildren: [otherWindow, window],
    AXFocusedWindow: options.noWindow ? nil : window,
    AXMainWindow: options.noWindow ? nil : window,
    AXMenuBar: bar,
  });
  const app = {
    processIdentifier: '600001',
    activateWithOptions: () => true,
  };
  const dollar = value => value;
  Object.assign(dollar, {
    AXIsProcessTrusted: () => options.trusted !== false,
    NSWorkspace: {
      sharedWorkspace: {
        URLForApplicationWithBundleIdentifier: () => options.nilUrl ? nil : { isNil: () => false },
        launchApplicationAtURLOptionsConfigurationError: (...args) => {
          launches.push(args);
          return app;
        },
      },
    },
    NSRunningApplication: {
      runningApplicationsWithBundleIdentifier: () => ({
        count: options.coldStart ? '0' : '1',
        objectAtIndex: index => {
          indexLookups++;
          assert.equal(index, 0);
          assert.equal(options.coldStart, undefined, 'empty NSArray must not be indexed');
          return app;
        },
      }),
    },
    AXUIElementCreateApplication: pid => {
      assert.equal(pid, 600001);
      return root;
    },
    AXUIElementCreateSystemWide: () => ({ nodeId: 'FAKE-system-wide' }),
    AXUIElementSetMessagingTimeout: () => '0',
    NSNumber: { numberWithBool: nativeBoolean },
    AXUIElementSetAttributeValue: (element, attribute, value) => {
      writes.push([element.nodeId, attribute, value]);
      assert.ok(['AXManualAccessibility', 'AXFocused'].includes(attribute), 'never write a draft or send');
      if (attribute === 'AXManualAccessibility') {
        assert.equal(element, root);
        rendererEnabled = true;
        return '0';
      }
      assert.equal(element, composer);
      if (options.focusRefused) return '-25206';
      if (!options.focusSilentlyIgnored) focused = true;
      return '0';
    },
    AXUIElementCopyAttributeValue: (element, attribute, output) => {
      clock += 10;
      reads.push([element.nodeId, attribute]);
      if (!Object.hasOwn(element.attrs, attribute)) return '-25212';
      const value = element.attrs[attribute];
      output[0] = typeof value === 'function' ? value() : value;
      return '0';
    },
    CFArrayGetCount: array => String(array.length),
    CFArrayGetValueAtIndex: (array, index) => array[index],
    AXUIElementPerformAction: (element, action) => {
      assert.equal(action, 'AXPress');
      if (element === fileMenu) {
        actions.push(element.nodeId);
        assert.equal(fileOpened, false, 'open File at most once');
        fileOpened = true;
        return '0';
      }
      assert.equal(element, kimi ? newMenu : entry, 'only exact New Session / New Conversation is pressed');
      assert.equal(actionDone, false, 'new-session dispatch must happen once');
      actions.push(element.nodeId);
      actionDone = true;
      route = options.afterRoute ?? '/';
      focused = options.afterFocused ?? true;
      return options.actionError ? '-25206' : '0';
    },
    NSThread: { sleepForTimeInterval: () => { clock += 1000; } },
  });
  const context = {
    $: dollar,
    ObjC: {
      import: () => undefined,
      bindFunction: (name, signature) => bindings.push([name, JSON.parse(JSON.stringify(signature))]),
      unwrap: value => value?.isNil?.() ? undefined : value?.nativeValue ?? value,
    },
    Ref: () => [],
    Date: { now: () => clock },
    console: { log: () => assert.fail('native script must not emit diagnostic logs') },
  };
  return {
    execute: () => vm.runInNewContext(
      `${M.MAC_APP_NEW_SESSION_SCRIPT}\nrun([${JSON.stringify(bundle)}]);`,
      context, { timeout: 1000 },
    ),
    actions, launches, bindings, reads, writes,
    get indexLookups() { return indexLookups; },
    get draft() { return draft; },
    get elapsed() { return clock; },
  };
}

describe('exact JXA script with synthetic native APIs', () => {
  test('cold start handles string zero counts/errors and truthy native nil URL', () => {
    const cold = nativeScript({ coldStart: true });
    assert.equal(cold.execute(), 'new-session-verified');
    assert.equal(cold.launches.length, 1);
    assert.equal(cold.indexLookups, 0);
    assert.deepEqual(cold.actions, ['FAKE-sidebar-new']);
    assert.ok(cold.bindings.some(([name, signature]) => name === 'AXUIElementCopyAttributeValue' &&
      JSON.stringify(signature) === JSON.stringify(['int', ['id', 'id', 'id *']])));
    const unavailable = nativeScript({ coldStart: true, nilUrl: true });
    assert.throws(unavailable.execute, /app-unavailable/);
    assert.equal(unavailable.launches.length, 0);
    assert.deepEqual(unavailable.actions, []);
  });

  test('loading, disabled or unverifiably enabled sidebar never triggers AXPress', () => {
    for (const options of [{ noSidebar: true }, { enabled: false }, { missingEnabled: true }]) {
      const t = nativeScript(options);
      assert.throws(t.execute, /app-not-ready/);
      assert.deepEqual(t.actions, []);
      assert.ok(t.elapsed <= 37_000, 'mock startup scanning respects its total deadline');
    }
  });

  test('a preserved nonempty draft rejects without changing input or reading titles', () => {
    const draft = 'FAKE unsent local draft';
    const t = nativeScript({ draft });
    assert.throws(t.execute, /draft-preserved/);
    assert.equal(t.draft, draft);
    assert.deepEqual(t.actions, ['FAKE-sidebar-new']);
    assert.ok(t.reads.every(([, name]) => !['AXTitle', 'AXSelectedText'].includes(name)));
  });

  test('postcondition requires both the root route and focused empty composer after one AXPress', () => {
    for (const [options, reason] of [
      [{ afterRoute: '/history' }, /new-page-not-found/],
      [{ afterFocused: false, focusRefused: true }, /composer-not-focused/],
      [{ afterRoute: '/FAKE-wrong-page' }, /new-page-not-found/],
    ]) {
      const t = nativeScript(options);
      assert.throws(t.execute, reason);
      assert.deepEqual(t.actions, ['FAKE-sidebar-new'], 'unverified dispatch is never repeated');
    }
    const ready = nativeScript({ afterRoute: '/?section=FAKE-code', afterFocused: true });
    assert.equal(ready.execute(), 'new-session-verified');
    assert.deepEqual(ready.actions, ['FAKE-sidebar-new']);
  });

  test('Electron renderer flag and a scheme-free loopback URL verify without input writes', () => {
    const t = nativeScript({ rendererNeedsManual: true, noScheme: true, urlAsString: true,
      afterFocused: false, wrappedBooleans: true });
    assert.equal(t.execute(), 'new-session-verified');
    assert.deepEqual(t.actions, ['FAKE-sidebar-new']);
    assert.deepEqual(t.writes.map(([id, attribute]) => [id, attribute]), [
      ['FAKE-app-root', 'AXManualAccessibility'], ['FAKE-message-input', 'AXFocused'],
    ]);
    assert.ok(t.bindings.some(([name, signature]) => name === 'AXUIElementSetAttributeValue' &&
      JSON.stringify(signature) === JSON.stringify(['int', ['id', 'id', 'id']])));
  });



  test('Kimi menu works from a settings page without a composer, in both languages', () => {
    for (const chinese of [false, true]) {
      const t = nativeScript({ bundle: M.KIMI_CODE_APP_BUNDLE, chinese,
        beforeRoute: '/settings', noComposerBeforeAction: true, menuNeedsOpen: true,
        descriptionLabels: chinese });
      assert.equal(t.execute(), 'new-session-verified');
      assert.deepEqual(t.actions, ['FAKE-file-menu-bar-item', 'FAKE-menu-new-session']);
      assert.ok(t.writes.every(([, attribute]) => attribute !== 'AXValue'));
    }
  });

  test('Kimi never accepts an opened app, an existing session, a disabled menu or another action', () => {
    for (const [options, reason] of [
      [{ afterRoute: '/index.html?rc=FAKE' }, /new-page-not-found/],
      [{ afterRoute: '/sessions/FAKE-session' }, /new-page-not-found/],
      [{ menuEnabled: false }, /menu-unavailable/],
      [{ noNewMenu: true }, /menu-unavailable/],
    ]) {
      const t = nativeScript({ bundle: M.KIMI_CODE_APP_BUNDLE, ...options });
      assert.throws(t.execute, reason);
      assert.ok(t.actions.every(id => ['FAKE-file-menu-bar-item', 'FAKE-menu-new-session'].includes(id)));
      assert.equal(t.actions.filter(id => id === 'FAKE-menu-new-session').length,
        reason.source === 'new-page-not-found' ? 1 : 0);
    }
  });

  test('verification keeps the root route and composer in the same webarea', () => {
    const t = nativeScript({ splitWebareas: true });
    assert.throws(t.execute, /composer-not-found/);
    assert.deepEqual(t.actions, ['FAKE-sidebar-new']);
    assert.ok(t.reads.every(([id]) => id !== 'FAKE-unfocused-window'));
    assert.ok(t.reads.every(([, attribute]) => attribute !== 'AXValue'));
    assert.ok(t.writes.every(([, attribute]) => attribute !== 'AXFocused'));
  });

  test('the real textarea composer remains discoverable beyond twenty wrappers through depth forty', () => {
    for (const depth of [21, 24, 40]) {
      for (const bundle of [M.ANTIGRAVITY_APP_BUNDLE, M.KIMI_CODE_APP_BUNDLE]) {
        const t = nativeScript({ bundle, composerDepth: depth, chinese: bundle === M.KIMI_CODE_APP_BUNDLE });
        assert.equal(t.execute(), 'new-session-verified');
        assert.deepEqual(t.actions, [bundle === M.KIMI_CODE_APP_BUNDLE ? 'FAKE-menu-new-session' : 'FAKE-sidebar-new']);
        assert.ok(t.writes.every(([, attribute]) => attribute !== 'AXValue'));
        assert.ok(t.reads.filter(([id]) => id === 'FAKE-message-input')
          .every(([, attribute]) => !['AXTitle', 'AXHelp', 'AXRoleDescription'].includes(attribute)));
      }
    }
    const tooDeep = nativeScript({ composerDepth: 41 });
    assert.throws(tooDeep.execute, /composer-not-found/);
    assert.deepEqual(tooDeep.actions, ['FAKE-sidebar-new']);
  });

  test('unknown composer roles, label attributes and labels never verify or modify an input', () => {
    for (const options of [
      { composerRole: 'AXTextField' }, { composerRole: 'AXButton' },
      { composerLabelAttribute: 'AXTitle' }, { composerLabelAttribute: 'AXHelp' },
      { composerLabelAttribute: 'AXRoleDescription' }, { composerLabel: 'FAKE search input' },
    ]) {
      const t = nativeScript(options);
      assert.throws(t.execute, /composer-not-found/);
      assert.deepEqual(t.actions, ['FAKE-sidebar-new']);
      assert.ok(t.reads.every(([, attribute]) => attribute !== 'AXValue'));
      assert.ok(t.writes.every(([, attribute]) => attribute !== 'AXFocused'));
    }
  });

  test('Accessibility denial does not activate, launch, scan or write an app', () => {
    const t = nativeScript({ trusted: false });
    assert.throws(t.execute, /accessibility-required/);
    assert.deepEqual(t.actions, []);
    assert.deepEqual(t.launches, []);
    assert.deepEqual(t.reads, []);
    assert.deepEqual(t.writes, []);
    assert.equal(t.indexLookups, 0);
  });

  test('missing or unconvertible input value cannot be mistaken for a blank draft', () => {
    for (const options of [{ nilValue: true }, { opaqueValue: true }]) {
      const t = nativeScript(options);
      assert.throws(t.execute, /value-unavailable/);
      assert.deepEqual(t.actions, ['FAKE-sidebar-new']);
      assert.ok(t.writes.every(([, attribute]) => attribute !== 'AXFocused'));
    }
  });

  test('a visually blank contenteditable paragraph verifies without changing its whitespace', () => {
    for (const bundle of [M.KIMI_CODE_APP_BUNDLE, M.ANTIGRAVITY_APP_BUNDLE]) {
      const draft = '\n \t\n';
      const t = nativeScript({ bundle, draft });
      assert.equal(t.execute(), 'new-session-verified');
      assert.equal(t.draft, draft);
      assert.ok(t.writes.every(([, attribute]) => attribute !== 'AXValue'));
    }
  });



});

describe('macOS App new-session runner', () => {
  test('the fixed JXA source parses without executing it', () => {
    assert.doesNotThrow(() => new vm.Script(M.MAC_APP_NEW_SESSION_SCRIPT));
    assert.match(M.MAC_APP_NEW_SESSION_SCRIPT, /AXIsProcessTrusted\(\)/);
    assert.match(M.MAC_APP_NEW_SESSION_SCRIPT, /AXUIElementPerformAction/);
    assert.match(M.MAC_APP_NEW_SESSION_SCRIPT, /New Conversation/);
    assert.doesNotMatch(M.MAC_APP_NEW_SESSION_SCRIPT, /Application\(['"]System Events['"]\)/);
    assert.doesNotMatch(M.MAC_APP_NEW_SESSION_SCRIPT, /console\.log|FLEXBAR_DIAGNOSTIC|FLEXBAR_VERIFIED_INPUT|AXFocusedUIElement/);
  });

  test('the action remains pending beyond the ordinary opener settle window', async () => {
    const calls = [];
    let callback;
    const open = runner((file, args, options, done) => {
      calls.push({ file, args, options });
      callback = done;
    });
    let resolved = false;
    const pending = open(M.ANTIGRAVITY_APP_BUNDLE).then(() => { resolved = true; });
    await sleep(DEFAULT_SETTLE_MS + 25);
    assert.equal(resolved, false, 'launch acceptance cannot substitute for completed AX action');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, '/usr/bin/osascript');
    assert.deepEqual(calls[0].args, [
      '-l', 'JavaScript', '-e', M.MAC_APP_NEW_SESSION_SCRIPT, M.ANTIGRAVITY_APP_BUNDLE,
    ]);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.timeout, M.MAC_APP_TIMEOUT_MS);
    assert.equal(calls[0].options.timeout, 45_000);
    assert.ok(calls[0].options.maxBuffer > 0 && calls[0].options.maxBuffer <= 4096);
    callback(null, 'new-session-verified\n', '');
    await pending;
    assert.equal(resolved, true);
  });

  test('a callback timeout rejects even if stdout contains the success marker', async () => {
    const open = runner((_file, _args, _options, callback) => {
      callback(Object.assign(new Error('FAKE execution timeout'), {
        killed: true, signal: 'SIGTERM', code: 'ETIMEDOUT',
      }), 'new-session-verified', 'FAKE timeout detail');
    });
    await assert.rejects(open(M.ANTIGRAVITY_APP_BUNDLE), /timeout/);
  });

  test('a clean exit requires the exact verified marker', async () => {
    for (const stdout of ['', 'new-session-verified-extra', 'app-started', 'new-session-verified\nFAKE private output']) {
      const open = runner((_file, _args, _options, callback) => callback(null, stdout, ''));
      await assert.rejects(open(M.ANTIGRAVITY_APP_BUNDLE), /Could not verify/);
    }
  });

  test('unexpected child errors and synchronous errors do not expose raw details', async () => {
    const token = ['sk-', 'ant-', 'FAKE', 'x'.repeat(30)].join('');
    const raw = `/Users/you/FAKE-private-project ${token} ${M.MAC_APP_NEW_SESSION_SCRIPT}`;
    for (const execFile of [
      (_file, _args, _options, callback) => callback(new Error(raw), '', raw),
      () => { throw new Error(raw); },
    ]) {
      await assert.rejects(runner(execFile)(M.ANTIGRAVITY_APP_BUNDLE), error => {
        assert.ok(!error.message.includes('/Users/you/FAKE-private-project'));
        assert.ok(!error.message.includes(token));
        assert.ok(!error.message.includes(M.MAC_APP_NEW_SESSION_SCRIPT));
        return true;
      });
    }
  });

  test('only explicit reason markers in the fixed allowlist produce localized failures', async () => {
    for (const stderr of [
      'Error: FLEXBAR_NEW_SESSION:constructor (-2700)',
      'Error: FLEXBAR_NEW_SESSION:FAKE-private-reason (-2700)',
      'Error: FLEXBAR_NEW_SESSION:accessibility-required /Users/you/FAKE-private-detail',
      M.MAC_APP_NEW_SESSION_SCRIPT,
    ]) {
      const open = runner((_file, _args, _options, callback) => callback(
        new Error('FAKE failure'), '', stderr,
      ));
      await assert.rejects(open(M.KIMI_CODE_APP_BUNDLE), error => {
        assert.equal(error.message, 'Could not verify a new Kimi Code App conversation');
        assert.equal(error.extra.keyText, undefined);
        return true;
      });
    }
    const open = runner((_file, args, _options, callback) => {
      assert.equal(args.at(-1), M.KIMI_CODE_APP_BUNDLE);
      callback(new Error('FAKE failure'), '', 'Error: FLEXBAR_NEW_SESSION:new-page-not-found (-2700)');
    });
    await assert.rejects(open(M.KIMI_CODE_APP_BUNDLE), error => {
      assert.equal(error.message, 'Kimi Code App new session: new-page-not-found');
      assert.equal(error.extra.keyText.zh.title, '未验证新建页面');
      return true;
    });
  });



  test('unsupported platforms and bundle injection never call execFile', async () => {
    let calls = 0;
    const execFile = () => { calls++; assert.fail('no process for invalid input'); };
    for (const id of ['', 'FAKE.unsupported.bundle', `${M.ANTIGRAVITY_APP_BUNDLE}\nFAKE`, `${M.ANTIGRAVITY_APP_BUNDLE}"; throw new Error("FAKE")`]) {
      await assert.rejects(runner(execFile)(id), /Unsupported App/);
    }
    for (const platform of ['linux', 'win32']) {
      await assert.rejects(runner(execFile, platform)(M.ANTIGRAVITY_APP_BUNDLE), /Unsupported App/);
    }
    assert.equal(calls, 0);
  });

  test('an existing draft is reported without exposing its content', async () => {
    const open = runner((_file, _args, _options, callback) => callback(
      new Error('FAKE script failed'), '', '/Users/you/FAKE-draft\nError: FLEXBAR_NEW_SESSION:draft-preserved (-2700)',
    ));
    await assert.rejects(open(M.ANTIGRAVITY_APP_BUNDLE), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.extra.keyText.en.title, 'Draft preserved');
      assert.equal(error.extra.keyText.zh.title, '已保留未发送草稿');
      assert.ok(!error.message.includes('/Users/you/FAKE-draft'));
      return true;
    });
  });
});

describe('App target through the actual NewSessionKeys press handler', () => {
  test('Accessibility denial returns false, displays the cause and never falls back to open', async () => {
    const token = ['sk-', 'ant-', 'FAKE', 'z'.repeat(30)].join('');
    let scripts = 0;
    const t = keyHarness(runner((_file, _args, _options, callback) => {
      scripts++;
      callback(new Error(`FAKE command ${token}`), '', `/Users/you/FAKE-home ${token}\nError: FLEXBAR_NEW_SESSION:accessibility-required (-2700)`);
    }));
    try {
      await t.keys.alive(SERIAL, [t.key('zh')]);
      assert.equal(await t.keys.press(SERIAL, t.key('zh')), false);
      await t.settle();
      assert.equal(scripts, 1);
      assert.deepEqual(t.fallbacks, []);
      assert.equal(t.views.at(-1).state, 'error');
      assert.equal(t.views.at(-1).title, '需要辅助功能权限');
      const exposed = JSON.stringify({ views: t.views, warnings: t.warnings });
      assert.ok(!exposed.includes(token));
      assert.ok(!exposed.includes('/Users/you/FAKE-home'));
      assert.ok(!exposed.includes(M.MAC_APP_NEW_SESSION_SCRIPT));
    } finally {
      await t.keys.dead(SERIAL, []);
    }
  });

  test('the press waits for its action and becomes false when the action callback fails', async () => {
    let callback;
    const t = keyHarness(runner((_file, _args, _options, done) => { callback = done; }));
    try {
      await t.keys.alive(SERIAL, [t.key('en')]);
      let result;
      const pending = t.keys.press(SERIAL, t.key('en')).then(value => { result = value; });
      await t.settle();
      await sleep(15);
      assert.equal(result, undefined);
      assert.equal(t.views.at(-1).state, 'opening');
      callback(new Error('FAKE AX action failed'), '', 'Error: FLEXBAR_NEW_SESSION:new-session-action-failed (-2700)');
      await pending;
      await t.settle();
      assert.equal(result, false);
      assert.equal(t.views.at(-1).state, 'error');
      assert.deepEqual(t.fallbacks, []);
    } finally {
      await t.keys.dead(SERIAL, []);
    }
  });
});

describe('settings-page messages use the same press handler', () => {
  test('only the exact message and matching Kimi or Antigravity cid can reach press', async () => {
    const t = keyHarness(async () => assert.fail('invalid message must not open an App'));
    const presses = observePress(t.keys);
    const beforeNetwork = networkRequests;
    for (const payload of [
      undefined, null, {},
      { data: 'session-status', cid: t.cid },
      { data: 'new-session-test ', cid: t.cid },
      { data: { type: 'new-session-test' }, cid: t.cid },
      { data: 'new-session-test' },
      { data: 'new-session-test', cid: 'dev.sese.flexbar_claude_code_usage.kimi_newsession' },
      { data: 'new-session-test', cid: `${t.cid}-FAKE` },
    ]) {
      assert.equal(await t.keys.message(payload), undefined);
    }
    for (const cid of [
      'dev.sese.flexbar_claude_code_usage.newsession',
      'dev.sese.flexbar_claude_code_usage.gemini_newsession',
    ]) {
      const excluded = keyHarness(async () => assert.fail('excluded provider must not open'), { cid });
      const excludedPresses = observePress(excluded.keys);
      assert.equal(await excluded.keys.message({ data: 'new-session-test', cid }), undefined);
      assert.deepEqual(excludedPresses, []);
      assert.deepEqual(excluded.requests, []);
    }
    assert.deepEqual(presses, []);
    assert.deepEqual(t.requests, []);
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.writes, []);
    assert.equal(networkRequests, beforeNetwork);
  });

  test('each accepted provider message invokes actual press without saving config or touching device layout', async () => {
    for (const provider of ['antigravity', 'kimi']) {
      const cid = `dev.sese.flexbar_claude_code_usage.${provider}_newsession`;
      const appCalls = [];
      const bundleId = provider === 'kimi' ? M.KIMI_CODE_APP_BUNDLE : M.ANTIGRAVITY_APP_BUNDLE;
      const config = Object.freeze({ pollInterval: 90, kimiDir: '~/FAKE-code-home' });
      const t = keyHarness(async bundle => appCalls.push(bundle), {
        cid, config, target: { kind: 'mac-app-new-session', bundleId },
      });
      const deviceKey = Object.freeze({
        uid: 7, cid, width: 240,
        data: Object.freeze({ lang: 'en', folder: '~/FAKE-device-project', target: 'FAKE-old-target' }),
      });
      const layout = Object.freeze([deviceKey]);
      const settings = Object.freeze({ lang: 'zh', folder: '~/FAKE-ui-project', target: 'FAKE-legacy-target' });
      const payload = Object.freeze({ data: 'new-session-test', cid, settings });
      const originalLayout = structuredClone(layout);
      const originalConfig = structuredClone(config);
      const beforeNetwork = networkRequests;
      try {
        await t.keys.alive(SERIAL, layout);
        await t.settle();
        const sentBefore = t.sent.length;
        const presses = observePress(t.keys);
        assert.deepEqual(await t.keys.message(payload), { success: true });
        await t.settle();
        assert.equal(presses.length, 1);
        assert.equal(presses[0].serial, 'UI-PREVIEW');
        assert.deepEqual(presses[0].key, { uid: -1, cid, width: 120, data: settings });
        assert.equal(t.requests.length, 1, 'the actual press constructs and dispatches one provider request');
        assert.equal(t.requests[0].data, settings);
        assert.equal(t.requests[0].home, '/Users/you');
        assert.equal(t.requests[0].platform, 'darwin');
        assert.equal(t.sent.length, sentBefore, 'preview feedback does not repaint a physical key');
        assert.ok(t.sent.every(item => item.serial === SERIAL && item.key.uid === 7));
        assert.deepEqual(layout, originalLayout);
        assert.deepEqual(config, originalConfig);
        assert.deepEqual(t.writes, []);
        assert.equal(t.configLoads, 0, 'these App launchers do not need global config');
        assert.equal(networkRequests, beforeNetwork, 'no model request is sent');
        assert.deepEqual(appCalls, [bundleId]);
        assert.deepEqual(t.commands, []);
        assert.deepEqual(t.fallbacks, []);
      } finally {
        await t.keys.dead(SERIAL, []);
        await t.keys.dead('UI-PREVIEW', []);
      }
    }
  });

  test('a failed preview returns Localized error text and a later success clears it', async () => {
    let deny = true;
    const t = keyHarness(runner((_file, _args, _options, callback) => {
      if (deny) callback(new Error('FAKE permission denial'), '', 'Error: FLEXBAR_NEW_SESSION:accessibility-required (-2700)');
      else callback(null, 'new-session-verified', '');
    }));
    const presses = observePress(t.keys);
    const settings = Object.freeze({ lang: 'zh' });
    const payload = Object.freeze({ data: 'new-session-test', cid: t.cid, settings });
    const beforeNetwork = networkRequests;
    try {
      assert.deepEqual(await t.keys.message(payload), {
        success: false,
        error: { en: 'Accessibility required', zh: '需要辅助功能权限' },
      });
      assert.equal(presses.length, 1);
      assert.deepEqual(t.fallbacks, []);
      deny = false;
      assert.deepEqual(await t.keys.message(payload), { success: true });
      assert.equal(presses.length, 2);
      assert.deepEqual(settings, { lang: 'zh' });
      assert.deepEqual(t.sent, []);
      assert.deepEqual(t.writes, []);
      assert.equal(networkRequests, beforeNetwork);
    } finally {
      await t.keys.dead('UI-PREVIEW', []);
    }
  });
});
