import { SKRSContext2D, createCanvas } from '@napi-rs/canvas';

import { FONT } from './fonts';
import type { KeyMark } from './providers/types';
import {
  COLORS,
  KEY_HEIGHT,
  drawMark as drawProviderMark,
  ellipsize,
  getClawdImage,
  pixelWidth,
  textWidth,
} from './render';
import {
  LIST_ROWS,
  ListView,
  SessionView,
  TONE_COLORS,
  ViewTone,
} from './sessionView';

// Warm dark tint so a key that needs the user stands out at a glance
const ATTENTION_BG = '#2c2215';
// Dimmed main text for sessions that are idle
const IDLE_TEXT = '#c4bfba';

const LABEL_FONT = `bold 13px ${FONT}`;
const TEXT_FONT = `13px ${FONT}`;
const SMALL_FONT = `11px ${FONT}`;
const LIST_FONT = `12px ${FONT}`;
const PAGE_FONT = `10px ${FONT}`;

export type SessionRenderOptions = {
  showClawd: boolean;
  bgColor?: string;
  /** Provider mark drawn where Clawd goes (ignored while showClawd is on) */
  mark?: KeyMark;
};

// Provider marks sit in a square this tall, left of the text
const MARK_SIZE = 26;

/** Status mark: check (done), ring (idle), dot with halo (others). */
function drawMark(ctx: SKRSContext2D, x: number, cy: number, tone: ViewTone) {
  const color = TONE_COLORS[tone];
  const cx = x + 5;
  if (tone === 'done') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 4.5, cy + 0.2);
    ctx.lineTo(cx - 1.5, cy + 3.2);
    ctx.lineTo(cx + 4.5, cy - 3.3);
    ctx.stroke();
    return;
  }
  if (tone === 'idle') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.6, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Header row: status mark and label on the left, elapsed time (and the
 * count of other active sessions) on the right, project name in between.
 * Lower-priority pieces are dropped when the key is too narrow.
 */
function drawHeader(
  ctx: SKRSContext2D,
  view: SessionView,
  x: number,
  rightX: number,
  baseline: number
) {
  const color = TONE_COLORS[view.tone];
  const width = rightX - x;
  const labelX = x + 15;
  ctx.textBaseline = 'alphabetic';

  ctx.font = LABEL_FONT;
  const label = ellipsize(ctx, view.label, Math.max(0, rightX - labelX));
  const labelWidth = textWidth(ctx, label);
  let free = rightX - (labelX + labelWidth);

  ctx.font = SMALL_FONT;
  const time = view.time;
  const timeWidth = time ? textWidth(ctx, time) : 0;
  const showTime = !!time && timeWidth + 8 <= free;
  if (showTime) free -= timeWidth + 8;

  const others = view.others > 0 ? `+${view.others}` : '';
  const othersWidth = others ? textWidth(ctx, others) : 0;
  const showOthers = !!others && othersWidth + 6 <= free;
  if (showOthers) free -= othersWidth + 6;

  drawMark(ctx, x, baseline - 4.5, view.tone);

  ctx.fillStyle = color;
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.fillText(label, labelX, baseline);

  ctx.font = SMALL_FONT;
  let right = rightX;
  if (showTime) {
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'right';
    ctx.fillText(time, right, baseline);
    right -= timeWidth + 6;
  }
  if (showOthers) {
    ctx.fillStyle = TONE_COLORS.working;
    ctx.textAlign = 'right';
    ctx.fillText(others, right, baseline);
  }

  // project name, only when a readable part of it fits
  if (view.project && width >= 150) {
    const project = ellipsize(ctx, view.project, free - 8);
    const kept = Array.from(project.replace(/…$/, '')).length;
    if (project && kept >= Math.min(8, Array.from(view.project).length)) {
      ctx.fillStyle = COLORS.label;
      ctx.textAlign = 'left';
      ctx.fillText(project, labelX + labelWidth + 7, baseline);
    }
  }
}

