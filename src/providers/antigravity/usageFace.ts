/**
 * Antigravity usage key: the dual face (`gemini-dual`, `3p-dual`): what is
 * LEFT of one model group's 5-hour and weekly limits on one key, drawn by
 * the shared dual renderer (src/usageDualRender.ts, Claude's dual look).
 * Wide keys add a column naming the group (and the Antigravity mark), so
 * two dual keys side by side can be told apart; narrow keys keep the plain
 * dual face with the brand edge.
 */
import { SKRSContext2D, createCanvas, loadImage } from '@napi-rs/canvas';

import { FONT } from '../../fonts';
import {
  COLORS,
  KEY_HEIGHT,
  RenderOptions,
  drawBrandEdge,
  drawMark,
  ellipsize,
  percentToColor,
  pixelWidth,
} from '../../render';
import {
  MetricSnapshot,
  formatTimeUntilReset,
  remainingPercent,
  resetsText,
} from '../../usage';
import { renderDualUsageKey } from '../../usageDualRender';
import { KeyMark, KeyText, Lang, UsageMetric } from '../types';

import { planCycleLabel } from './usageCycle';

/** Keys at least this wide get the group column. */
export const GROUP_COLUMN_MIN_WIDTH = 180;
/**
 * Width of the group column, which is where the dual face starts: the name
 * stays clear of the dual face's row tags ("5h", "7d"), which begin at least
 * 8 px further in, so it never reads as one label with them.
 */
const COLUMN = 44;
/** Widest group name: under the mark, and without it (larger type) */
const NAME_MAX = COLUMN - 8;
const NAME_MAX_PLAIN = COLUMN - 6;
const MARK = 24;

export type DualFaceOptions = {
  showResetTime: boolean;
  bgColor?: string;
  /** The brand mark (behind the key's showMark setting) */
  mark?: KeyMark;
  /** Brand colour: the right edge of narrow keys */
  markColor?: string;
};

function snapshot(metric: UsageMetric | null): MetricSnapshot | null {
  if (!metric) return null;
  return {
    percent: metric.percent,
    resetsAt: metric.resetsAt,
    label: metric.label,
    ...(metric.tag ? { tag: metric.tag } : {}),
  };
}

/** True for a light custom background (dark text reads better on it). */
function isLight(color: string | undefined): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color?.trim() ?? '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** The message face when the last fetch has neither limit of the group. */
export function dualMissingText(lang: Lang): KeyText {
  return lang === 'zh'
    ? { title: 'Antigravity', message: '这些限制暂无数据' }
    : { title: 'Antigravity', message: 'No data for these limits' };
}

/** True when neither limit has a value to show. */
export function dualEmpty(
  fiveHour: UsageMetric | null,
  weekly: UsageMetric | null
): boolean {
  return (
    remainingPercent(snapshot(fiveHour)) === null &&
    remainingPercent(snapshot(weekly)) === null
  );
}

/**
 * The dual face of one group: rows "5h" and "7d" with what is left, and on
 * wide keys a column with the mark and the group's short name ("Gemini").
 */
export async function renderGroupDualKey(
  width: number,
  groupName: string,
  fiveHour: UsageMetric | null,
  weekly: UsageMetric | null,
  options: DualFaceOptions
): Promise<string> {
  const keyWidth = pixelWidth(width);
  const dual = (w: number) =>
    renderDualUsageKey(w, snapshot(fiveHour), snapshot(weekly), {
      showResetTime: options.showResetTime,
      bgColor: options.bgColor,
    });
  const wide = keyWidth >= GROUP_COLUMN_MIN_WIDTH;
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  const face = dual(wide ? keyWidth - COLUMN : keyWidth);
  const image = await loadImage(Buffer.from(face.split(',')[1], 'base64'));
  ctx.drawImage(image, wide ? COLUMN : 0, 0);

  if (!wide) {
    if (options.mark && options.markColor) {
      drawBrandEdge(ctx, keyWidth, options.markColor);
    }
    return canvas.toDataURL('image/png');
  }

  const name = groupName.trim();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = isLight(options.bgColor) ? '#57534e' : COLORS.label;
  const centre = COLUMN / 2 + 1;
  if (options.mark) {
    drawMark(ctx, options.mark, centre - MARK / 2, 9, MARK);
    ctx.font = `bold 10px ${FONT}`;
    ctx.fillText(ellipsize(ctx, name, NAME_MAX), centre, 50);
  } else {
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillText(ellipsize(ctx, name, NAME_MAX_PLAIN), centre, 34);
  }
  return canvas.toDataURL('image/png');
}

