import { logger, plugin } from '@eniac/flexdesigner';

import { UsageError, fetchUsage } from './api';
import { renderMessageKey, renderUsageKey } from './render';
import { SESSION_CID, SessionKeys } from './sessionKey';
import { Config, Metric, UsageData } from './types';
import { formatTimeUntilReset, getMetricSnapshot } from './usage';

const USAGE_CID = 'dev.sese.flexbar_claude_code_usage.usage';
const DEFAULT_POLL_INTERVAL = 180;
const MIN_POLL_INTERVAL = 60;
// Minimum gap between any two usage requests, so key presses and page
// switches cannot burst against the rate-limited endpoint
const MIN_FETCH_GAP_MS = 30_000;
// Fallback lockout when a 429 comes without a Retry-After header
const DEFAULT_LOCKOUT_SECONDS = 300;

// Key widths FlexDesigner can report; images are always KEY_HEIGHT (60) tall
const MIN_KEY_WIDTH = 60;
const DEFAULT_KEY_WIDTH = 240;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Key = any;

/** Title and message shown on a key face. */
type KeyText = { title: string; message: string };

const aliveKeys = new Map<string, Key[]>();
// Devices reported disconnected: drawing to them only produces rejections
const offlineDevices = new Set<string>();
// All draws go through this chain so they reach FlexDesigner one at a time
let drawChain: Promise<void> = Promise.resolve();

let config: Config | null = null;
let lastUsage: UsageData | null = null;
let lastError: KeyText | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let lockedUntil: number | null = null;
let lockTicker: NodeJS.Timeout | null = null;
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;

async function getConfigCached(): Promise<Config> {
  if (config) return config;
  try {
    config = ((await plugin.getConfig()) as Config) ?? {};
  } catch (error) {
    logger?.warn('Could not load plugin config, using defaults:', error);
    return {};
  }
  return config;
}

/**
 * Short key-face text for a fetch error. Keys can be under 100px wide, so the
 * full error message only goes to the log and the settings UI.
 */
function errorKeyText(error: unknown): KeyText {
  if (error instanceof UsageError) {
    switch (error.code) {
      case 'no-credentials':
        return { title: 'Not logged in', message: 'Run claude to log in' };
      case 'unauthorized':
        return { title: 'Login expired', message: 'Run claude to log in' };
      case 'rate-limited':
        return { title: 'Rate limited', message: 'Retrying later' };
      case 'http':
        return {
          title: 'Usage error',
          message: error.message.match(/HTTP \d+/)?.[0] ?? error.message,
        };
      case 'network':
        return { title: 'Network error', message: 'Check your connection' };
    }
  }
  return { title: 'Claude Code', message: `${error}` };
}

/**
 * The pixel width of the key on the device. FlexDesigner sends it as
 * `key.width` (mirrored in `key.style.width`) with every plugin.alive and
 * plugin.data payload; the image we send must be exactly this wide, so it is
 * rounded to whole pixels (a fractional canvas width gets truncated).
 */
function keyWidth(key: Key): number {
  const width = Number(key?.width || key?.style?.width || DEFAULT_KEY_WIDTH);
  if (!Number.isFinite(width)) return DEFAULT_KEY_WIDTH;
  return Math.max(MIN_KEY_WIDTH, Math.round(width));
}

/** Shortens SDK errors, whose messages can embed the whole base64 image. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : `${error}`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// FlexDesigner default background colors, which we replace with our own theme
const DEFAULT_BG_COLORS = ['#000000', '#040404', '#424242', '#4b4b4b'];

function userBgColor(key: Key): string | undefined {
  const bgColor = key.style?.bgColor;
  if (typeof bgColor !== 'string' || !bgColor) return undefined;
  if (DEFAULT_BG_COLORS.includes(bgColor.toLowerCase())) return undefined;
  return bgColor;
}

async function renderKey(key: Key): Promise<string> {
  const width = keyWidth(key);

  if (lockedUntil && Date.now() < lockedUntil) {
    const lift = formatTimeUntilReset(new Date(lockedUntil).toISOString());
    return renderMessageKey(width, 'Rate limited', `Resumes in ${lift}`);
  }

  if (lastUsage) {
    const metric: Metric = key.data?.metric || 'session';
    const snapshot = getMetricSnapshot(lastUsage, metric);
    return snapshot
      ? renderUsageKey(width, snapshot, {
          showResetTime: key.data?.showResetTime !== false,
          showClawd: key.data?.showClawd === true,
          bgColor: userBgColor(key),
        })
      : renderMessageKey(width, 'Claude Code', 'No data for this limit');
  }

  const { title, message } = lastError ?? {
    title: 'Claude Code',
    message: 'Loading…',
  };
  return renderMessageKey(width, title, message);
}

/** The current copy of a key, or null once it is dead or its device is gone. */
function aliveKey(serialNumber: string, uid: unknown): Key | null {
  if (offlineDevices.has(serialNumber)) return null;
  return aliveKeys.get(serialNumber)?.find(key => key.uid === uid) ?? null;
}

