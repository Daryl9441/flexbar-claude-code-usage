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
// Battery gauge: a 1 px outline (odd height, so it sits on whole pixels at
// the row centres), a 5 px fill 1 px inside it and a cap on the right end
const BATTERY_HEIGHT = 9;
const BATTERY_INSET = 2;
const CAP_WIDTH = 2;
const CAP_HEIGHT = 5;
// Narrowest gauge worth drawing, and the least the inline countdown column
// leaves it (below that, a caption above a longer gauge reads better)
const MIN_GAUGE = 20;
const MIN_INLINE_GAUGE = 72;
// Clear air between a countdown and the row label or number
const CAPTION_AIR = 10;
// Air between a caption and the gauge under it
const CAPTION_GAP = 4;
// A row with this much left or less highlights its countdown
const LOW_LEFT = 25;
// Smallest text drawn; a "%" that would be smaller is left out
const MIN_TEXT = 10;
// Most the digits of a gauge-less key shrink to keep the "%" of "100"
const MAX_SHRINK = 2;
// Widest countdown dualCountdown produces; its column is reserved for it
const COUNTDOWN_TEMPLATE = '0h 00m';

type CountdownStyle = { size: number; compact: boolean };

// Countdown styles, most readable first. Captions and the column use only
// the first; an exhausted row's countdown, its only extra, may use any.
const COUNTDOWN_STYLES: CountdownStyle[] = [
  { size: 11, compact: false },
  { size: 11, compact: true },
  { size: 10, compact: true },
];

export type DualMode = 'inline' | 'stack' | 'bar' | 'bare';

// How a number column is sized: "100%", "100" without "%" (next to a full
// gauge, as wide as "99%"), or no "%" at all
type NumberFormat = 'percent' | 'gauge' | 'digits';

type Row = {
  label: string;
  /** remaining percent, null for a missing window */
  remaining: number | null;
  /** time until the reset, '' when unknown or hidden */
  countdown: string;
};

export type DualCountdownLayout = {
  /** text as drawn, compacted when the style asks for it */
  text: string;
  size: number;
  /** right edge of the countdown and its vertical centre */
  right: number;
  cy: number;
};

export type DualRowLayout = Row & {
  cy: number;
  labelBaseline: number;
  digitBaseline: number;
  /** top of the battery gauge, null when no gauge is drawn */
  gaugeY: number | null;
  countdownLayout: DualCountdownLayout | null;
  /** whether "%" follows the digits */
  percent: boolean;
};