function drawProgress(
  ctx: SKRSContext2D,
  view: SessionView,
  x: number,
  rightX: number,
  y: number
) {
  const progress = view.progress;
  if (!progress) return;
  const count = `${progress.completed}/${progress.total}`;
  ctx.font = SMALL_FONT;
  const countWidth = textWidth(ctx, count);
  const showCount = rightX - x - countWidth - 6 >= 30;
  const barRight = showCount ? rightX - countWidth - 6 : rightX;
  const barWidth = barRight - x;
  const barHeight = 5;
  if (barWidth < barHeight) return;

  ctx.fillStyle = COLORS.barTrack;
  ctx.beginPath();
  ctx.roundRect(x, y, barWidth, barHeight, barHeight / 2);
  ctx.fill();

  const ratio = progress.total > 0 ? progress.completed / progress.total : 0;
  if (ratio > 0) {
    const complete = progress.completed >= progress.total;
    // blue while in flight, green once complete, else the status tone
    ctx.fillStyle = complete
      ? TONE_COLORS.done
      : TONE_COLORS[view.tone === 'done' ? 'working' : view.tone];
    ctx.beginPath();
    ctx.roundRect(
      x,
      y,
      Math.max(barHeight, barWidth * Math.min(1, ratio)),
      barHeight,
      barHeight / 2
    );
    ctx.fill();
  }

  if (showCount) {
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(count, rightX, y + barHeight / 2 + 0.5);
    ctx.textBaseline = 'alphabetic';
  }
}

// Room the text needs beside Clawd; on narrower keys Clawd is left out
const MIN_CONTENT_WITH_CLAWD = 110;
// Below this width the key shows the status only: mark, time and label
const COMPACT_WIDTH = 96;

const CLOSING_RE = /[。，、；：？！」』）】》,.;:?!)\]]/;
const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/**
 * Wraps text into at most maxLines lines. Breaks at spaces and around CJK
 * characters (which need no spaces), and only mid-word when a word is wider
 * than the line; the last line is ellipsized.
 */
function wrapLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let rest = Array.from(text.replace(/\s+/g, ' ').trim());
  while (rest.length && lines.length < maxLines) {
    const line = rest.join('');
    if (textWidth(ctx, line) <= maxWidth || lines.length === maxLines - 1) {
      lines.push(ellipsize(ctx, line, maxWidth));
      break;
    }
    // longest prefix that fits
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (textWidth(ctx, rest.slice(0, mid).join('')) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    // never start a line with closing punctuation such as 。or ）
    const breakable = (i: number) =>
      !CLOSING_RE.test(rest[i]) &&
      (rest[i] === ' ' || CJK_RE.test(rest[i]) || CJK_RE.test(rest[i - 1]));
    if (!breakable(cut)) {
      for (let i = cut - 1; i > 0; i--) {
        if (breakable(i)) {
          cut = i;
          break;
        }
      }
    }
    lines.push(rest.slice(0, cut).join('').trimEnd());
    rest = rest.slice(cut);
    while (rest[0] === ' ') rest = rest.slice(1);
  }
  return lines;
}

/** Sets the largest font size in [min, max] at which text fits maxWidth. */
function fitFontSize(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  max: number,
  min: number,
  weight: string
) {
  for (let size = max; size >= min; size--) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (textWidth(ctx, text) <= maxWidth || size === min) return;
  }
}

