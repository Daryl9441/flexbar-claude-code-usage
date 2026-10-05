/**
 * Gemini usage key: finds the installed Gemini CLI and reads its public
 * OAuth client (the installed-app client id and secret the CLI refreshes
 * logins with) from the CLI's own files at runtime, so this repository
 * never contains them. Read-only; nothing here is logged.
 */
import { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PluginConfig } from '../types';

import { geminiPathSetting } from './paths';

export const GEMINI_PACKAGE = '@google/gemini-cli';

export type GeminiCli = {
  /** The program that was found (or the folder given in the setting) */
  bin: string;
  /** The @google/gemini-cli package folder, when it could be located */
  root: string | null;
  /** The package version, e.g. "0.36.0" */
  version: string | null;
};

export type OAuthClient = { id: string; secret: string };

export type CliSearch = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Folders searched for the program instead of PATH + install folders */
  dirs?: string[];
};

// package.json files and client sources are small; bundle chunks are not
const MAX_PACKAGE_JSON = 1024 * 1024;
const MAX_SOURCE_FILE = 64 * 1024 * 1024;

async function statOf(file: string): Promise<Stats | null> {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/** The package version when `dir` is the Gemini CLI package, else null. */
async function packageVersion(dir: string): Promise<string | null> {
  const file = path.join(dir, 'package.json');
  const stat = await statOf(file);
  if (!stat?.isFile() || stat.size > MAX_PACKAGE_JSON) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.name !== GEMINI_PACKAGE) return null;
    return typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    return null;
  }
}

function binNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['gemini.cmd', 'gemini.exe', 'gemini.ps1', 'gemini']
    : ['gemini'];
}

/** Install folders of the usual package managers (GUI apps get a short PATH). */
async function installDirs(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform
): Promise<string[]> {
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'npm'));
    return dirs;
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm')
  );
  // nvm: newest Node first
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = (await fs.readdir(nvm)).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true })
    );
    for (const version of versions) dirs.push(path.join(nvm, version, 'bin'));
  } catch {
    // no nvm
  }
  return dirs;
}

/**
 * The package folder of a program or folder: walks up from the resolved
 * program (Homebrew and npm symlink into the package), then tries the
 * layouts of shims that are not symlinks (Windows npm, Volta).
 */
async function packageRootOf(
  target: string,
  home: string
): Promise<{ root: string; version: string } | null> {
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    return null;
  }
  const stat = await statOf(real);
  let dir = stat?.isDirectory() ? real : path.dirname(real);
  for (let depth = 0; depth < 8; depth++) {
    const version = await packageVersion(dir);
    if (version !== null) return { root: dir, version };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const binDir = stat?.isDirectory() ? real : path.dirname(target);
  const shimRoots = [
    path.join(binDir, 'node_modules', '@google', 'gemini-cli'),
    path.join(binDir, '..', 'lib', 'node_modules', '@google', 'gemini-cli'),
    path.join(
      home,
      '.volta',
      'tools',
      'image',
      'packages',
      '@google',
      'gemini-cli',
      'lib',
      'node_modules',
      '@google',
      'gemini-cli'
    ),
  ];
  for (const root of shimRoots) {
    const version = await packageVersion(root);
    if (version !== null) return { root: path.resolve(root), version };
  }
  return null;
}

/**
 * The Gemini CLI on this computer: the `geminiPath` setting when set (a
 * program or its package folder; nothing else is searched then), else the
 * first `gemini` on PATH or in the usual install folders. Null when none.
 */
export async function findGeminiCli(
  config: PluginConfig | null | undefined,
  search: CliSearch = {}
): Promise<GeminiCli | null> {
  const env = search.env ?? process.env;
  const home = search.home ?? os.homedir();
  const platform = search.platform ?? process.platform;

  const setting = geminiPathSetting(config, home);
  if (setting) {
    const stat = await statOf(setting);
    if (!stat) return null;
    const pkg = await packageRootOf(setting, home);
    if (stat.isDirectory() && !pkg) return null;
    return {
      bin: setting,
      root: pkg?.root ?? null,
      version: pkg?.version || null,
    };
  }

  const dirs = search.dirs ?? (await installDirs(env, home, platform));
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of binNames(platform)) {
      const bin = path.join(dir, name);
      const stat = await statOf(bin);
      if (!stat?.isFile()) continue;
      const pkg = await packageRootOf(bin, home);
      return { bin, root: pkg?.root ?? null, version: pkg?.version || null };
    }
  }
  return null;
}

// The constants as the CLI's sources declare them (`OAUTH_CLIENT_ID = "…"`)
const CLIENT_NAME = 'OAUTH_CLIENT_';
const CLIENT_ID_RE = new RegExp(
  `${CLIENT_NAME}ID\\s*=\\s*["'\`]([0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com)["'\`]`
);
const CLIENT_SECRET_RE = new RegExp(
  `${CLIENT_NAME}SECRET\\s*=\\s*["'\`]([A-Za-z0-9_-]{10,100})["'\`]`
);
const SECRET_MARKER = Buffer.from(`${CLIENT_NAME}SECRET`);

/** Files that may declare the client: the bundle (largest first), npm layouts. */
async function clientSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const bundle = path.join(root, 'bundle');
  try {
    const names = (await fs.readdir(bundle)).filter(n => n.endsWith('.js'));
    const sized = await Promise.all(
      names.map(async name => {
        const file = path.join(bundle, name);
        return { file, size: (await statOf(file))?.size ?? 0 };
      })
    );
    sized.sort((a, b) => b.size - a.size);
    files.push(...sized.map(s => s.file));
  } catch {
    // not a bundled install
  }
  const core = path.join(
    '@google',
    'gemini-cli-core',
    'dist',
    'src',
    'code_assist',
    'oauth2.js'
  );
  files.push(
    path.join(root, 'node_modules', core),
    path.join(root, '..', '..', core)
  );
  return files;
}

/** The client declared in one file's text, or null. */
export function clientFromSource(text: string): OAuthClient | null {
  const id = CLIENT_ID_RE.exec(text)?.[1];
  const secret = CLIENT_SECRET_RE.exec(text)?.[1];
  return id && secret ? { id, secret } : null;
}

async function scanForClient(root: string): Promise<OAuthClient | null> {
  for (const file of await clientSources(root)) {
    const stat = await statOf(file);
    if (!stat?.isFile() || stat.size > MAX_SOURCE_FILE) continue;
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch {
      continue;
    }
    const at = buffer.indexOf(SECRET_MARKER);
    if (at < 0) continue;
    // the two constants are declared side by side; fall back to the file
    const near = buffer
      .subarray(Math.max(0, at - 4096), at + 4096)
      .toString('latin1');
    const client =
      clientFromSource(near) ?? clientFromSource(buffer.toString('latin1'));
    if (client) return client;
  }
  return null;
}

const clientCache = new Map<
  string,
  { stamp: string; client: OAuthClient | null }
>();

/**
 * The CLI's OAuth client, read from its package once per installed version
 * (cached in memory, a miss included, until package.json changes).
 */
export async function readOAuthClient(
  root: string
): Promise<OAuthClient | null> {
  const stat = await statOf(path.join(root, 'package.json'));
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'none';
  const cached = clientCache.get(root);
  if (cached && cached.stamp === stamp) return cached.client;
  const client = await scanForClient(root);
  clientCache.set(root, { stamp, client });
  return client;
}

/** Forgets cached clients (tests). */
export function clearClientCache() {
  clientCache.clear();
}
