/**
 * Antigravity usage key: the dual face (`gemini-dual`, `3p-dual`): what is
 * LEFT of one model group's 5-hour and weekly limits on one key, drawn by
 * the shared dual renderer (src/usageDualRender.ts, Claude's dual look).
 * Wide keys add a column naming the group (and the Antigravity mark), so
 * two dual keys side by side can be told apart; narrow keys keep the plain
 * dual face with the brand edge.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { FONT } from '../../fonts';
import {
  COLORS,
  KEY_HEIGHT,
  drawBrandEdge,
  drawMark,
  ellipsize,
  pixelWidth,
} from '../../render';
import { MetricSnapshot, remainingPercent } from '../../usage';
import { renderDualUsageKey } from '../../usageDualRender';
import { KeyMark, KeyText, Lang, UsageMetric } from '../types';

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
