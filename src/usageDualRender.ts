import { SKRSContext2D, createCanvas } from '@napi-rs/canvas';

import { FONT } from './fonts';
import {
  COLORS,
  KEY_HEIGHT,
  percentToColor,
  pixelWidth,
  textWidth,
} from './render';
import {
  MetricSnapshot,
  formatTimeUntilReset,
  remainingPercent,
} from './usage';

export type DualRenderOptions = {
  showResetTime: boolean;
  bgColor?: string;
};

// Vertical centre of the 5h row and of the 7d row
const ROW_CENTERS = [16.5, 43.5];
const ROW_LABELS = ['5h', '7d'];
const DIGIT_SIZE = 22;
const DIGIT_SIZE_WIDE = 24;
const GAUGE_HEIGHT = 5;
// Narrowest gauge worth drawing, and the least the inline countdown column
// leaves it (below that, a caption above a longer gauge reads better)
const MIN_GAUGE = 20;
const MIN_INLINE_GAUGE = 72;
// Clear air between a countdown caption and the row label or number
const CAPTION_AIR = 10;
// A row with this much left or less highlights its countdown
const LOW_LEFT = 25;
// Widest countdown dualCountdown produces; its column is reserved for it
const COUNTDOWN_TEMPLATE = '0h 00m';

type CountdownStyle = { size: number; compact: boolean };

// Countdown styles, most readable first
const COUNTDOWN_STYLES: CountdownStyle[] = [
  { size: 11, compact: false },
  { size: 11, compact: true },
  { size: 10, compact: true },
];

type Mode = 'inline' | 'stack' | 'bar' | 'bare';

type Row = {
  label: string;
  /** remaining percent, null for a missing window */
  remaining: number | null;
  color: string;
  countdown: string;
};

/**
 * Time until a reset for the dual key: formatTimeUntilReset without zero
 * units ("2d 0h" -> "2d"), bounded to the "0h 00m" shape (10h or more keeps
 * only the hours, "23h 59m" -> "23h"). `compact` drops the space ("4h12m").
 * Empty when the reset time is unknown or not a valid date.
 */
export function dualCountdown(
  resetsAt: string | null | undefined,
  compact = false
): string {
  if (!resetsAt || Number.isNaN(new Date(resetsAt).getTime())) return '';
  const text = formatTimeUntilReset(resetsAt)
    .split(' ')
    .filter((part, i) => i === 0 || !/^0[a-z]$/.test(part))
    .join(' ')
    .replace(/^(\d{2,}[a-z]) \d+[a-z]$/, '$1');
  return compact ? text.replace(/ /g, '') : text;
}

function hexToRgb(color: string): number[] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex =
    match[1].length === 3 ? match[1].replace(/./g, c => c + c) : match[1];
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Color a mixed toward b by t; fallback unless both are #rgb or #rrggbb. */
function mix(a: string, b: string, t: number, fallback: string): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  if (!from || !to) return fallback;
  const channels = from.map((c, i) => Math.round(c + (to[i] - c) * t));
  return `#${channels.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

const glyphRadius = (size: number) => size * 0.36;

/** Room the reset glyph takes left of the countdown text, gap included. */
function glyphBox(size: number): number {
  const r = glyphRadius(size);
  return 1.45 * r + r + 0.7 + 2;
}

/**
 * "Resets in" glyph: a clockwise open-circle arrow, drawn as paths so it
 * looks the same whatever fonts the system has (↻ renders thin or as tofu).
 */
function drawResetGlyph(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  const a0 = (-30 * Math.PI) / 180;
  const a1 = (220 * Math.PI) / 180;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
  // arrowhead at the end of the arc, pointing along the clockwise tangent
  const ex = cx + r * Math.cos(a1);
  const ey = cy + r * Math.sin(a1);
  const [tx, ty] = [-Math.sin(a1), Math.cos(a1)];
  const [nx, ny] = [Math.cos(a1), Math.sin(a1)];
  const h = r * 0.7;
  ctx.beginPath();
  ctx.moveTo(ex + tx * h * 1.2, ey + ty * h * 1.2);
  ctx.lineTo(ex - tx * h * 0.3 + nx * h, ey - ty * h * 0.3 + ny * h);
  ctx.lineTo(ex - tx * h * 0.3 - nx * h, ey - ty * h * 0.3 - ny * h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function countdownText(countdown: string, style: CountdownStyle): string {
  return style.compact ? countdown.replace(/ /g, '') : countdown;
}

/** Width of glyph plus countdown text in the given style. */
function countdownWidth(
  ctx: SKRSContext2D,
  countdown: string,
  style: CountdownStyle
): number {
  ctx.font = `${style.size}px ${FONT}`;
  return glyphBox(style.size) + textWidth(ctx, countdownText(countdown, style));
}

/** Draws glyph and countdown, right-aligned at right, centred on cy. */
function drawCountdown(
  ctx: SKRSContext2D,
  countdown: string,
  style: CountdownStyle,
  right: number,
  cy: number,
  color: string
) {
  const text = countdownText(countdown, style);
  ctx.font = `${style.size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.fillText(text, right, cy + Math.round(style.size * 0.72) / 2);
  const r = glyphRadius(style.size);
  const gx = right - textWidth(ctx, text) - 2 - (r + 0.7);
  drawResetGlyph(ctx, gx, cy, r, color);
}