function clampUsed(percent: number): number {
  const value = Number(percent);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function drawWindowChip(
  ctx: SKRSContext2D,
  rightX: number,
  y: number,
  label: string
) {
  ctx.font = `bold 11px ${FONT}`;
  const padX = 5;
  const width = ctx.measureText(label).width + padX * 2;
  const height = 16;
  const x = rightX - width;
  ctx.fillStyle = COLORS.chipBg;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 5);
  ctx.fill();
  ctx.strokeStyle = COLORS.barTrack;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = COLORS.chipText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + width / 2, y + height / 2 + 0.5);
}

/**
 * One press-rotation limit: the group name on its own line (shortened to
 * fit), the window as a chip, then the percent left and the reset countdown.
 */
export async function renderCycleLimitKey(
  width: number,
  groupName: string,
  windowLabel: { word: string; tag: string },
  snapshot: MetricSnapshot,
  options: RenderOptions
): Promise<string> {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  const pad = keyWidth < 100 ? 6 : 10;
  let contentX = pad;
  const rightX = keyWidth - pad;
  const markSize = 24;
  const showMark =
    !!options.mark && !options.showClawd && rightX - (pad + markSize + 8) >= 88;
  if (showMark && options.mark) {
    drawMark(ctx, options.mark, pad, (KEY_HEIGHT - markSize) / 2, markSize);
    contentX = pad + markSize + 8;
  } else if (options.mark && options.markColor) {
    drawBrandEdge(ctx, keyWidth, options.markColor);
  }
  const contentWidth = Math.max(0, rightX - contentX);
  const plan = planCycleLabel(
    contentWidth,
    groupName,
    windowLabel,
    (text, size) => {
      ctx.font = `bold ${size}px ${FONT}`;
      return ctx.measureText(text).width;
    }
  );
  ctx.font = `bold ${plan.size}px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(plan.name, contentX, 16);
  if (plan.chipOnName && plan.chip) drawWindowChip(ctx, rightX, 3, plan.chip);

  const used = clampUsed(snapshot.percent);
  const display = options.shown === 'remaining' ? 100 - used : snapshot.percent;
  const percentText = `${display}%`;
  const reset = options.showResetTime
    ? formatTimeUntilReset(snapshot.resetsAt, options.lang)
    : '';
  const resetText = resetsText(reset, options.lang);
  const tagOnRow = !plan.chipOnName && plan.chip ? plan.chip : '';
  ctx.font = `bold 11px ${FONT}`;
  const tagWidth = tagOnRow ? ctx.measureText(tagOnRow).width + 6 : 0;
  const percentBudget = Math.max(16, contentWidth - tagWidth);
  let percentSize = 22;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold ${percentSize}px ${FONT}`;
  while (
    percentSize > 13 &&
    ctx.measureText(percentText).width > percentBudget
  ) {
    percentSize -= 1;
    ctx.font = `bold ${percentSize}px ${FONT}`;
  }
  ctx.fillStyle = COLORS.text;
  ctx.fillText(percentText, contentX, 38);
  let cursor = contentX + ctx.measureText(percentText).width + 6;
  if (tagOnRow) {
    ctx.font = `bold 11px ${FONT}`;
    if (cursor + ctx.measureText(tagOnRow).width <= rightX) {
      ctx.fillStyle = COLORS.chipText;
      ctx.fillText(tagOnRow, cursor, 37);
      cursor += ctx.measureText(tagOnRow).width + 6;
    }
  }
  if (resetText) {
    ctx.font = `11px ${FONT}`;
    const resetDraw =
      ctx.measureText(resetText).width <= rightX - cursor ? resetText : reset;
    if (resetDraw && ctx.measureText(resetDraw).width <= rightX - cursor) {
      ctx.fillStyle = COLORS.label;
      ctx.fillText(resetDraw, cursor, 37);
    }
  }

  const barHeight = 8;
  const barY = 46;
  if (contentWidth >= barHeight) {
    ctx.fillStyle = COLORS.barTrack;
    ctx.beginPath();
    ctx.roundRect(contentX, barY, contentWidth, barHeight, barHeight / 2);
    ctx.fill();
    const fillWidth = Math.min(
      contentWidth,
      Math.max(barHeight, (contentWidth * display) / 100)
    );
    ctx.fillStyle = percentToColor(
      options.shown === 'remaining' ? used : snapshot.percent
    );
    ctx.beginPath();
    ctx.roundRect(contentX, barY, fillWidth, barHeight, barHeight / 2);
    ctx.fill();
  }
  return canvas.toDataURL('image/png');
}
