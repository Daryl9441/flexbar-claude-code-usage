import { Image, SKRSContext2D, createCanvas, loadImage } from '@napi-rs/canvas';

import { CLAWD_PNG_BASE64 } from './clawd';
import { FONT } from './fonts';
import { MetricSnapshot, formatTimeUntilReset } from './usage';

export const KEY_HEIGHT = 60;
const DEFAULT_KEY_WIDTH = 240;
const ELLIPSIS = '…';

export const COLORS = {
  background: '#1c1917',
  label: '#a8a29e',
  text: '#fafaf9',
  chipText: '#e7e5e4',
  barTrack: '#3f3b38',
  chipBg: '#2e2a27',
  claude: '#d97757',
};

// Bar color stops: green at 0%, orange at 75%, red at 100%
const COLOR_STOPS: [number, [number, number, number]][] = [
  [0, [0x61, 0xaa, 0x5c]],
  [75, [0xe0, 0x8c, 0x3c]],
  [100, [0xd9, 0x53, 0x4f]],
];

/** Interpolates the bar color along the green -> orange -> red gradient. */
export function percentToColor(percent: number): string {
  const p = Math.max(0, Math.min(100, percent));
  let [lowStop, lowColor] = COLOR_STOPS[0];
  for (const [stop, color] of COLOR_STOPS) {
    if (p <= stop) {
      const range = stop - lowStop;
      const t = range === 0 ? 0 : (p - lowStop) / range;
      const mix = lowColor.map((c, i) => Math.round(c + (color[i] - c) * t));
      return `#${mix.map(c => c.toString(16).padStart(2, '0')).join('')}`;
    }
    lowStop = stop;
    lowColor = color;
  }
  return '#d9534f';
}

let clawdImage: Promise<Image> | null = null;

/**
 * The official Clawd artwork (background removed), decoded once.
 * Image decoding in @napi-rs/canvas is asynchronous — drawing in the same
 * tick as `img.src = ...` silently produces nothing, hence loadImage.
 */
export function getClawdImage(): Promise<Image> {
  if (!clawdImage) {
    clawdImage = loadImage(Buffer.from(CLAWD_PNG_BASE64, 'base64'));
  }
  return clawdImage;
}

