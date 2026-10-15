/**
 * Grok Bot's identity on the key faces: a sand-gold accent (apart from
 * Claude orange, Kimi blue, Gemini violet, Antigravity teal and the session
 * status colours) and a generic mark, a rounded head with two eyes, drawn
 * with canvas primitives. Not the product logo, and no logo file.
 */
import type { Brand, KeyMark } from '../types';

export const GROKBOT_ACCENT = '#e2b15a';
const EYE = '#1c1917';

const grokbotMark: KeyMark = {
  draw(ctx, x, y, size) {
    const s = size;
    const at = (fx: number, fy: number): [number, number] => [
      x + fx * s,
      y + fy * s,
    ];
    ctx.save();
    ctx.fillStyle = GROKBOT_ACCENT;
    const left = x + s * 0.14;
    const top = y + s * 0.2;
    const w = s * 0.72;
    const h = s * 0.6;
    const r = s * 0.16;
    ctx.beginPath();
    ctx.moveTo(left + r, top);
    ctx.arcTo(left + w, top, left + w, top + h, r);
    ctx.arcTo(left + w, top + h, left, top + h, r);
    ctx.arcTo(left, top + h, left, top, r);
    ctx.arcTo(left, top, left + w, top, r);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = EYE;
    const [lx, ly] = at(0.38, 0.48);
    const [rx, ry] = at(0.62, 0.48);
    const eye = s * 0.07;
    ctx.beginPath();
    ctx.arc(lx, ly, eye, 0, Math.PI * 2);
    ctx.arc(rx, ry, eye, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },
};

export const GROKBOT_BRAND: Brand = {
  name: 'Grok Bot',
  productName: 'Grok Bot',
  accent: GROKBOT_ACCENT,
  mark: grokbotMark,
};