/** Status-only face for very narrow keys. */
function drawCompact(
  ctx: SKRSContext2D,
  view: SessionView,
  x: number,
  rightX: number
) {
  const width = rightX - x;
  drawMark(ctx, x, 14, view.tone);
  ctx.textBaseline = 'alphabetic';
  if (view.time) {
    ctx.font = SMALL_FONT;
    if (textWidth(ctx, view.time) <= width - 16) {
      ctx.fillStyle = COLORS.label;
      ctx.textAlign = 'right';
      ctx.fillText(view.time, rightX, 18);
    }
  }
  fitFontSize(ctx, view.label, width, 13, 9, 'bold');
  ctx.fillStyle = TONE_COLORS[view.tone];
  ctx.textAlign = 'left';
  ctx.fillText(ellipsize(ctx, view.label, width), x, 36);
  if (view.progress) {
    drawProgress(ctx, view, x, rightX, 45);
  } else if (view.text) {
    ctx.font = SMALL_FONT;
    ctx.fillStyle = COLORS.label;
    ctx.fillText(ellipsize(ctx, view.text, width), x, 52);
  }
}

/**
 * Renders a Session Status key face (60px tall, any width from ~60px):
 * status mark + label, elapsed time and project in the header, the
 * question / current task / title below, and a thin todo progress bar when
 * the session has a todo list.
 */
export async function renderSessionKey(
  width: number,
  view: SessionView,
  options: SessionRenderOptions
): Promise<string> {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle =
    options.bgColor ||
    (view.tone === 'attention' ? ATTENTION_BG : COLORS.background);
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  // tone accent along the left edge
  ctx.fillStyle = TONE_COLORS[view.tone];
  ctx.fillRect(0, 0, 3, KEY_HEIGHT);

  const pad = keyWidth < 140 ? 8 : 11;
  const rightX = keyWidth - pad;
  let x = pad + 1;

  if (options.showClawd) {
    const img = await getClawdImage();
    const clawdHeight = 30;
    const clawdWidth = (img.width / img.height) * clawdHeight;
    if (rightX - (x + clawdWidth + 10) >= MIN_CONTENT_WITH_CLAWD) {
      ctx.globalAlpha = view.tone === 'idle' ? 0.45 : 1;
      ctx.drawImage(
        img,
        x - 1,
        (KEY_HEIGHT - clawdHeight) / 2,
        clawdWidth,
        clawdHeight
      );
      ctx.globalAlpha = 1;
      x += clawdWidth + 10;
    }
  } else if (options.mark) {
    if (rightX - (x + MARK_SIZE + 10) >= MIN_CONTENT_WITH_CLAWD) {
      ctx.globalAlpha = view.tone === 'idle' ? 0.45 : 1;
      drawProviderMark(
        ctx,
        options.mark,
        x,
        (KEY_HEIGHT - MARK_SIZE) / 2,
        MARK_SIZE
      );
      ctx.globalAlpha = 1;
      x += MARK_SIZE + 10;
    }
  }
  const contentWidth = rightX - x;
  const textColor = view.tone === 'idle' ? IDLE_TEXT : COLORS.text;

  if (keyWidth < COMPACT_WIDTH) {
    drawCompact(ctx, view, x, rightX);
    return canvas.toDataURL('image/png');
  }

  const hasProgress = !!view.progress;
  drawHeader(ctx, view, x, rightX, hasProgress ? 18 : 23);

  if (view.text) {
    ctx.font = TEXT_FONT;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      ellipsize(ctx, view.text, contentWidth),
      x,
      hasProgress ? 36 : 43
    );
  }

  if (hasProgress) drawProgress(ctx, view, x, rightX, 45);

  return canvas.toDataURL('image/png');
}

// List geometry: three 19px rows centred on the 60px key
const LIST_ROW_HEIGHT = 19;
const LIST_COLUMN_GAP = 12;
const DOT_RADIUS = 4;
// Title starts this far right of the column edge (dot plus gap)
const LIST_TEXT_INSET = 14;

/**
 * The empty-list message, centred over up to three lines, at the largest
 * size (12px down to 9px) at which no word has to be split.
 */