/** Renders Clawd as a standalone square icon (transparent background). */
export async function renderClawdIcon(size: number): Promise<Buffer> {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const img = await getClawdImage();
  const scale = Math.min(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toBuffer('image/png');
}

/**
 * Whole-pixel canvas width. createCanvas truncates fractions (179.5 -> 179),
 * silently falls back to 350px for zero/negative values and throws on strings.
 */
export function pixelWidth(width: number): number {
  const w = Math.round(Number(width));
  return Number.isFinite(w) && w > 0 ? w : DEFAULT_KEY_WIDTH;
}

export function textWidth(ctx: SKRSContext2D, text: string): number {
  return ctx.measureText(text).width;
}

/**
 * Longest prefix of chars (as a count) whose rendering, with suffix appended,
 * fits maxWidth in the current font.
 */
function fittingPrefix(
  ctx: SKRSContext2D,
  chars: string[],
  maxWidth: number,
  suffix = ''
): number {
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join('').trimEnd() + suffix;
    if (textWidth(ctx, candidate) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Shortens text with a trailing ellipsis until it fits maxWidth in the current
 * font. Never squashes glyphs (unlike fillText's maxWidth argument).
 */
export function ellipsize(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string {
  if (textWidth(ctx, text) <= maxWidth) return text;
  const chars = Array.from(text);
  const n = fittingPrefix(ctx, chars, maxWidth, ELLIPSIS);
  if (n > 0) return chars.slice(0, n).join('').trimEnd() + ELLIPSIS;
  return textWidth(ctx, ELLIPSIS) <= maxWidth ? ELLIPSIS : '';
}

/**
 * Greedy word wrap into at most maxLines lines in the current font. Words
 * wider than a line (or text without spaces, e.g. CJK) break between
 * characters; the last line is ellipsized when text is left over.
 */
export function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest && lines.length < maxLines) {
    if (textWidth(ctx, rest) <= maxWidth) {
      lines.push(rest);
      break;
    }
    if (lines.length === maxLines - 1) {
      lines.push(ellipsize(ctx, rest, maxWidth));
      break;
    }
    const chars = Array.from(rest);
    // at least one character per line so the loop always progresses
    let cut = Math.max(1, fittingPrefix(ctx, chars, maxWidth));
    if (chars[cut] !== ' ') {
      const space = chars.lastIndexOf(' ', cut - 1);
      if (space > 0) cut = space;
    }
    lines.push(chars.slice(0, cut).join('').trimEnd());
    rest = chars.slice(cut).join('').trimStart();
  }
  return lines;
}

/**
 * Largest font size in [minSize, maxSize] at which text fits maxWidth; sets
 * it on the context and returns it (minSize when nothing fits).
 */
function fitFont(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
  weight = ''
): number {
  let size = maxSize;
  for (; size > minSize; size--) {
    ctx.font = `${weight} ${size}px ${FONT}`.trim();
    if (textWidth(ctx, text) <= maxWidth) return size;
  }
  ctx.font = `${weight} ${minSize}px ${FONT}`.trim();
  return minSize;
}

const CHIP_HEIGHT = 22;
const CHIP_FONT = `bold 12px ${FONT}`;

/**
 * The limit label as it fits maxWidth in the current font: in full, without
 * a leading "Claude " (model names), or ellipsized while at least 4
 * characters remain. Null when none of these fit.
 */
function fitLabel(
  ctx: SKRSContext2D,
  label: string,
  maxWidth: number
): string | null {
  if (!label.trim()) return null;
  const short = label.replace(/^Claude\s+/i, '') || label;
  for (const candidate of [label, short]) {
    if (textWidth(ctx, candidate) <= maxWidth) return candidate;
  }
  const fitted = ellipsize(ctx, short, maxWidth);
  const kept = Array.from(fitted.replace(ELLIPSIS, '')).length;
  return kept >= Math.min(4, Array.from(short).length) ? fitted : null;
}

/** Fits the tag chip into maxWidth, tightening its padding first. */
function fitChip(
  ctx: SKRSContext2D,
  label: string,
  maxWidth: number
): { label: string; padX: number } | null {
  ctx.font = CHIP_FONT;
  if (textWidth(ctx, label) + 9 * 2 <= maxWidth) return { label, padX: 9 };
  const fitted = fitLabel(ctx, label, maxWidth - 6 * 2);
  return fitted ? { label: fitted, padX: 6 } : null;
}

/** Draws the tag chip right-aligned at rightX; returns its left edge. */
function drawChip(
  ctx: SKRSContext2D,
  rightX: number,
  y: number,
  label: string,
  padX = 9
): number {
  ctx.font = CHIP_FONT;
  const labelWidth = ctx.measureText(label).width;
  const height = CHIP_HEIGHT;
  const width = labelWidth + padX * 2;
  const x = rightX - width;

  ctx.fillStyle = COLORS.chipBg;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fill();
  ctx.strokeStyle = COLORS.barTrack;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = COLORS.chipText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + width / 2, y + height / 2 + 1);
  return x;
}

export type RenderOptions = {
  showResetTime: boolean;
  showClawd: boolean;
  bgColor?: string;
};

// Room the meter needs beside Clawd; on narrower keys Clawd is left out
const MIN_METER_WIDTH = 80;

/**
 * Renders a usage meter key face, clawdmeter style: optional Clawd mascot on
 * the left, a prominent percentage with the reset countdown next to it, a tag
 * chip naming the limit in the top right, and the progress bar underneath.
 *
 * Narrow keys degrade instead of overlapping: the reset countdown moves to
 * its own line under the bar, the chip is shortened, becomes a plain label
 * and is then dropped, Clawd is left out, and the percentage shrinks only as
 * a last resort.
 */
export async function renderUsageKey(
  width: number,
  snapshot: MetricSnapshot,
  options: RenderOptions
): Promise<string> {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  const padding = keyWidth < 120 ? 8 : 12;
  const rightX = keyWidth - padding;
  let contentX = padding;

  if (options.showClawd) {
    const img = await getClawdImage();
    const clawdHeight = 34;
    const clawdWidth = (img.width / img.height) * clawdHeight;
    const clawdX = padding - 2;
    const meterX = clawdX + clawdWidth + 14;
    if (rightX - meterX >= MIN_METER_WIDTH) {
      ctx.drawImage(
        img,
        clawdX,
        (KEY_HEIGHT - clawdHeight) / 2,
        clawdWidth,
        clawdHeight
      );
      contentX = meterX;
    }
  }
  const contentWidth = rightX - contentX;

  const percentText = `${snapshot.percent}%`;
  const percentSize = fitFont(ctx, percentText, contentWidth, 26, 14, 'bold');
  const percentWidth = textWidth(ctx, percentText);

  const reset = options.showResetTime
    ? formatTimeUntilReset(snapshot.resetsAt)
    : '';
  const resetText = reset ? `Resets ${reset}` : '';
  ctx.font = `12px ${FONT}`;
  const resetWidth = resetText ? textWidth(ctx, resetText) : 0;
  ctx.font = CHIP_FONT;
  const fullChipWidth = textWidth(ctx, snapshot.label) + 9 * 2;

  // one row with percentage, countdown and chip when everything fits;
  // otherwise the countdown gets its own line under the (raised) bar
  const resetInline =
    !!resetText &&
    percentWidth + 10 + resetWidth + 8 + fullChipWidth <= contentWidth;
  const resetBelow = !!resetText && !resetInline;
  const textBaseline = resetBelow ? 25 : 28;
  const barY = resetBelow ? 32 : 38;

  // tag chip, top right, never overlapping the percentage; the short tag
  // ("5h", "7d") rather than a shortened label, a plain label when no chip
  // fits, nothing when neither does
  const labelSpace = resetInline
    ? fullChipWidth
    : contentWidth - percentWidth - 8;
  const tag = snapshot.tag ?? '';
  let chip = fitChip(ctx, snapshot.label, labelSpace);
  if (tag && chip?.label !== snapshot.label) {
    chip = fitChip(ctx, tag, labelSpace) ?? chip;
  }
  if (chip) {
    drawChip(ctx, rightX, resetBelow ? 4 : 7, chip.label, chip.padX);
  } else {
    ctx.font = `bold 11px ${FONT}`;
    let label = fitLabel(ctx, snapshot.label, labelSpace);
    if (tag && label !== snapshot.label) {
      label = fitLabel(ctx, tag, labelSpace) ?? label;
    }
    if (label) {
      ctx.fillStyle = COLORS.chipText;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(label, rightX, textBaseline);
    }
  }

  // percentage, prominent
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold ${percentSize}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(percentText, contentX, textBaseline);

  // reset countdown, right of the percentage or on its own line
  if (resetInline) {
    ctx.fillStyle = COLORS.label;
    ctx.font = `12px ${FONT}`;
    ctx.fillText(resetText, contentX + percentWidth + 10, textBaseline);
  } else if (resetBelow) {
    ctx.fillStyle = COLORS.label;
    ctx.font = `11px ${FONT}`;
    // drop the "Resets" prefix before giving up on the countdown
    const text = [resetText, reset].find(
      t => textWidth(ctx, t) <= contentWidth
    );
    if (text) ctx.fillText(text, contentX, 54);
  }

  // progress bar
  const barHeight = 8;
  if (contentWidth >= barHeight) {
    ctx.fillStyle = COLORS.barTrack;
    ctx.beginPath();
    ctx.roundRect(contentX, barY, contentWidth, barHeight, barHeight / 2);
    ctx.fill();

    const fillWidth = Math.min(
      contentWidth,
      Math.max(barHeight, (contentWidth * snapshot.percent) / 100)
    );
    ctx.fillStyle = percentToColor(snapshot.percent);
    ctx.beginPath();
    ctx.roundRect(contentX, barY, fillWidth, barHeight, barHeight / 2);
    ctx.fill();
  }

  return canvas.toDataURL('image/png');
}

/**
 * Renders an error/placeholder key face: a title and a message wrapped onto
 * up to two lines (ellipsized beyond that) — never squashed to fit.
 */
export function renderMessageKey(
  width: number,
  title: string,
  message: string
): string {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  const padX = keyWidth < 100 ? 6 : 10;
  const maxWidth = keyWidth - padX * 2;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.font = `12px ${FONT}`;
  const lines = wrapText(ctx, message, maxWidth, 2);
  const wrapped = lines.length > 1;

  ctx.fillStyle = COLORS.claude;
  fitFont(ctx, title, maxWidth, 13, 10, '600');
  ctx.fillText(ellipsize(ctx, title, maxWidth), padX, wrapped ? 6 : 10);

  ctx.fillStyle = COLORS.label;
  ctx.font = `12px ${FONT}`;
  lines.forEach((line, i) => {
    ctx.fillText(line, padX, (wrapped ? 25 : 32) + i * 15);
  });

  return canvas.toDataURL('image/png');
}
