/**
 * In-memory copy of the global plugin settings.
 *
 * FlexDesigner stores them in config.json. `plugin.getConfig()` reads that
 * file, which is why a plugin restart sees a key the user just saved. The
 * running process must not keep the first read: `plugin.config.updated`
 * reads again and merges the event. A password field is sometimes missing
 * or blank on the event while the file already has the key, and the file
 * can also lag a new key that the event already carries. The settings and
 * the event payload are never logged.
 */
import { PluginConfig } from './providers/types';

/** Reads the settings FlexDesigner has stored. May reject. */
export type ConfigRead = () => Promise<unknown>;

export type PluginConfigCache = {
  /** The last settings kept in memory, or null before the first successful read. */
  current(): PluginConfig | null;
  /** The cached settings, reading once and then reusing that copy. */
  load(): Promise<PluginConfig>;
  /**
   * `plugin.config.updated`. Drops the cached copy, reads the store again,
   * and merges the event. A read that started before this save cannot
   * write the old settings back.
   */
  updated(payload: unknown): Promise<PluginConfig>;
};

/**
 * Fields the global settings page edits. An unwrapped event counts as
 * settings only when it carries one of these, so a status object is not
 * stored as the config.
 */
const CONFIG_FIELDS = new Set([
  'pollInterval',
  'credentialsPath',
  'claudeDir',
  'claudeProxy',
  'kimiDir',
  'kimiDesktopDir',
  'kimiRefreshLogin',
  'geminiDir',
  'geminiPath',
  'geminiCloudProject',
  'antigravityDir',
  'antigravityPath',
  'grokbotDir',
  'grokbotDataRoot',
  'cursorStateDb',
  'deepseekApiKey',
  'moonshotApiKey',
  'moonshotSite',
]);

/**
 * Password settings. An event that blanks one of these must not wipe a key
 * the store still has: the settings page can deliver the field empty while
 * config.json already holds the token. A non-empty event value still wins,
 * so replacing the key takes effect when the file has not caught up.
 */
const SECRET_FIELDS = new Set(['deepseekApiKey', 'moonshotApiKey']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asConfig(value: unknown): PluginConfig | null {
  return isPlainObject(value) ? value : null;
}

/** Settings carried by a `plugin.config.updated` payload, or null. */
export function configFromUpdate(payload: unknown): PluginConfig | null {
  if (!isPlainObject(payload)) return null;
  const nested = asConfig(payload.config);
  if (nested) return nested;
  for (const key of Object.keys(payload)) {
    if (CONFIG_FIELDS.has(key)) return payload;
  }
  return null;
}

function blankSecret(key: string, value: unknown): boolean {
  return (
    SECRET_FIELDS.has(key) && (typeof value !== 'string' || value.trim() === '')
  );
}

function mergeConfig(
  stored: PluginConfig,
  event: PluginConfig | null
): PluginConfig {
  const next: PluginConfig = { ...stored };
  if (!event) return next;
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;
    if (blankSecret(key, value)) {
      const kept = next[key];
      if (typeof kept === 'string' && kept.trim()) continue;
    }
    next[key] = value;
  }
  return next;
}

/**
 * A settings cache. `read` is `plugin.getConfig` in the plugin and a stub
 * in tests. `warn` receives a failed read and nothing else.
 */
export function createPluginConfigCache(
  read: ConfigRead,
  warn?: (error: unknown) => void
): PluginConfigCache {
  let current: PluginConfig | null = null;
  // Bumped on every save so an older getConfig cannot replace the new one.
  let generation = 0;

  async function readStore(): Promise<PluginConfig | null> {
    try {
      return asConfig(await read()) ?? {};
    } catch (error) {
      warn?.(error);
      return null;
    }
  }

  return {
    current: () => current,

    async load() {
      if (current) return current;
      const started = generation;
      const loaded = await readStore();
      if (loaded && generation === started && !current) current = loaded;
      return current ?? loaded ?? {};
    },

    async updated(payload: unknown) {
      const started = ++generation;
      const previous = current;
      const stored = await readStore();
      if (generation !== started) return current ?? previous ?? {};
      const next = mergeConfig(
        stored ?? previous ?? {},
        configFromUpdate(payload)
      );
      if (generation !== started) return current ?? next;
      current = next;
      return next;
    },
  };
}
