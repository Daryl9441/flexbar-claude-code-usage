/**
 * Cursor's identity on the key faces: an indigo accent (apart from Claude
 * orange, Kimi blue, Gemini violet, Antigravity teal, Grok Bot gold and
 * DeepSeek blue) and a generic pointer drawn with canvas primitives. Not
 * the product logo, and no logo file.
 */
import type { Brand, KeyMark } from '../types';

export const CURSOR_ACCENT = '#5c6bc0';

const cursorMark: KeyMark = {
  draw(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = CURSOR_ACCENT;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.22, y + size * 0.16);
    ctx.lineTo(x + size * 0.22, y + size * 0.78);
    ctx.lineTo(x + size * 0.4, y + size * 0.62);
    ctx.lineTo(x + size * 0.56, y + size * 0.84);
    ctx.lineTo(x + size * 0.68, y + size * 0.76);
    ctx.lineTo(x + size * 0.52, y + size * 0.54);
    ctx.lineTo(x + size * 0.78, y + size * 0.54);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
};

export const CURSOR_BRAND: Brand = {
  name: 'Cursor',
  productName: 'Cursor',
  accent: CURSOR_ACCENT,
  mark: cursorMark,
};