export type DualLayout = {
  mode: DualMode;
  width: number;
  labelX: number;
  labelSize: number;
  labelWidth: number;
  /** battery gauge span, cap included (zero width in 'bare' mode) */
  gaugeX: number;
  gaugeWidth: number;
  numberRight: number;
  digitSize: number;
  percentSize: number;
  rows: DualRowLayout[];
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

/** Hex color a mixed toward b by t; a itself unless both are hex colors. */
function mix(a: string, b: string, t: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  if (!from || !to) return a;
  const channels = from.map((c, i) => Math.round(c + (to[i] - c) * t));
  return `#${channels.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The background as #rrggbb, read back from the pixel just painted with it,
 * so any color the canvas accepts (rgb(), #rrggbbaa, names) can be mixed.
 */
function paintedColor(ctx: SKRSContext2D): string {
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance of a hex color, null when it does not parse. */
function luminance(color: string): number | null {
  const rgb = hexToRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
  countdown: DualCountdownLayout,
  color: string
) {
  const { text, size, right, cy } = countdown;
  ctx.font = `${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'right';
  ctx.fillText(text, right, cy + Math.round(size * 0.72) / 2);
  const r = glyphRadius(size);
  const gx = right - textWidth(ctx, text) - 2 - (r + 0.7);
  drawResetGlyph(ctx, gx, cy, r, color);
}

/**
 * The countdown in the first style that fits maxWidth, right-aligned at
 * right and centred on cy; null when none fits.
 */
function placeCountdown(
  ctx: SKRSContext2D,
  countdown: string,
  styles: CountdownStyle[],
  maxWidth: number,
  right: number,
  cy: number
): DualCountdownLayout | null {
  const style = styles.find(s => countdownWidth(ctx, countdown, s) <= maxWidth);
  return style
    ? { text: countdownText(countdown, style), size: style.size, right, cy }
    : null;
}

const percentSizeOf = (size: number) => Math.round(size * 0.58);

/** Width of a number as drawn: bold digits plus an optional smaller "%". */
function numberWidth(
  ctx: SKRSContext2D,
  digits: string,
  percent: boolean,
  size: number
): number {
  ctx.font = `bold ${size}px ${FONT}`;
  let w = textWidth(ctx, digits);
  if (percent) {
    ctx.font = `bold ${percentSizeOf(size)}px ${FONT}`;
    w += 1 + textWidth(ctx, '%');
  }
  return w;
}

/** Width reserved for the widest number in the given format. */
function numberColumn(
  ctx: SKRSContext2D,
  size: number,
  format: NumberFormat
): number {
  if (format === 'percent') return numberWidth(ctx, '100', true, size);
  if (format === 'digits') return numberWidth(ctx, '100', false, size);
  return Math.max(
    numberWidth(ctx, '99', true, size),
    numberWidth(ctx, '100', false, size)
  );
}

function rowsOf(
  session: MetricSnapshot | null,
  weekly: MetricSnapshot | null,
  options: DualRenderOptions
): Row[] {
  return [session, weekly].map((snapshot, i) => {
    const remaining = remainingPercent(snapshot);
    return {
      label: ROW_LABELS[i],
      remaining,
      countdown:
        remaining !== null && options.showResetTime
          ? dualCountdown(snapshot?.resetsAt)
          : '',
    };
  });
}

/**
 * Picks the richest layout that fits the key width and places every
 * element. The layout follows the width and whether any reset time is
 * known, never the percentages: columns are reserved for the widest number
 * and countdown, so nothing moves as the values change.
 */
function layoutRows(
  ctx: SKRSContext2D,
  keyWidth: number,
  rows: Row[]
): DualLayout {
  const wide = keyWidth >= 160;
  const pad = keyWidth < 84 ? 5 : keyWidth < 110 ? 7 : wide ? 12 : 8;
  const labelToGauge = wide ? 8 : 6;
  const gaugeToNumber = wide ? 10 : 7;
  const numberToCountdown = 12;
  let labelX = pad;
  const right = keyWidth - pad;
  const content = right - labelX;

  const labelSize = keyWidth >= 90 ? 11 : 10;
  ctx.font = `bold ${labelSize}px ${FONT}`;
  const labelWidth = Math.max(...rows.map(r => textWidth(ctx, r.label)));

  let digitSize = keyWidth >= 240 ? DIGIT_SIZE_WIDE : DIGIT_SIZE;
  let format: NumberFormat = 'gauge';
  let numberCol = numberColumn(ctx, digitSize, format);
  const gaugeRoom =
    content - labelWidth - labelToGauge - numberCol - gaugeToNumber;
  const anyCountdown = rows.some(r => r.countdown);
  const caption = COUNTDOWN_STYLES[0];
  const columnWidth = countdownWidth(ctx, COUNTDOWN_TEMPLATE, caption);
  // keeps a caption CAPTION_AIR clear of the number and of the label
  const captionInset = Math.max(0, CAPTION_AIR - gaugeToNumber);
  const captionLead = Math.max(0, CAPTION_AIR - labelToGauge);

  let mode: DualMode = 'bare';
  if (
    anyCountdown &&
    gaugeRoom - numberToCountdown - columnWidth >= MIN_INLINE_GAUGE
  ) {
    mode = 'inline';
  } else if (
    anyCountdown &&
    columnWidth + captionInset + captionLead <= gaugeRoom
  ) {
    mode = 'stack';
  } else if (gaugeRoom >= MIN_GAUGE) {
    mode = 'bar';
  }

  let numberRight =
    mode === 'inline' ? right - columnWidth - numberToCountdown : right;
  if (mode === 'bare') {
    // label and numbers as one block, centred, so they do not drift apart.
    // Without a gauge "100" keeps its "%" unless that would shrink the
    // digits by more than MAX_SHRINK; then it drops it (as next to a
    // gauge), and every row drops it once a "%" would be smaller than
    // MIN_TEXT.
    const gap = keyWidth >= 84 ? 8 : 5;
    const fits = (size: number, f: NumberFormat) =>
      labelWidth + gap + numberColumn(ctx, size, f) <= content;
    const largest = digitSize;
    const fitted = (f: NumberFormat, smallest: number) => {
      let size = largest;
      while (size > smallest && !fits(size, f)) size--;
      return fits(size, f) ? size : null;
    };
    const withPercent = fitted('percent', largest - MAX_SHRINK);
    const withoutPercent100 = fitted('gauge', MIN_TEXT);
    if (withPercent !== null) {
      format = 'percent';
      digitSize = withPercent;
    } else if (
      withoutPercent100 !== null &&
      percentSizeOf(withoutPercent100) >= MIN_TEXT
    ) {
      digitSize = withoutPercent100;
    } else {
      format = 'digits';
      digitSize = fitted('digits', MIN_TEXT) ?? MIN_TEXT;
    }
    numberCol = numberColumn(ctx, digitSize, format);
    const block = labelWidth + gap + numberCol;
    labelX = Math.max(pad, Math.round((keyWidth - block) / 2));
    numberRight = labelX + block;
  }
  // whole pixels, so the battery outline stays crisp
  const gaugeX =
    mode === 'bare' ? 0 : Math.round(labelX + labelWidth + labelToGauge);
  const gaugeRight =
    mode === 'bare' ? 0 : Math.round(numberRight - numberCol - gaugeToNumber);
  const gaugeWidth = gaugeRight - gaugeX;

  const digitCap = Math.round(digitSize * 0.73);
  const labelCap = Math.round(labelSize * 0.72);
  const captionCap = Math.round(caption.size * 0.72);

  const placed = rows.map((row, i): DualRowLayout => {
    const cy = ROW_CENTERS[i];
    const digitBaseline = cy + digitCap / 2;
    let labelBaseline = cy + labelCap / 2;
    let gaugeY: number | null =
      mode === 'bare' ? null : cy - BATTERY_HEIGHT / 2;
    let countdownLayout: DualCountdownLayout | null = null;

    if (row.countdown && mode === 'inline') {
      countdownLayout = placeCountdown(
        ctx,
        row.countdown,
        [caption],
        columnWidth,
        right,
        cy
      );
    } else if (row.countdown && mode === 'stack') {
      // caption over the gauge; gauge and label sit on the digit baseline
      const stackedY = Math.floor(digitBaseline - BATTERY_HEIGHT);
      countdownLayout = placeCountdown(
        ctx,
        row.countdown,
        [caption],
        gaugeWidth - captionInset - captionLead,
        gaugeRight - captionInset,
        stackedY - CAPTION_GAP - captionCap / 2
      );
      if (countdownLayout) {
        gaugeY = stackedY;
        labelBaseline = digitBaseline;
      }
    } else if (row.countdown && mode === 'bar' && row.remaining === 0) {
      // a row with nothing left shows when it comes back in place of its
      // empty gauge, next to its "0%" and clear of the label
      const slotRight =
        numberRight - numberWidth(ctx, '0', true, digitSize) - gaugeToNumber;
      countdownLayout = placeCountdown(
        ctx,
        row.countdown,
        COUNTDOWN_STYLES,
        slotRight - (gaugeX + captionLead),
        slotRight,
        cy
      );
      if (countdownLayout) gaugeY = null;
    }

    return {
      ...row,
      cy,
      labelBaseline,
      digitBaseline,
      gaugeY,
      countdownLayout,
      percent:
        row.remaining !== null &&
        format !== 'digits' &&
        (row.remaining < 100 || format === 'percent'),
    };
  });

  return {
    mode,
    width: keyWidth,
    labelX,
    labelSize,
    labelWidth,
    gaugeX,
    gaugeWidth,
    numberRight,
    digitSize,
    percentSize: percentSizeOf(digitSize),
    rows: placed,
  };
}

/** Where renderDualUsageKey puts everything for these values (for tests). */
export function dualLayout(
  width: number,
  session: MetricSnapshot | null,
  weekly: MetricSnapshot | null,
  options: DualRenderOptions
): DualLayout {
  const ctx = createCanvas(1, 1).getContext('2d');
  return layoutRows(ctx, pixelWidth(width), rowsOf(session, weekly, options));
}

/** Tones for a #rrggbb background: light text on dark, dark on light. */
function tonesFor(bg: string) {
  const light = (luminance(bg) ?? 0) > 0.4;
  const label = light ? '#57534e' : COLORS.label;
  return {
    label,
    // countdowns of rows running low
    strong: light ? COLORS.background : COLORS.chipText,
    // digits lean toward this for crisper edges
    ink: light ? COLORS.background : COLORS.text,
    inkMix: light ? 0.3 : 0.15,
    muted: mix(label, bg, 0.5),
    // countdowns sit a step behind the row labels, unless the row runs low
    quiet: mix(label, bg, 0.18),
    // outline and track of a missing window
    faint: mix(bg, label, 0.22),
  };
}

/**
 * Battery gauge: outline and cap tinted with the status color, the fill
 * (what is left) in it, so a limit with nothing left is an empty red
 * battery. The cap says the bar is a charge left, not an amount used.
 */
function drawBattery(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  remaining: number | null,
  color: string,
  bg: string,
  faint: string
) {
  const body = width - CAP_WIDTH;
  const missing = remaining === null;
  const outline = missing ? faint : mix(bg, color, 0.55);
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, body - 1, BATTERY_HEIGHT - 1, 2.5);
  ctx.stroke();
  ctx.fillStyle = outline;
  ctx.fillRect(
    x + body,
    y + (BATTERY_HEIGHT - CAP_HEIGHT) / 2,
    CAP_WIDTH,
    CAP_HEIGHT
  );

  const inner = body - BATTERY_INSET * 2;
  const innerHeight = BATTERY_HEIGHT - BATTERY_INSET * 2;
  if (!missing && remaining > 0) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(
      x + BATTERY_INSET,
      y + BATTERY_INSET,
      Math.max(2, (inner * remaining) / 100),
      innerHeight,
      1
    );
    ctx.fill();
  }
}