/**
 * Sends an image covering the whole key and waits for FlexDesigner's
 * acknowledgement; rejects when the device or key is gone.
 */
async function sendImage(serialNumber: string, key: Key, image: string) {
  // keep FlexDesigner from layering the key's default icon/title/emoji over
  // the image, like ENIAC's own flexbar-ai-dashboard plugin does before its
  // base64 draws
  const target = {
    ...key,
    style: {
      ...key.style,
      showIcon: false,
      showTitle: false,
      showEmoji: false,
    },
  };
  await plugin.draw(serialNumber, target, 'base64', image);
}

/** Runs a draw task after every draw queued before it. */
function queueDraw(task: () => Promise<void>): Promise<void> {
  const pass = drawChain.then(task);
  drawChain = pass.catch(() => undefined);
  return drawChain;
}

/**
 * Renders one usage key and waits for FlexDesigner's acknowledgement.
 * plugin.draw returns a promise that rejects when the device is gone or the
 * key is no longer alive; left unhandled, that rejection terminates the
 * plugin process, so every failure is caught and logged here.
 */
async function drawKey(serialNumber: string, uid: unknown) {
  const key = aliveKey(serialNumber, uid);
  if (!key) return;
  try {
    await sendImage(serialNumber, key, await renderKey(key));
  } catch (error) {
    logger?.warn(`Could not draw key ${uid}: ${describeError(error)}`);
  }
}

/**
 * Redraws every alive key. Passes are queued so overlapping triggers (poll,
 * key press, page load, rate-limit ticker) never interleave their draws, and
 * each key is looked up again right before it is drawn.
 */
function drawAll(): Promise<void> {
  return queueDraw(async () => {
    const targets = [...aliveKeys].flatMap(([serialNumber, keys]) =>
      keys.map(key => [serialNumber, key.uid] as const)
    );
    for (const [serialNumber, uid] of targets) {
      await drawKey(serialNumber, uid);
    }
  });
}

// Session Status keys: driven by local transcripts, never by the usage API
const sessionKeys = new SessionKeys({
  enqueue: queueDraw,
  send: sendImage,
  isOffline: serialNumber => offlineDevices.has(serialNumber),
  keyWidth,
  bgColor: userBgColor,
  loadConfig: getConfigCached,
  logger,
});

function clearLock() {
  lockedUntil = null;
  if (lockTicker) {
    clearInterval(lockTicker);
    lockTicker = null;
  }
}

/**
 * Enters lockout for the given duration: no requests are made until it
 * expires (the window counts down server-side regardless of further
 * requests), and a ticker keeps the countdown on the keys fresh.
 */
function setLock(seconds: number) {
  lockedUntil = Date.now() + seconds * 1000;
  logger?.warn(`Usage endpoint rate limited, backing off for ${seconds}s`);
  if (lockTicker) clearInterval(lockTicker);
  lockTicker = setInterval(async () => {
    if (lockedUntil && Date.now() >= lockedUntil) {
      clearLock();
      await refresh();
    } else {
      await drawAll();
    }
  }, 15_000);
}

function hasAliveKeys(): boolean {
  for (const keys of aliveKeys.values()) {
    if (keys.length > 0) return true;
  }
  return false;
}