/** The first style in which the countdown fits maxWidth, or null. */
function fitCountdown(
  ctx: SKRSContext2D,
  countdown: string,
  maxWidth: number
): CountdownStyle | null {
  return (
    COUNTDOWN_STYLES.find(
      style => countdownWidth(ctx, countdown, style) <= maxWidth
    ) ?? null
  );
}

/**
 * Renders the dual Usage Meter key face: what is LEFT of the 5-hour (top row,
 * "5h") and weekly (bottom row, "7d") limits. Each row reads label, gauge,
 * remaining percentage and, on wide keys, the time until the limit resets.
 *
 * - The remaining percentage is the most prominent element, colored by
 *   status (green: plenty left, orange: getting low, red: almost none).
 * - The gauge fills with what is left, like a battery; its track is tinted
 *   with the status color, so an exhausted limit shows a dark red row.
 * - The layout follows the width and the settings (and whether any reset
 *   time is known), never the percentages: columns are reserved for the
 *   widest number and countdown, so nothing moves as the values change.
 *
 * Narrow keys drop pieces in this order: the countdown column becomes a
 * caption above the gauge, the caption goes (a row with nothing left still
 * shows its countdown where it fits), then the gauge. A missing window is
 * shown muted with a dash. Clawd is left out: both rows already use the full
 * key height, so it could only add width.
 */
