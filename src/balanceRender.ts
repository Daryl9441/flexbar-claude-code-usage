/**
 * A 60 px key face for a prepaid balance: the amount, not a used-percent
 * meter. There is no quota to fill a bar against, so the amount is the
 * reading and a short detail line carries the breakdown.
 */
import { createCanvas } from '@napi-rs/canvas';

import { FONT } from './fonts';
import type { KeyMark } from './providers/types';
import { COLORS, KEY_HEIGHT, drawMark, ellipsize, pixelWidth } from './render';
import { TONE_COLORS } from './sessionView';

export type BalanceFaceModel = {
  /** Header, e.g. "DeepSeek" or "Kimi". */
  product: string;
  /** What the amount is, e.g. "Balance" or "API 剩余". */
  caption: string;
  /** Already formatted, e.g. "¥110.00". */
  amountText: string;
  /** Second line. Omitted when it does not fit. */
  detail: string;
  /** False draws the amount in the error colour. */
  available: boolean;
  accent: string;
  showMark: boolean;
  mark: KeyMark | null;
  bgColor?: string;
};

/** Contrast for a light custom key background. */
function lightBackground(color: string | undefined): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(color?.trim() ?? '');
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.6;
}

/** PNG data URL for one balance reading. */
export function renderBalanceKey(
  width: number,
  model: BalanceFaceModel
): string {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');
  const light = lightBackground(model.bgColor);
  const text = light ? '#171717' : COLORS.text;
  const muted = light ? '#57534e' : COLORS.label;
  const padding = keyWidth < 120 ? 6 : 10;
  const right = keyWidth - padding;
  const mark = model.showMark && model.mark ? model.mark : null;
  const markWidth = mark ? 18 : 0;
  const amountColor = model.available ? text : TONE_COLORS.error;

  ctx.fillStyle = model.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const markAt = (x: number, y: number) => {
    if (!mark) return;
    if (light) {
      ctx.fillStyle = COLORS.background;
      ctx.beginPath();
      ctx.roundRect(x - 1, y - 1, 16, 16, 3);
      ctx.fill();
    }
    drawMark(ctx, mark, x, y, 14);
  };

  ctx.fillStyle = muted;
  ctx.font = `11px ${FONT}`;
  const headerX = padding + markWidth;
  if (mark) markAt(padding, 1);
  const headerSpace = Math.max(0, right - headerX);
  const header =
    ctx.measureText(model.product).width <= headerSpace
      ? model.product
      : model.caption;
  ctx.fillText(ellipsize(ctx, header, headerSpace), headerX, 14);

  const amountSpace = Math.max(
    0,
    keyWidth - padding * 2 - (keyWidth >= 180 ? 8 : 0)
  );
  let size = keyWidth >= 180 ? 22 : 18;
  for (; size > 12; size--) {
    ctx.font = `bold ${size}px ${FONT}`;
    if (ctx.measureText(model.amountText).width <= amountSpace) break;
  }
  ctx.fillStyle = amountColor;
  ctx.font = `bold ${size}px ${FONT}`;
  const amountWidth = ctx.measureText(model.amountText).width;
  const amountY = model.detail && keyWidth >= 160 ? 36 : 42;
  ctx.fillText(ellipsize(ctx, model.amountText, amountSpace), padding, amountY);

  ctx.font = `11px ${FONT}`;
  ctx.fillStyle = muted;
  if (keyWidth >= 180 && amountWidth + 12 < amountSpace) {
    const captionSpace = amountSpace - amountWidth - 12;
    ctx.fillText(
      ellipsize(ctx, model.caption, captionSpace),
      padding + amountWidth + 10,
      amountY
    );
  }

  if (model.detail && keyWidth >= 140) {
    ctx.fillText(
      ellipsize(ctx, model.detail, Math.max(0, keyWidth - padding * 2)),
      padding,
      54
    );
  }

  ctx.fillStyle = model.available ? model.accent : TONE_COLORS.error;
  ctx.fillRect(0, 0, 3, KEY_HEIGHT);
  return canvas.toDataURL('image/png');
}