function refresh(): Promise<void> {
  if (!inFlight) {
    inFlight = doRefresh().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doRefresh() {
  const now = Date.now();
  if (lockedUntil && now < lockedUntil) {
    await drawAll();
    return;
  }
  if (now - lastFetchAt < MIN_FETCH_GAP_MS) return;
  if (!hasAliveKeys()) return;
  lastFetchAt = now;

  const cfg = await getConfigCached();
  try {
    lastUsage = await fetchUsage(cfg.credentialsPath);
    lastError = null;
    clearLock();
  } catch (error) {
    lastError = errorKeyText(error);
    logger?.error('Failed to fetch Claude usage:', error);
    if (error instanceof UsageError && error.code === 'rate-limited') {
      setLock(error.retryAfterSeconds ?? DEFAULT_LOCKOUT_SECONDS);
    } else {
      lastUsage = null;
    }
  }
  await drawAll();
}

function pollIntervalMs(): number {
  const seconds = Number(config?.pollInterval) || DEFAULT_POLL_INTERVAL;
  return Math.max(MIN_POLL_INTERVAL, seconds) * 1000;
}

function ensurePolling(restart = false) {
  if (pollTimer && !restart) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, pollIntervalMs());
}

/**
 * Called when plugin keys are loaded onto a device page (page switch, profile
 * upload, device reconnect). The payload lists every alive key of this plugin
 * on the device, with FlexDesigner's current uid and width for each.
 */
plugin.on('plugin.alive', async payload => {
  const serialNumber: string | undefined = payload?.serialNumber;
  if (!serialNumber) return;
  const keys: Key[] = (payload.keys ?? []).filter(
    (key: Key) => key?.cid === USAGE_CID
  );
  offlineDevices.delete(serialNumber);
  void sessionKeys.alive(serialNumber, payload.keys ?? []);
  if (keys.length === 0) {
    aliveKeys.delete(serialNumber);
    return;
  }
  aliveKeys.set(serialNumber, keys);
  logger?.info(
    `Usage keys alive on ${serialNumber}: ` +
      keys.map(key => `uid=${key.uid} width=${keyWidth(key)}`).join(', ')
  );

  ensurePolling();
  // Always paint right away (cached data, error or "Loading…"), so the key
  // never keeps showing whatever the device had before
  await drawAll();
  if (!lastUsage) await refresh();
});

/**
 * Called when plugin keys leave the device page. Their uids are reassigned
 * by the next profile upload, so drawing to them must stop immediately.
 */
plugin.on('plugin.dead', payload => {
  const serialNumber: string | undefined = payload?.serialNumber;
  if (!serialNumber) return;
  void sessionKeys.dead(serialNumber, payload.keys ?? []);
  const dead = new Set((payload.keys ?? []).map((key: Key) => key?.uid));
  const remaining =
    dead.size === 0
      ? []
      : (aliveKeys.get(serialNumber) ?? []).filter(key => !dead.has(key.uid));
  if (remaining.length > 0) {
    aliveKeys.set(serialNumber, remaining);
  } else {
    aliveKeys.delete(serialNumber);
  }
});

/**
 * Called when a device connects or disconnects. While it is gone, draws are
 * skipped; FlexDesigner sends plugin.alive again once it is back.
 */
plugin.on('device.status', devices => {
  if (!Array.isArray(devices)) return;
  for (const device of devices) {
    if (!device?.serialNumber) continue;
    if (device.status === 'disconnected') {
      offlineDevices.add(device.serialNumber);
    } else if (device.status === 'connected') {
      offlineDevices.delete(device.serialNumber);
    }
  }
});

/**
 * Called when the user presses a key: force an immediate refresh. The payload
 * carries the key as FlexDesigner currently knows it, so keep that copy (its
 * width may have changed since plugin.alive).
 */
plugin.on('plugin.data', async payload => {
  const pressed: Key = payload?.data?.key;
  if (pressed?.cid === SESSION_CID) {
    await sessionKeys.press(payload.serialNumber, pressed);
    return;
  }
  if (pressed?.cid !== USAGE_CID) return;
  const keys = aliveKeys.get(payload.serialNumber);
  const index = keys?.findIndex(key => key.uid === pressed.uid) ?? -1;
  if (keys && index >= 0) keys[index] = pressed;
  await refresh();
});

/**
 * Called when received message from UI send by this.$fd.sendToBackend
 */
plugin.on('ui.message', async payload => {
  logger?.info('Received message from UI:', payload.data);

  if (payload.data === 'session-status') {
    return sessionKeys.describe(`${payload.filter ?? ''}`);
  }

  if (payload.data === 'test-connection') {
    if (lockedUntil && Date.now() < lockedUntil) {
      const lift = formatTimeUntilReset(new Date(lockedUntil).toISOString());
      return { success: false, error: `Rate limited, retry in ${lift}` };
    }
    try {
      const usage = await fetchUsage(payload.config?.credentialsPath);
      const session = getMetricSnapshot(usage, 'session');
      const weekly = getMetricSnapshot(usage, 'weekly');
      return {
        success: true,
        session: session?.percent ?? null,
        weekly: weekly?.percent ?? null,
      };
    } catch (error) {
      const message = error instanceof UsageError ? error.message : `${error}`;
      return { success: false, error: message };
    }
  }
});

/**
 * Called when the global plugin config changes
 */
plugin.on('plugin.config.updated', async (payload: { config?: Config }) => {
  config = payload?.config ?? {};
  await sessionKeys.configure(config);
  ensurePolling(true);
  await refresh();
});

// Connect to flexdesigner and start the plugin
plugin.start();
