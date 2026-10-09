/**
 * Opens the exact desktop app's own New Conversation / New Session action.
 * JXA uses AppKit and Accessibility directly; no System Events Automation
 * grant, keyboard input, model message, or shell command is involved.
 * Missing Accessibility access fails without requesting a new permission.
 */
import { execFile } from 'node:child_process';

import { ProviderError } from './providers/kit';

export type MacAppNewSessionOpener = (bundleId: string) => Promise<void>;

export const ANTIGRAVITY_APP_BUNDLE = 'com.google.antigravity';
export const KIMI_CODE_APP_BUNDLE = 'com.kimi.code.desktop';
export const MAC_APP_TIMEOUT_MS = 45_000;

/**
 * Only fixed UI labels are inspected. Real conversation titles, projects,
 * URLs and drafts never leave this process. The draft value is checked for
 * emptiness only; an existing unsent draft is preserved and reported.
 */
export const MAC_APP_NEW_SESSION_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
// Explicit object signatures avoid JXA's unsafe const void* CF bridge.
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCreateSystemWide', ['id', []]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id *']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('CFArrayGetValueAtIndex', ['id', ['id', 'long']]);

function run(argv) {
  var bundle = argv[0];
  var kimi = bundle === 'com.kimi.code.desktop';
  function fail(code) { throw new Error('FLEXBAR_NEW_SESSION:' + code); }
  if (bundle !== 'com.google.antigravity' && !kimi) fail('unsupported-app');
  if (!$.AXIsProcessTrusted()) fail('accessibility-required');
  function missing(value) {
    return value === null || value === undefined ||
      (typeof value.isNil === 'function' && value.isNil());
  }
  var workspace = $.NSWorkspace.sharedWorkspace;
  var url = workspace.URLForApplicationWithBundleIdentifier(bundle);
  if (missing(url)) fail('app-unavailable');
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle);
  var app = Number(apps.count) > 0 ? apps.objectAtIndex(0) :
    workspace.launchApplicationAtURLOptionsConfigurationError(url, 0, $({}), null);
  if (missing(app)) fail('app-unavailable');
  app.activateWithOptions(3);
  var pid = Number(app.processIdentifier);
  var root = $.AXUIElementCreateApplication(pid);
  // Setting this on the system-wide object applies to all AX calls in this process.
  $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), 0.2);

  var deadline = Date.now() + 35000;
  // Electron's documented root flag enables its renderer AX tree, not TCC access:
  // https://www.electronjs.org/docs/latest/tutorial/accessibility
  $.AXUIElementSetAttributeValue(root, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  function attribute(element, name) {
    if (Date.now() >= deadline) return null;
    var output = Ref();
    if (Number($.AXUIElementCopyAttributeValue(element, $(name), output)) !== 0) return null;
    return output[0];
  }
  function text(value) {
    if (missing(value)) return '';
    try { return String(ObjC.unwrap(value)); } catch (_) { return ''; }
  }
  function children(element) {
    var values = attribute(element, 'AXChildren');
    if (missing(values)) return [];
    var result = [], length = Number($.CFArrayGetCount(values));
    for (var i = 0; i < length && i < 1800 && Date.now() < deadline; i++) {
      result.push($.CFArrayGetValueAtIndex(values, i));
    }
    return result;
  }
  function pageURL(value) {
    if (missing(value)) return '';
    var raw = '';
    try { raw = text(value.absoluteString); } catch (_) {}
    if (!raw) raw = text(value);
    return raw;
  }
  function scan(goal) {
    // Never combine a page in one window with a composer in another.
    var window = attribute(root, 'AXFocusedWindow');
    if (missing(window)) window = attribute(root, 'AXMainWindow');
    if (missing(window)) return { groups: [], window: false };
    var queue = [{ element: window, depth: 0, group: null }];
    var count = 0;
    var groups = [];
    while (queue.length && count++ < 1800 && Date.now() < deadline) {
      var item = queue.shift(), element = item.element;
      var role = text(attribute(element, 'AXRole'));
      var group = item.group;
      if (role === 'AXWebArea') {
        var url = pageURL(attribute(element, 'AXURL'));
        group = {
          entry: null, composer: null,
          renderer: kimi && /^app:\/\/renderer\//.test(url),
          newPage: kimi ? /^app:\/\/renderer\/(?:\?|$)/.test(url) :
            /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):\d+\/(?:\?|$)/.test(url)
        };
        groups.push(group);
      }
      var description = (role === 'AXLink' || role === 'AXTextArea') ?
        text(attribute(element, 'AXDescription')) : '';
      if (group) {
        if (!kimi && role === 'AXLink' && description === 'New Conversation' &&
            text(attribute(element, 'AXEnabled')) === 'true') group.entry = element;
        if (role === 'AXTextArea' && (description === 'Message input' ||
            (kimi && description === '消息输入框'))) group.composer = element;
        if ((goal === 'entry' && group.entry) ||
            (goal === 'renderer' && group.renderer) ||
            (goal === 'verify' && group.newPage && group.composer)) break;
      }
      if (item.depth >= 40) continue;
      var next = children(element);
      for (var i = 0; i < next.length && queue.length < 1800; i++) {
        queue.push({ element: next[i], depth: item.depth + 1, group: group });
      }
    }
    return { groups: groups, window: true };
  }
  function groupWith(state, name) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i][name]) return state.groups[i];
    }
    return null;
  }
  function menuItem(top, wantedRole, labels) {
    if (missing(top)) return null;
    var queue = [{ element: top, depth: 0 }], count = 0;
    while (queue.length && count++ < 180 && Date.now() < deadline) {
      var item = queue.shift(), element = item.element;
      var role = text(attribute(element, 'AXRole'));
      if (role === wantedRole) {
        var label = text(attribute(element, 'AXTitle')) || text(attribute(element, 'AXDescription'));
        if (labels.indexOf(label) >= 0 && (wantedRole === 'AXMenuBarItem' ||
            text(attribute(element, 'AXEnabled')) === 'true')) return element;
      }
      if (item.depth >= 8) continue;
      var next = children(element);
      for (var i = 0; i < next.length && queue.length < 180; i++)
        queue.push({ element: next[i], depth: item.depth + 1 });
    }
    return null;
  }
  var state, entry = null, fileOpened = false;
  do {
    state = scan(kimi ? 'renderer' : 'entry');
    if (!kimi) {
      var start = groupWith(state, 'entry');
      if (start) entry = start.entry;
    } else if (groupWith(state, 'renderer')) {
      var bar = attribute(root, 'AXMenuBar');
      var file = menuItem(bar, 'AXMenuBarItem', ['File', '文件']);
      entry = menuItem(file, 'AXMenuItem', ['New Session', '新建会话']);
      if (!entry && file && !fileOpened) {
        fileOpened = true;
        if (Number($.AXUIElementPerformAction(file, $('AXPress'))) !== 0) fail('menu-unavailable');
      }
    }
    if (entry) break;
    $.NSThread.sleepForTimeInterval(0.1);
  } while (Date.now() < deadline);
  if (!entry) fail(kimi ? 'menu-unavailable' : 'app-not-ready');
  // The new-session action is dispatched exactly once, never to Send.
  if (Number($.AXUIElementPerformAction(entry, $('AXPress'))) !== 0)
    fail('new-session-action-failed');
  deadline = Date.now() + 5000;
  var focusRequested = false;
  do {
    state = scan('verify');
    for (var i = 0; i < state.groups.length; i++) {
      var page = state.groups[i];
      if (!page.newPage || !page.composer) continue;
      var value = attribute(page.composer, 'AXValue');
      if (missing(value)) fail('value-unavailable');
      var draft;
      try { draft = ObjC.unwrap(value); } catch (_) { fail('value-unavailable'); }
      if (typeof draft !== 'string') fail('value-unavailable');
      // Contenteditable editors expose an empty paragraph as a newline.
      // Whitespace is preserved exactly; only a visually blank draft passes.
      if (draft.trim() !== '') fail('draft-preserved');
      if (text(attribute(page.composer, 'AXFocused')) === 'true') return 'new-session-verified';
      if (!focusRequested) {
        focusRequested = true;
        if (Number($.AXUIElementSetAttributeValue(page.composer, $('AXFocused'),
            $.NSNumber.numberWithBool(true))) !== 0) fail('composer-not-focused');
      }
    }
    $.NSThread.sleepForTimeInterval(0.1);
  } while (Date.now() < deadline);
  if (!state.window) fail('window-unavailable');
  var newPage = groupWith(state, 'newPage');
  if (!newPage) fail('new-page-not-found');
  if (!newPage.composer) fail('composer-not-found');
  fail('composer-not-focused');
}
`;

type ScriptRunner = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: unknown, stderr: unknown) => void
) => unknown;

export function createMacAppNewSessionOpener(
  options: {
    execFile?: ScriptRunner;
    platform?: NodeJS.Platform;
  } = {}
): MacAppNewSessionOpener {
  const run = options.execFile ?? execFile;
  return bundleId => {
    if (
      (options.platform ?? process.platform) !== 'darwin' ||
      ![ANTIGRAVITY_APP_BUNDLE, KIMI_CODE_APP_BUNDLE].includes(bundleId)
    ) {
      return Promise.reject(new Error('Unsupported App new-session target'));
    }
    const appName =
      bundleId === KIMI_CODE_APP_BUNDLE ? 'Kimi Code App' : 'Antigravity';
    const reasons: Record<string, [string, string]> = {
      'accessibility-required': ['Accessibility required', '需要辅助功能权限'],
      'app-unavailable': ['App not found', '未找到 App'],
      'app-not-ready': ['App not ready', '应用尚未就绪'],
      'menu-unavailable': [
        'New Session menu unavailable',
        '新建会话菜单不可用',
      ],
      'new-session-action-failed': [
        'New session action failed',
        '新建会话动作失败',
      ],
      'window-unavailable': ['App window unavailable', '应用窗口不可用'],
      'new-page-not-found': ['New page not verified', '未验证新建页面'],
      'composer-not-found': ['Message input missing', '未找到消息输入框'],
      'composer-not-focused': ['Input not focused', '输入框未聚焦'],
      'value-unavailable': ['Cannot verify empty input', '无法验证空输入'],
      'draft-preserved': ['Draft preserved', '已保留未发送草稿'],
      timeout: ['App action timed out', '新建动作超时'],
    };
    const failure = (reason: string) => {
      const title = Object.prototype.hasOwnProperty.call(reasons, reason)
        ? reasons[reason]
        : undefined;
      return new ProviderError(
        'not-configured',
        title
          ? `${appName} new session: ${reason}`
          : `Could not verify a new ${appName} conversation`,
        title
          ? {
              keyText: {
                en: { title: title[0], message: '' },
                zh: { title: title[1], message: '' },
              },
            }
          : {}
      );
    };
    return new Promise<void>((resolve, reject) => {
      const done = (error: Error | null, stdout: unknown, stderr: unknown) => {
        if (!error && String(stdout).trim() === 'new-session-verified') {
          resolve();
          return;
        }
        // The marker must end an error line, so an echoed script literal is
        // not mistaken for a reason. Only this fixed allowlist leaves here.
        const marker = String(stderr).match(
          /\bFLEXBAR_NEW_SESSION:([a-z-]+)(?=\s*(?:\(-?\d+\))?\s*$)/m
        );
        const killed = error as (Error & { killed?: boolean }) | null;
        const reason = killed?.killed ? 'timeout' : (marker?.[1] ?? 'unknown');
        reject(failure(reason));
      };
      try {
        run(
          '/usr/bin/osascript',
          ['-l', 'JavaScript', '-e', MAC_APP_NEW_SESSION_SCRIPT, bundleId],
          {
            windowsHide: true,
            timeout: MAC_APP_TIMEOUT_MS,
            maxBuffer: 1024,
          },
          done
        );
      } catch {
        reject(new Error('Could not start the App new-session action'));
      }
    });
  };
}

export const openMacAppNewSession = createMacAppNewSessionOpener();
