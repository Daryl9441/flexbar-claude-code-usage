/**
 * Kimi's default face: the unused share of the total monthly membership
 * quota. Code's rolling limits and the current task's context are separate
 * metrics; none of them can stand in for the membership total.
 */
import { createCanvas } from '@napi-rs/canvas';

import { FONT } from '../../fonts';
import {
  COLORS,
  KEY_HEIGHT,
  drawMark,
  ellipsize,
  pixelWidth,
} from '../../render';
import {
  KeyText,
  Lang,
  UsageFace,
  UsageFaceRequest,
  UsageMetric,
} from '../types';

import { KIMI_BRAND } from './brand';

/** Saved setting of the default membership view; `monthly` stays a meter. */
export const MEMBERSHIP_METRIC = 'membership';

/**
 * The total quota's remaining percentage, preserving two decimal places.
 * A missing or invalid total is unknown, never a full quota.
 */
export function membershipRemaining(metric: UsageMetric | null): number | null {
  if (metric?.id !== 'monthly' || !Number.isFinite(metric.percent)) return null;
  const used = Math.min(100, Math.max(0, metric.percent));
  return Math.round((100 - used) * 100) / 100;
}

export function membershipMissingText(lang: Lang): KeyText {
  return lang === 'zh'
    ? { title: '会员总额不可用', message: '未返回总会员额度' }
    : {
        title: 'Total usage unavailable',
        message: 'Membership total not reported',
      };
}

/** Absolute reset date and time in the computer's local timezone. */
export function formatMembershipReset(
  reset: string | null,
  lang: Lang
): string {
  if (!reset) return '';
  const date = new Date(reset);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const local = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
  return lang === 'zh' ? `${local} 重置` : `Resets ${local}`;
}

export type MembershipFaceOptions = {
  showResetTime: boolean;
  showMark?: boolean;
  bgColor?: string;
  lang: Lang;
};

/** Contrast for a light custom key background. */
function lightBackground(color: string | undefined): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(color?.trim() ?? '');
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const [red, green, blue] = [
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
  ];
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.6;
}

/**
 * A 60 px membership face: Kimi and the monthly reset on top, the total
 * remaining percentage below. Narrow keys retain the number and shorten
 * the header; secondary text is omitted before it can collide.
 */
export function renderMembershipKey(
  width: number,
  monthly: UsageMetric,
  options: MembershipFaceOptions
): string {
  const remaining = membershipRemaining(monthly);
  if (remaining === null) {
    throw new Error('A valid total monthly membership metric is required.');
  }
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');
  const light = lightBackground(options.bgColor);
  const text = light ? '#171717' : COLORS.text;
  const muted = light ? '#57534e' : COLORS.label;
  const track = light ? '#dedbd8' : COLORS.barTrack;
  const padding = keyWidth < 120 ? 6 : 10;
  const contentWidth = Math.max(0, keyWidth - padding * 2);
  const right = keyWidth - padding;
  const wide = keyWidth >= 180;
  const mark =
    options.showMark !== false && KIMI_BRAND.mark !== 'clawd'
      ? KIMI_BRAND.mark
      : null;
  const markWidth = mark ? 18 : 0;
  const label = options.lang === 'zh' ? '会员总额剩余' : 'Membership left';
  const shortLabel = options.lang === 'zh' ? '会员剩余' : 'Total left';
  const reset = options.showResetTime
    ? formatMembershipReset(monthly.resetsAt, options.lang)
    : '';
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

  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = muted;
  ctx.font = `11px ${FONT}`;
  const header = wide || keyWidth < 90 ? 'Kimi' : `Kimi · ${shortLabel}`;
  const headerX = padding + (wide ? 0 : markWidth);
  if (mark && !wide) markAt(padding, 1);
  ctx.fillStyle = muted;
  ctx.fillText(ellipsize(ctx, header, right - headerX), headerX, 14);

  // Keep the entire absolute reset timestamp or leave it out on a narrow key.
  const headerWidth = ctx.measureText(header).width + headerX - padding;
  if (
    reset &&
    ctx.measureText(reset).width + headerWidth + 12 <= contentWidth
  ) {
    ctx.textAlign = 'right';
    ctx.fillText(reset, right, 14);
  }

  const percent = `${remaining}%`;
  const valueSpace = wide ? contentWidth * 0.52 : contentWidth;
  let size = 25;
  for (; size > 12; size--) {
    ctx.font = `bold ${size}px ${FONT}`;
    if (ctx.measureText(percent).width <= valueSpace) break;
  }
  ctx.fillStyle = text;
  ctx.textAlign = wide ? 'right' : 'center';
  ctx.fillText(
    ellipsize(ctx, percent, valueSpace),
    wide ? right : keyWidth / 2,
    41
  );

  if (wide) {
    const percentWidth = ctx.measureText(percent).width;
    if (mark) markAt(padding, 23);
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = muted;
    const labelSpace = Math.max(
      0,
      contentWidth - percentWidth - 10 - markWidth
    );
    ctx.fillText(
      ellipsize(
        ctx,
        ctx.measureText(label).width <= labelSpace ? label : shortLabel,
        labelSpace
      ),
      padding + markWidth,
      36
    );
  }

  if (contentWidth > 0) {
    ctx.fillStyle = track;
    ctx.fillRect(padding, 49, contentWidth, 5);
    if (remaining > 0) {
      ctx.fillStyle = '#3d8bff';
      ctx.fillRect(padding, 49, (contentWidth * remaining) / 100, 5);
    }
  }
  return canvas.toDataURL('image/png');
}

/** Only the default view changes; explicitly selected meters stay intact. */
export function kimiUsageFace(request: UsageFaceRequest): UsageFace | null {
  if (request.metric !== MEMBERSHIP_METRIC && request.metric !== '')
    return null;
  const monthly =
    request.metrics.find(metric => metric.id === 'monthly') ?? null;
  if (membershipRemaining(monthly) === null || !monthly) {
    return { text: membershipMissingText(request.lang) };
  }
  return {
    image: renderMembershipKey(request.width, monthly, {
      showResetTime: request.showResetTime,
      showMark: request.data.showMark !== false,
      bgColor: request.bgColor,
      lang: request.lang,
    }),
  };
}
