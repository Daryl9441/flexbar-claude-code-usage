import { SKRSContext2D, createCanvas } from '@napi-rs/canvas';

import { FONT } from './fonts';
import { NewSessionState, NewSessionView } from './newSession';
import { COLORS, KEY_HEIGHT, ellipsize, pixelWidth, textWidth } from './render';

const ERROR_COLOR = '#d9534f';
const ICON_GLYPH = '#ffffff';

// Keys up to this width show the icon only
const ICON_ONLY_MAX_WIDTH = 100;
// Text block must stay inside this height (6px margin above and below)
const MAX_BLOCK_HEIGHT = 48;
const SUBTITLE_GAP = 3;

export type NewSessionRenderOptions = {
  bgColor?: string;
};

/**
 * The key icon: a "+" in a Claude-orange circle, three dots while the app
 * is being opened, and a "!" in a red circle when it could not be opened.
 */
function drawIcon(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  r: number,
  state: NewSessionState
) {
  ctx.fillStyle = state === 'error' ? ERROR_COLOR : COLORS.claude;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = ICON_GLYPH;
  ctx.strokeStyle = ICON_GLYPH;
  ctx.lineCap = 'round';
  if (state === 'opening') {
    const dot = Math.max(1.6, r * 0.13);
    for (const dx of [-r * 0.42, 0, r * 0.42]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy, dot, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (state === 'error') {
    ctx.lineWidth = Math.max(2, r * 0.17);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.48);
    ctx.lineTo(cx, cy + r * 0.12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.45, ctx.lineWidth * 0.6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const arm = r * 0.5;
  ctx.lineWidth = Math.max(2, r * 0.17);
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy);
  ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm);
  ctx.lineTo(cx, cy + arm);
  ctx.stroke();
}

const CJK_RE = /[⺀-鿿가-힯豈-﫿＀-￯]/;

/**
 * Every way to put text on two lines: at each space, and between
 * characters next to CJK text (which needs no spaces).
 */
function twoLineSplits(text: string): [string, string][] {
  const chars = Array.from(text);
  const splits: [string, string][] = [];
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] === ' ') {
      splits.push([chars.slice(0, i).join(''), chars.slice(i + 1).join('')]);
    } else if (
      chars[i - 1] !== ' ' &&
      (CJK_RE.test(chars[i]) || CJK_RE.test(chars[i - 1])) &&
      !/[…。，、）]/.test(chars[i])
    ) {
      splits.push([chars.slice(0, i).join(''), chars.slice(i).join('')]);
    }
  }
  return splits;
}

type TitleLayout = { size: number; lines: string[] };

function titleFont(size: number) {
  return `bold ${size}px ${FONT}`;
}

/**
 * The title at the largest size that fits: one line first, then two
 * balanced lines; null when it fits neither way even at 10px.
 */
function layoutTitle(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxSize: number
): TitleLayout | null {
  const fits = (line: string) => textWidth(ctx, line) <= maxWidth;
  for (let size = maxSize; size >= 12; size--) {
    ctx.font = titleFont(size);
    if (fits(text)) return { size, lines: [text] };
  }
  for (let size = Math.min(maxSize, 13); size >= 10; size--) {
    ctx.font = titleFont(size);
    let best: [string, string] | null = null;
    let bestWidth = Infinity;
    for (const split of twoLineSplits(text)) {
      const width = Math.max(...split.map(line => textWidth(ctx, line)));
      if (width <= maxWidth && width < bestWidth) {
        best = split;
        bestWidth = width;
      }
    }
    if (best) return { size, lines: best };
    if (fits(text)) return { size, lines: [text] };
  }
  return null;
}

/** The icon alone, centered: narrow keys and titles that do not fit. */
function drawIconOnly(
  ctx: SKRSContext2D,
  keyWidth: number,
  state: NewSessionState
) {
  const r = Math.max(10, Math.min(17, (keyWidth - 16) / 2));
  drawIcon(ctx, keyWidth / 2, KEY_HEIGHT / 2, r, state);
}

/**
 * Renders a New Session key face (60px tall, any width from 60px): the
 * icon, the title ("New Session", or the press feedback) and the project
 * folder name as a subtitle when one is set. Keys up to 100px wide, and
 * keys too narrow for the title in full, show the icon only.
 */
export function renderNewSessionKey(
  width: number,
  view: NewSessionView,
  options: NewSessionRenderOptions = {}
): string {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  if (keyWidth <= ICON_ONLY_MAX_WIDTH) {
    drawIconOnly(ctx, keyWidth, view.state);
    return canvas.toDataURL('image/png');
  }

  const narrow = keyWidth < 150;
  const pad = narrow ? 8 : 12;
  const r = narrow ? 13 : 16;
  const x = pad + r * 2 + (narrow ? 7 : 11);
  const maxWidth = keyWidth - pad - x;
  const title = layoutTitle(ctx, view.title, maxWidth, narrow ? 14 : 15);
  if (!title) {
    drawIconOnly(ctx, keyWidth, view.state);
    return canvas.toDataURL('image/png');
  }
  drawIcon(ctx, pad + r, KEY_HEIGHT / 2, r, view.state);

  const lineHeight = Math.round(title.size * 1.2);

  // the subtitle only when it fits under the title, at 11px or at 10px
  let subtitle: { text: string; size: number } | null = null;
  if (view.subtitle) {
    for (const size of [11, 10]) {
      const height = title.lines.length * lineHeight + SUBTITLE_GAP + size;
      if (height > MAX_BLOCK_HEIGHT) continue;
      ctx.font = `${size}px ${FONT}`;
      const text = ellipsize(ctx, view.subtitle, maxWidth);
      if (text && text !== '…') subtitle = { text, size };
      break;
    }
  }

  const blockHeight =
    title.lines.length * lineHeight +
    (subtitle ? SUBTITLE_GAP + subtitle.size + 1 : 0);
  let y = (KEY_HEIGHT - blockHeight) / 2;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.text;
  ctx.font = titleFont(title.size);
  for (const line of title.lines) {
    ctx.fillText(line, x, y + lineHeight / 2 + 0.5);
    y += lineHeight;
  }
  if (subtitle) {
    ctx.fillStyle = COLORS.label;
    ctx.font = `${subtitle.size}px ${FONT}`;
    ctx.fillText(subtitle.text, x, y + SUBTITLE_GAP + subtitle.size / 2 + 1);
  }

  return canvas.toDataURL('image/png');
}
