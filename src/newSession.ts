/**
 * The New Session key's pure parts: the claude:// deep link it opens, its
 * per-key settings and the texts on its face (English and Chinese).
 */
import os from 'node:os';
import path from 'node:path';

import type { NewSessionState } from './providers/types';
import { Lang, langOf } from './sessionView';

/**
 * The Claude desktop app's "New Claude Code Session" deep link, the same one
 * its Dock menu and desktop actions use. `folder` (optional) picks the
 * project folder, `source` says where the request came from; the app maps
 * unknown sources to url_external, which is what an outside app is.
 */
export const NEW_SESSION_URL = 'claude://code/new';
const SOURCE = 'url_external';

/**
 * The folder setting as an absolute path, or null to let the app choose.
 * Expands `~` and `~/…`, drops quotes around a pasted path and resolves a
 * relative path against the home folder (the plugin's own working directory
 * means nothing to the user).
 */
export function resolveFolder(
  folder: unknown,
  home: string = os.homedir()
): string | null {
  if (typeof folder !== 'string') return null;
  let dir = folder.trim();
  if (/^(["']).+\1$/.test(dir)) dir = dir.slice(1, -1).trim();
  if (!dir) return null;
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    dir = path.join(home, dir.slice(2));
  }
  return path.resolve(home, dir);
}

/**
 * The deep link for a new session, e.g.
 * `claude://code/new?folder=%2FUsers%2Fyou%2Fmy+app&source=url_external`.
 * URLSearchParams encodes spaces, `&`, `#` and non-ASCII names, and the app
 * reads the parameters back with URLSearchParams.
 */
export function buildNewSessionUrl(folder?: unknown, home?: string): string {
  const url = new URL(NEW_SESSION_URL);
  const dir = resolveFolder(folder, home);
  if (dir) url.searchParams.set('folder', dir);
  url.searchParams.set('source', SOURCE);
  return url.href;
}

export type NewSessionSettings = {
  /** The raw folder setting (resolved only when the key is pressed) */
  folder: string;
  /** Folder name shown under the title, or null when no folder is set */
  folderName: string | null;
  lang: Lang;
};

/** Last path segment of a folder setting, for the key face. */
export function folderName(folder: unknown, home?: string): string | null {
  const dir = resolveFolder(folder, home);
  if (!dir) return null;
  return path.basename(dir) || dir;
}

export function newSessionSettings(
  data: unknown,
  home?: string
): NewSessionSettings {
  const values = (data ?? {}) as { folder?: unknown; lang?: unknown };
  const folder = typeof values.folder === 'string' ? values.folder : '';
  return {
    folder,
    folderName: folderName(folder, home),
    lang: langOf(values.lang),
  };
}

export type { NewSessionState };

export type NewSessionView = {
  state: NewSessionState;
  title: string;
  subtitle: string | null;
};

export type NewSessionStrings = Record<Lang, Record<NewSessionState, string>>;

/** The Claude key's texts; other providers pass their own table. */
export const CLAUDE_NEW_SESSION_STRINGS: NewSessionStrings = {
  en: {
    ready: 'New Session',
    opening: 'Opening…',
    error: 'Claude app not found',
  },
  zh: {
    ready: '新建会话',
    opening: '正在打开…',
    error: '未找到 Claude App',
  },
};

export function buildNewSessionView(
  state: NewSessionState,
  settings: NewSessionSettings,
  strings: NewSessionStrings = CLAUDE_NEW_SESSION_STRINGS
): NewSessionView {
  return {
    state,
    title: strings[settings.lang][state],
    subtitle: state === 'error' ? null : settings.folderName,
  };
}
