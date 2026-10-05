import { existsSync } from 'node:fs';
import path from 'node:path';

import { GlobalFonts } from '@napi-rs/canvas';

// Alias for FlexDesigner's bundled Alibaba PuHuiTi, registered below when found
const BUNDLED_CJK_ALIAS = 'FlexDesigner PuHuiTi';

/**
 * Font stack for all key text. @napi-rs/canvas resolves missing glyphs only
 * through the families listed here (it does not fall back to arbitrary system
 * fonts, and `sans-serif` maps to a Latin-only face), so a model name or
 * message with CJK text renders as tofu boxes unless a CJK-capable family is
 * listed. Latin text still comes from the first families; the rest only fill
 * in missing glyphs. Unknown families are skipped.
 */
export const FONT = [
  'Arial',
  '"Segoe UI"',
  '"Helvetica Neue"',
  // Chinese: macOS, Windows, Linux
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"WenQuanYi Micro Hei"',
  // Japanese
  '"Hiragino Sans"',
  '"Yu Gothic"',
  '"Meiryo"',
  '"Noto Sans CJK JP"',
  // Korean
  '"Apple SD Gothic Neo"',
  '"Malgun Gothic"',
  '"Noto Sans CJK KR"',
  // Broad coverage and symbols
  '"Arial Unicode MS"',
  '"Segoe UI Symbol"',
  `"${BUNDLED_CJK_ALIAS}"`,
  'sans-serif',
].join(', ');

const BUNDLED_CJK_FONT = path.join(
  'app.asar.unpacked',
  'resources',
  'font',
  'PuHuiTi.ttf'
);

/** Candidate FlexDesigner resources directories, most likely first. */
function resourceDirs(): string[] {
  const dirs: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) dirs.push(resourcesPath);
  // Walk up from the runtime binary: <app>/resources on Windows/Linux,
  // FlexDesigner.app/Contents/Resources from the macOS helper app
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 6; i++) {
    dirs.push(path.join(dir, 'resources'), path.join(dir, 'Resources'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Registers the CJK font bundled with FlexDesigner as a last-resort fallback,
 * for machines without any CJK system font (e.g. minimal Linux installs).
 * The font is used in place and never copied.
 */
function registerBundledFallbackFont(): void {
  try {
    for (const dir of resourceDirs()) {
      const file = path.join(dir, BUNDLED_CJK_FONT);
      if (existsSync(file)) {
        GlobalFonts.registerFromPath(file, BUNDLED_CJK_ALIAS);
        return;
      }
    }
  } catch {
    // Missing fallback font only affects non-Latin glyphs
  }
}

registerBundledFallbackFont();
