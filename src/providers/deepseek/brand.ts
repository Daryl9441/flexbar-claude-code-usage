/**
 * DeepSeek's identity on the key faces: a blue accent apart from Kimi's,
 * and a generic diamond mark drawn with canvas primitives. Not the product
 * logo, and no logo file.
 */
import type { Brand, KeyMark } from '../types';

export const DEEPSEEK_ACCENT = '#4d6bfe';
const GLYPH = '#fafaf9';

const deepseekMark: KeyMark = {
  draw(ctx, x, y, size) {
    const at = (fx: number, fy: number): [number, number] => [
      x + fx * size,
      y + fy * size,
    ];
    ctx.save();
    ctx.fillStyle = DEEPSEEK_ACCENT;
    ctx.beginPath();
    ctx.moveTo(...at(0.5, 0.1));
    ctx.lineTo(...at(0.9, 0.42));
    ctx.lineTo(...at(0.5, 0.9));
    ctx.lineTo(...at(0.1, 0.42));
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = GLYPH;
    ctx.beginPath();
    ctx.moveTo(...at(0.5, 0.28));
    ctx.lineTo(...at(0.7, 0.44));
    ctx.lineTo(...at(0.5, 0.72));
    ctx.lineTo(...at(0.3, 0.44));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
};

export const DEEPSEEK_BRAND: Brand = {
  name: 'DeepSeek',
  productName: 'DeepSeek',
  accent: DEEPSEEK_ACCENT,
  mark: deepseekMark,
};