function drawEmptyList(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  rightX: number
) {
  const width = rightX - x;
  const words = text.split(new RegExp(`\\s+|${CJK_RE.source}`)).filter(Boolean);
  let size = 12;
  for (; size > 9; size--) {
    ctx.font = `${size}px ${FONT}`;
    if (words.every(word => textWidth(ctx, word) <= width)) break;
  }
  ctx.font = `${size}px ${FONT}`;
  const lineHeight = size + 4;
  const lines = wrapLines(ctx, text, width, 3);
  // first baseline, so the block of lines sits centred (cap height ~0.75em)
  const block = (lines.length - 1) * lineHeight + size * 0.75;
  const top = (KEY_HEIGHT - block) / 2 + size * 0.75;
  ctx.fillStyle = COLORS.label;
  ctx.textAlign = 'center';
  lines.forEach((line, i) =>
    ctx.fillText(line, (x + rightX) / 2, top + i * lineHeight)
  );
}

/**
 * Renders the running-sessions list: one row per session, a dot in the
 * status colour and the session title, in as many columns as the key is
 * wide (see listLayout), with a page indicator ("1/3") bottom right when
 * the list has more pages.
 */
export async function renderSessionList(
  width: number,
  list: ListView,
  options: { bgColor?: string }
): Promise<string> {
  const keyWidth = pixelWidth(width);
  const canvas = createCanvas(keyWidth, KEY_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = options.bgColor || COLORS.background;
  ctx.fillRect(0, 0, keyWidth, KEY_HEIGHT);

  const pad = keyWidth < 140 ? 7 : 10;
  const left = pad;
  const rightX = keyWidth - pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (list.rows.length === 0) {
    drawEmptyList(ctx, list.empty, left, rightX);
    return canvas.toDataURL('image/png');
  }

  const rows = LIST_ROWS;
  const columns = Math.max(1, list.columns);
  const columnWidth =
    (rightX - left - (columns - 1) * LIST_COLUMN_GAP) / columns;
  const top = (KEY_HEIGHT - rows * LIST_ROW_HEIGHT) / 2;

  // page indicator, bottom right; the last column's bottom row makes room
  let pageText = '';
  let pageWidth = 0;
  if (list.pages > 1) {
    pageText = `${list.page + 1}/${list.pages}`;
    ctx.font = PAGE_FONT;
    pageWidth = textWidth(ctx, pageText);
  }

  // faint rules between the columns that have rows
  const used = Math.min(columns, Math.ceil(list.rows.length / rows));
  ctx.fillStyle = COLORS.barTrack;
  for (let col = 1; col < used; col++) {
    const x =
      left + col * (columnWidth + LIST_COLUMN_GAP) - LIST_COLUMN_GAP / 2;
    ctx.fillRect(Math.round(x), top + 3, 1, rows * LIST_ROW_HEIGHT - 6);
  }

  ctx.font = LIST_FONT;
  list.rows.forEach((row, i) => {
    const col = Math.floor(i / rows);
    if (col >= columns) return;
    const x = left + col * (columnWidth + LIST_COLUMN_GAP);
    const cy = top + (i % rows) * LIST_ROW_HEIGHT + LIST_ROW_HEIGHT / 2;

    ctx.fillStyle = TONE_COLORS[row.tone];
    ctx.beginPath();
    ctx.arc(x + DOT_RADIUS, cy, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    const textX = x + LIST_TEXT_INSET;
    let maxWidth = x + columnWidth - textX;
    if (pageText && col === columns - 1 && i % rows === rows - 1) {
      maxWidth -= pageWidth + 6;
    }
    const title = ellipsize(ctx, row.title, Math.max(0, maxWidth));
    // a lone ellipsis says nothing: the dot alone is clearer
    if (!title || title === '…') return;
    ctx.fillStyle = COLORS.text;
    ctx.fillText(title, textX, cy + 4);
  });

  if (pageText) {
    ctx.font = PAGE_FONT;
    ctx.fillStyle = COLORS.label;
    ctx.textAlign = 'right';
    const cy = top + (rows - 1) * LIST_ROW_HEIGHT + LIST_ROW_HEIGHT / 2;
    ctx.fillText(pageText, rightX, cy + 3.5);
  }

  return canvas.toDataURL('image/png');
}
