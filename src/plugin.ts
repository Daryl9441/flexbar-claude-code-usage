import { logger, plugin } from '@eniac/flexdesigner';

import { sweepTerminalScripts } from './launch';
import { createKeyGroups, messageCid } from './providers/registry';
import { Key, KeyGroup, PluginConfig } from './providers/types';

const DEFAULT_POLL_INTERVAL = 180;
const MIN_POLL_INTERVAL = 60;

// Key widths FlexDesigner can report; images are always KEY_HEIGHT (60) tall
const MIN_KEY_WIDTH = 60;
const DEFAULT_KEY_WIDTH = 240;

// Devices reported disconnected: drawing to them only produces rejections
const offlineDevices = new Set<string>();
// All draws go through this chain so they reach FlexDesigner one at a time
let drawChain: Promise<void> = Promise.resolve();

let config: PluginConfig | null = null;

async function getConfigCached(): Promise<PluginConfig> {
  if (config) return config;
  try {
    config = ((await plugin.getConfig()) as PluginConfig) ?? {};
  } catch (error) {
    logger?.warn('Could not load plugin config, using defaults:', error);
    return {};
  }
  return config;
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

// FlexDesigner default background colors, which we replace with our own theme
const DEFAULT_BG_COLORS = ['#000000', '#040404', '#424242', '#4b4b4b'];

function userBgColor(key: Key): string | undefined {
  const bgColor = key.style?.bgColor;
  if (typeof bgColor !== 'string' || !bgColor) return undefined;
  if (DEFAULT_BG_COLORS.includes(bgColor.toLowerCase())) return undefined;
  return bgColor;
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

function pollIntervalMs(): number {
  const seconds = Number(config?.pollInterval) || DEFAULT_POLL_INTERVAL;
  return Math.max(MIN_POLL_INTERVAL, seconds) * 1000;
}

/**
 * Every key type of every provider (src/providers/registry.ts): usage
 * meters poll their provider's usage source, session keys follow local
 * session data, new-session keys open a new session on a press. plugin.draw
 * rejects when a device or key is gone; every group catches and logs that,
 * since an unhandled rejection would terminate the plugin process.
 */
const groups: KeyGroup[] = createKeyGroups({
  enqueue: queueDraw,
  send: sendImage,
  isOffline: serialNumber => offlineDevices.has(serialNumber),
  keyWidth,
  bgColor: userBgColor,
  loadConfig: getConfigCached,
  pollIntervalMs,
  logger,
});

function groupOf(cid: unknown): KeyGroup | null {
  return groups.find(group => group.cid === cid) ?? null;
}

/** Runs an event handler on every group; one failing group spares the rest. */
async function eachGroup(
  event: string,
  handler: (group: KeyGroup) => Promise<unknown>
) {
  await Promise.all(
    groups.map(async group => {
      try {
        await handler(group);
      } catch (error) {
        const text = error instanceof Error ? error.message : `${error}`;
        logger?.warn(`${event} failed for ${group.cid}: ${text.slice(0, 200)}`);
      }
    })
  );
}

/**
 * Called when plugin keys are loaded onto a device page (page switch, profile
 * upload, device reconnect). The payload lists every alive key of this plugin
 * on the device, with FlexDesigner's current uid and width for each; each
 * group picks its own cid.
 */
plugin.on('plugin.alive', async payload => {
  const serialNumber: string | undefined = payload?.serialNumber;
  if (!serialNumber) return;
  offlineDevices.delete(serialNumber);
  const keys: Key[] = payload.keys ?? [];
  await eachGroup('plugin.alive', group => group.alive(serialNumber, keys));
});

/**
 * Called when plugin keys leave the device page. Their uids are reassigned
 * by the next profile upload, so drawing to them must stop immediately.
 */
plugin.on('plugin.dead', async payload => {
  const serialNumber: string | undefined = payload?.serialNumber;
  if (!serialNumber) return;
  const keys: Key[] = payload.keys ?? [];
  await eachGroup('plugin.dead', group => group.dead(serialNumber, keys));
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
 * Called when the user presses a key. The payload carries the key as
 * FlexDesigner currently knows it (its width may have changed since
 * plugin.alive); the key's group handles it.
 */
plugin.on('plugin.data', async payload => {
  const pressed: Key = payload?.data?.key;
  const group = groupOf(pressed?.cid);
  if (!group) return;
  try {
    await group.press(payload.serialNumber, pressed);
  } catch (error) {
    const text = error instanceof Error ? error.message : `${error}`;
    logger?.warn(`Key press failed for ${group.cid}: ${text.slice(0, 200)}`);
  }
});

/**
 * Called when received message from UI send by this.$fd.sendToBackend.
 * Key pages send the cid they are about; the original Claude pages send
 * 'test-connection' and 'session-status' without one.
 */
plugin.on('ui.message', async payload => {
  logger?.info('Received message from UI:', payload?.data);
  const group = groupOf(messageCid(payload ?? {}));
  return group?.message(payload);
});

/**
 * Called when the global plugin config changes
 */
plugin.on(
  'plugin.config.updated',
  async (payload: { config?: PluginConfig }) => {
    config = payload?.config ?? {};
    const next = config;
    await eachGroup('plugin.config.updated', group => group.configure(next));
  }
);

// Terminal scripts an earlier run left behind (Terminal never ran them)
void sweepTerminalScripts();

// Connect to flexdesigner and start the plugin
plugin.start();