export function renderDualUsageKey(
  width: number,
  session: MetricSnapshot | null,
  weekly: MetricSnapshot | null,
  options: DualRenderOptions
): string {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');
  const bg = options.bgColor || COLORS.background;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);
  ctx.textBaseline = 'alphabetic';

  const rows: Row[] = [session, weekly].map((snapshot, i) => {
    const remaining = remainingPercent(snapshot);
    return {
      label: ROW_LABELS[i],
      remaining,
      color:
        remaining === null ? COLORS.label : percentToColor(100 - remaining),
      countdown:
        remaining !== null && options.showResetTime
          ? dualCountdown(snapshot?.resetsAt)
          : '',
    };
  });

  const wide = keyWidth >= 160;
  const pad = keyWidth < 84 ? 5 : keyWidth < 110 ? 7 : wide ? 12 : 8;
  const labelToGauge = wide ? 8 : 6;
  const gaugeToNumber = wide ? 10 : 7;
  const numberToCountdown = 12;
  let startX = pad;
  const right = keyWidth - pad;
  const content = right - startX;

  const labelSize = keyWidth >= 90 ? 11 : 10;
  const labelFont = `bold ${labelSize}px ${FONT}`;
  ctx.font = labelFont;
  const labelWidth = Math.max(...rows.map(r => textWidth(ctx, r.label)));

  // "100" drops its "%" next to a gauge, which is then full and says it
  // all; that keeps it as wide as "99%". Without a gauge it keeps the "%".
  const percentSize = (size: number) => Math.round(size * 0.58);
  const numberWidth = (digits: string, percent: boolean, size: number) => {
    ctx.font = `bold ${size}px ${FONT}`;
    let w = textWidth(ctx, digits);
    if (percent) {
      ctx.font = `bold ${percentSize(size)}px ${FONT}`;
      w += 1 + textWidth(ctx, '%');
    }
    return w;
  };
  const numberColumn = (size: number, gauge: boolean) =>
    gauge
      ? Math.max(numberWidth('99', true, size), numberWidth('100', false, size))
      : numberWidth('100', true, size);

  // --- the richest mode that fits ------------------------------------------
  let digitSize = keyWidth >= 240 ? DIGIT_SIZE_WIDE : DIGIT_SIZE;
  let numberCol = numberColumn(digitSize, true);
  const gaugeRoom =
    content - labelWidth - labelToGauge - numberCol - gaugeToNumber;
  const anyCountdown = rows.some(r => r.countdown);
  let mode: Mode = 'bare';
  let columnStyle: CountdownStyle | null = null;
  let columnWidth = 0;
  let captionStyle: CountdownStyle | null = null;
  // keeps a caption CAPTION_AIR clear of the number
  const captionInset = Math.max(0, CAPTION_AIR - gaugeToNumber);

  if (anyCountdown) {
    // a countdown column right of the numbers
    const style = COUNTDOWN_STYLES[0];
    const w = countdownWidth(ctx, COUNTDOWN_TEMPLATE, style);
    if (gaugeRoom - numberToCountdown - w >= MIN_INLINE_GAUGE) {
      mode = 'inline';
      columnStyle = style;
      columnWidth = w;
    }
    // else a caption above the gauge, clear of both label and number
    if (mode === 'bare') {
      captionStyle =
        COUNTDOWN_STYLES.find(
          style =>
            countdownWidth(ctx, COUNTDOWN_TEMPLATE, style) +
              captionInset +
              Math.max(0, CAPTION_AIR - labelToGauge) <=
            gaugeRoom
        ) ?? null;
      if (captionStyle) mode = 'stack';
    }
  }
  if (mode === 'bare' && gaugeRoom >= MIN_GAUGE) mode = 'bar';

  let numberRight =
    mode === 'inline' ? right - columnWidth - numberToCountdown : right;
  if (mode === 'bare') {
    // label and numbers as one block, centred, so they do not drift apart
    const gap = keyWidth >= 84 ? 8 : 5;
    while (
      digitSize > 10 &&
      labelWidth + gap + numberColumn(digitSize, false) > content
    ) {
      digitSize--;
    }
    numberCol = numberColumn(digitSize, false);
    const block = labelWidth + gap + numberCol;
    startX = Math.max(pad, Math.round((keyWidth - block) / 2));
    numberRight = startX + block;
  }
  const gaugeX = startX + labelWidth + labelToGauge;
  const gaugeRight = numberRight - numberCol - gaugeToNumber;
  const gaugeWidth = gaugeRight - gaugeX;

  // --- draw ----------------------------------------------------------------
  const digitCap = Math.round(digitSize * 0.73);
  const labelCap = Math.round(labelSize * 0.72);
  const muted = mix(COLORS.label, bg, 0.5, COLORS.label);
  // countdowns sit a step behind the row labels, unless the row runs low
  const quiet = mix(COLORS.label, bg, 0.18, COLORS.label);
  const countdownColor = (row: Row) =>
    row.remaining !== null && row.remaining <= LOW_LEFT
      ? COLORS.chipText
      : quiet;

  rows.forEach((row, i) => {
    const cy = ROW_CENTERS[i];
    const missing = row.remaining === null;
    const showPercent100 = mode === 'bare';

    ctx.font = labelFont;
    ctx.textAlign = 'left';
    ctx.fillStyle = missing ? muted : COLORS.label;
    ctx.fillText(row.label, startX, cy + labelCap / 2);

    // a row with nothing left shows when it comes back in place of its
    // empty gauge, or between label and number on a gauge-less key
    let emptyCountdown: { style: CountdownStyle; right: number } | null = null;
    if (
      row.remaining === 0 &&
      row.countdown &&
      (mode === 'bar' || mode === 'bare')
    ) {
      let slot = gaugeWidth;
      let slotRight = gaugeRight;
      if (mode === 'bare') {
        const shown = numberWidth('0', true, digitSize);
        slotRight = numberRight - shown - 6;
        slot = slotRight - (startX + labelWidth + 6);
      }
      const style = fitCountdown(ctx, row.countdown, slot);
      if (style) emptyCountdown = { style, right: slotRight };
    }

    if (mode !== 'bare' && !emptyCountdown) {
      const y = mode === 'stack' ? cy + 2.5 : cy - GAUGE_HEIGHT / 2;
      ctx.fillStyle = missing
        ? mix(COLORS.barTrack, bg, 0.5, COLORS.barTrack)
        : mix(bg, row.color, 0.26, COLORS.barTrack);
      ctx.beginPath();
      ctx.roundRect(gaugeX, y, gaugeWidth, GAUGE_HEIGHT, GAUGE_HEIGHT / 2);
      ctx.fill();
      if (row.remaining !== null && row.remaining > 0) {
        ctx.fillStyle = row.color;
        ctx.beginPath();
        ctx.roundRect(
          gaugeX,
          y,
          Math.max(GAUGE_HEIGHT, (gaugeWidth * row.remaining) / 100),
          GAUGE_HEIGHT,
          GAUGE_HEIGHT / 2
        );
        ctx.fill();
      }
      if (mode === 'stack' && captionStyle && row.countdown) {
        drawCountdown(
          ctx,
          row.countdown,
          captionStyle,
          gaugeRight - captionInset,
          cy - 5,
          countdownColor(row)
        );
      }
    }
    if (emptyCountdown) {
      drawCountdown(
        ctx,
        row.countdown,
        emptyCountdown.style,
        emptyCountdown.right,
        cy,
        countdownColor(row)
      );
    }

    // remaining percentage: big digits, small "%"
    const baseline = cy + digitCap / 2;
    ctx.textAlign = 'right';
    if (row.remaining === null) {
      ctx.font = `bold ${Math.round(digitSize * 0.8)}px ${FONT}`;
      ctx.fillStyle = muted;
      ctx.fillText('—', numberRight, baseline - Math.round(digitCap * 0.12));
    } else {
      // a touch lighter than the gauge, for crisper digits
      ctx.fillStyle = mix(row.color, COLORS.text, 0.15, row.color);
      let x = numberRight;
      if (row.remaining < 100 || showPercent100) {
        ctx.font = `bold ${percentSize(digitSize)}px ${FONT}`;
        ctx.fillText('%', x, baseline);
        x -= textWidth(ctx, '%') + 1;
      }
      ctx.font = `bold ${digitSize}px ${FONT}`;
      ctx.fillText(String(row.remaining), x, baseline);
    }

    if (mode === 'inline' && columnStyle && row.countdown) {
      drawCountdown(
        ctx,
        row.countdown,
        columnStyle,
        right,
        cy,
        countdownColor(row)
      );
    }
  });

  return canvas.toDataURL('image/png');
}