/**
 * Renders the dual Usage Meter key face: what is LEFT of the 5-hour (top row,
 * "5h") and weekly (bottom row, "7d") limits. Each row reads label, battery
 * gauge, remaining percentage and, on wide keys, the time until the limit
 * resets.
 *
 * - The remaining percentage is the most prominent element, colored by
 *   status (green: plenty left, orange: getting low, red: almost none).
 * - The gauge is a battery holding what is left; its outline is tinted with
 *   the status color, so an exhausted limit shows an empty red battery. The
 *   battery cap tells it apart from the used-% bar of the single meters.
 * - The layout follows the width and the settings (and whether any reset
 *   time is known), never the percentages (see layoutRows).
 *
 * Narrow keys drop pieces in this order: the countdown column becomes a
 * caption above the gauge, the caption goes (a row with nothing left still
 * shows its countdown in place of its empty gauge, where it fits), then the
 * gauge, then (below about 72 px) the "%" of "100". A missing window is shown
 * muted with a dash. Light custom backgrounds get dark text. Clawd is left
 * out: both rows already use the full key height, so it could only add
 * width.
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
  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);
  ctx.textBaseline = 'alphabetic';
  const bg = paintedColor(ctx);

  const layout = layoutRows(ctx, keyWidth, rowsOf(session, weekly, options));
  const tones = tonesFor(bg);
  const labelFont = `bold ${layout.labelSize}px ${FONT}`;

  for (const row of layout.rows) {
    const missing = row.remaining === null;
    const color = missing
      ? tones.muted
      : percentToColor(100 - (row.remaining ?? 0));

    ctx.font = labelFont;
    ctx.textAlign = 'left';
    ctx.fillStyle = missing ? tones.muted : tones.label;
    ctx.fillText(row.label, layout.labelX, row.labelBaseline);

    if (row.gaugeY !== null) {
      drawBattery(
        ctx,
        layout.gaugeX,
        row.gaugeY,
        layout.gaugeWidth,
        row.remaining,
        color,
        bg,
        tones.faint
      );
    }
    if (row.countdownLayout) {
      const low = row.remaining !== null && row.remaining <= LOW_LEFT;
      drawCountdown(ctx, row.countdownLayout, low ? tones.strong : tones.quiet);
    }

    // remaining percentage: big digits, small "%"
    ctx.textAlign = 'right';
    if (row.remaining === null) {
      const digitCap = row.digitBaseline - row.cy;
      ctx.font = `bold ${Math.round(layout.digitSize * 0.8)}px ${FONT}`;
      ctx.fillStyle = tones.muted;
      ctx.fillText(
        '—',
        layout.numberRight,
        row.digitBaseline - Math.round(digitCap * 2 * 0.12)
      );
      continue;
    }
    ctx.fillStyle = mix(color, tones.ink, tones.inkMix);
    let x = layout.numberRight;
    if (row.percent) {
      ctx.font = `bold ${layout.percentSize}px ${FONT}`;
      ctx.fillText('%', x, row.digitBaseline);
      x -= textWidth(ctx, '%') + 1;
    }
    ctx.font = `bold ${layout.digitSize}px ${FONT}`;
    ctx.fillText(String(row.remaining), x, row.digitBaseline);
  }

  return canvas.toDataURL('image/png');
}
