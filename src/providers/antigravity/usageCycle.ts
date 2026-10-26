/**
 * Press rotation for the Antigravity usage key: the plan, the AI-credit
 * overage state when it can be read, then each model-group limit.
 *
 * The limits come from the same RetrieveUserQuotaSummary the meter already
 * fetched. The plan and overage come from GetUserStatus (allowlisted fields
 * only) or from `useG1Credits` in a product settings.json. Nothing else in
 * those payloads is read, and a parse failure is discarded without logging
 * (a JSON.parse error would quote the file).
 */
import fs from 'node:fs';
import path from 'node:path';

import { UsageMetric, UsagePressPage } from '../types';

import { AntigravityProduct, DATA_FOLDERS } from './paths';
import {
  QuotaBucketView,
  QuotaGroupView,
  WINDOW_TEXT,
  cleanText,
} from './usageMetrics';
import { parseJson } from './usageRpc';

/** Weekly before the five-hour limit, matching the settings page. */
const CYCLE_WINDOWS = ['weekly', '5h', 'daily', 'monthly'];

/** Booleans that mean "AI credit overages", and nothing else. */
const OVERAGE_KEYS = [
  'useG1Credits',
  'enableAiCreditOverages',
  'aiCreditOverages',
];

/** Counts of credits still left, when a payload has one. */
const COUNT_KEYS = [
  'availablePromptCredits',
  'availableCredits',
  'promptCreditsRemaining',
];

const PLAN_TITLE = { en: 'Plan', zh: '套餐' };
const CREDITS_TITLE = { en: 'AI credits', zh: 'AI 额度' };

/** settings.json larger than this is left unread. */
const MAX_SETTINGS_BYTES = 64 * 1024;

/** App, then IDE, then CLI: the first file that names the flag wins. */
const CREDIT_PRODUCTS: readonly AntigravityProduct[] = ['app', 'ide', 'cli'];

export type UsageCycleInput = {
  groups: QuotaGroupView[];
  /** Per-model metrics, used only when the summary had no groups. */
  models: UsageMetric[];
  plan: string | null;
  overage: boolean | null;
  creditsLeft: number | null;
};

function windowRank(window: string): number {
  const index = CYCLE_WINDOWS.indexOf(window);
  return index < 0 ? CYCLE_WINDOWS.length : index;
}

function usable(bucket: QuotaBucketView): boolean {
  return !bucket.disabled && bucket.left !== null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A plan name safe to draw. An address is never a plan name. */
export function planLabel(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text || text.includes('@')) return null;
  return text;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  if (['always', 'on', 'true', 'enabled', 'yes'].includes(word)) return true;
  if (['never', 'off', 'false', 'disabled', 'no'].includes(word)) return false;
  return null;
}

function asCount(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return null;
  return Math.round(n);
}

function overageIn(bag: Record<string, unknown>): boolean | null {
  for (const key of OVERAGE_KEYS) {
    const flag = asBool(bag[key]);
    if (flag !== null) return flag;
  }
  return null;
}

function countIn(bag: Record<string, unknown>): number | null {
  for (const key of COUNT_KEYS) {
    const count = asCount(bag[key]);
    if (count !== null) return count;
  }
  const nested = record(bag.promptCredits) ?? record(bag.monthlyPromptCredits);
  if (!nested) return null;
  return asCount(nested.available ?? nested.remaining);
}

/**
 * Plan-adjacent credit fields from a GetUserStatus answer. Only the
 * allowlisted keys are read; email, name and tokens are not.
 */
export function creditFromStatus(json: unknown): {
  overage: boolean | null;
  creditsLeft: number | null;
} {
  const root = record(json) ?? {};
  const status = record(root.userStatus) ?? {};
  const bags = [
    root,
    status,
    record(status.userSettings),
    record(status.settings),
    record(root.settings),
  ].filter((bag): bag is Record<string, unknown> => bag !== null);
  let overage: boolean | null = null;
  let creditsLeft: number | null = null;
  for (const bag of bags) {
    if (overage === null) overage = overageIn(bag);
    if (creditsLeft === null) creditsLeft = countIn(bag);
    if (overage !== null && creditsLeft !== null) break;
  }
  return { overage, creditsLeft };
}

function readSettingsFlag(file: string): boolean | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  if (stat.size <= 0 || stat.size > MAX_SETTINGS_BYTES) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const json = parseJson(text);
  const bag = record(json);
  return bag ? overageIn(bag) : null;
}

/**
 * `useG1Credits` (or the same allowlisted aliases) from a product
 * settings.json under `root`. Missing, huge, linked or unreadable files
 * count as unknown. The rest of the file is never returned.
 */
export function readCreditOverage(root: string): boolean | null {
  if (!root || !path.isAbsolute(root)) return null;
  for (const product of CREDIT_PRODUCTS) {
    const flag = readSettingsFlag(
      path.join(root, DATA_FOLDERS[product], 'settings.json')
    );
    if (flag !== null) return flag;
  }
  return null;
}

function creditsMessage(
  overage: boolean | null,
  creditsLeft: number | null
): { en: string; zh: string } | null {
  const en: string[] = [];
  const zh: string[] = [];
  if (overage === true) {
    en.push('Overages on');
    zh.push('超额已开');
  } else if (overage === false) {
    en.push('Overages off');
    zh.push('超额已关');
  }
  if (creditsLeft !== null) {
    en.push(`${creditsLeft} left`);
    zh.push(`剩余 ${creditsLeft}`);
  }
  if (en.length === 0) return null;
  return { en: en.join(' · '), zh: zh.join(' · ') };
}

/** Display name with a trailing "models" removed. */
function stripModels(name: string): string {
  return name
    .replace(/\bmodels?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name a press page leads with. Known pools use the short form the
 * settings list is read by ("Gemini", "Claude/GPT"). Any other pool keeps
 * its display name, so "Gemini 4 Argon" does not collapse onto "Gemini".
 */
export function cycleGroupName(
  group: Pick<QuotaGroupView, 'key' | 'name' | 'short'>
): { en: string; zh: string } {
  const raw = stripModels(group.name || group.short);
  if (group.key === 'gemini' || /^gemini$/i.test(raw)) {
    return { en: 'Gemini', zh: 'Gemini' };
  }
  if (group.key === '3p' || (/claude/i.test(raw) && /gpt/i.test(raw))) {
    return { en: 'Claude/GPT', zh: 'Claude/GPT' };
  }
  const name = cleanText(raw || group.short, 32) || group.short;
  return { en: name, zh: name };
}

/**
 * Shorter spellings of a versioned pool, longest first. "Gemini 4 Argon"
 * can become "G4 Argon" and then "4 Argon", never plain "Gemini".
 */
export function cycleNameForms(name: string): string[] {
  const text = name.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const forms = [text];
  const versioned = /^(?:gemini)\s+(\d+(?:\.\d+)*)\s+(\S.*)$/i.exec(text);
  if (versioned) {
    forms.push(`G${versioned[1]} ${versioned[2]}`.replace(/\s+/g, ' ').trim());
    forms.push(`${versioned[1]} ${versioned[2]}`.trim());
  }
  if (/^claude\/gpt$/i.test(text)) forms.push('C/GPT');
  // A pool the server named in several words keeps its first word before
  // any ellipsis, so "Imagen Extra Pool" stays "Imagen". A leading
  // "Gemini" is left out: versioned Gemini pools must not collapse onto it.
  const first = text.split(' ')[0] ?? '';
  if (
    first.length >= 3 &&
    first.length < text.length &&
    !/^gemini$/i.test(first)
  ) {
    forms.push(first);
  }
  return [...new Set(forms)];
}

function ellipsizeMeasured(
  text: string,
  maxWidth: number,
  measure: (text: string) => number
): string {
  const ellipsis = '…';
  if (measure(text) <= maxWidth) return text;
  const chars = Array.from(text);
  for (let n = chars.length - 1; n >= 1; n--) {
    const cut = `${chars.slice(0, n).join('').trimEnd()}${ellipsis}`;
    if (measure(cut) <= maxWidth) return cut;
  }
  return measure(ellipsis) <= maxWidth ? ellipsis : '';
}

/**
 * The longest group spelling that fits `maxWidth`. A name that still does
 * not fit is ellipsized from its shortest spelling, so a cut "Gemini 4
 * Argon" stays "4 Ar…" rather than "Gemini…".
 */
export function fitCycleGroupName(
  name: string,
  maxWidth: number,
  measure: (text: string) => number
): string {
  const forms = cycleNameForms(name);
  if (forms.length === 0 || maxWidth <= 0) return '';
  for (const form of forms) {
    if (measure(form) <= maxWidth) return form;
  }
  return ellipsizeMeasured(forms[forms.length - 1], maxWidth, measure);
}

/** Type sizes tried for the group line, largest first. */
export const CYCLE_NAME_SIZES = [15, 13, 12, 11] as const;

/**
 * What the limit page draws for one group. The window chip stays on the
 * name row only when it does not force a shorter spelling; otherwise the
 * tag moves down next to the percent so the group name stays whole.
 */
export function planCycleLabel(
  contentWidth: number,
  groupName: string,
  windowLabel: { word: string; tag: string },
  measure: (text: string, size: number) => number
): { name: string; size: number; chip: string; chipOnName: boolean } {
  const wide = contentWidth >= 120;
  const word = windowLabel.word.trim();
  const tag = windowLabel.tag.trim();
  const chip =
    (wide && word && measure(word, 11) + 10 <= contentWidth * 0.45
      ? word
      : tag || word) || '';
  const chipWidth = chip ? measure(chip, 11) + 10 : 0;
  const beside = contentWidth - chipWidth - 6;
  const withChip =
    chipWidth > 0 && beside >= 36
      ? pickCycleGroupName(groupName, beside, measure)
      : null;
  const alone = pickCycleGroupName(groupName, contentWidth, measure);
  const chipOnName = !!withChip && withChip.text === alone.text;
  const picked = chipOnName && withChip ? withChip : alone;
  return { name: picked.text, size: picked.size, chip, chipOnName };
}

/**
 * Longest spelling that fits, at the largest size that spelling allows.
 * "G4 Argon" at 11px stays ahead of "4 Argon" at 12px, and "C/GPT" is used
 * once "Claude/GPT" no longer fits.
 */
export function pickCycleGroupName(
  name: string,
  maxWidth: number,
  measure: (text: string, size: number) => number,
  sizes: readonly number[] = CYCLE_NAME_SIZES
): { text: string; size: number } {
  const forms = cycleNameForms(name);
  for (const form of forms) {
    for (const size of sizes) {
      if (measure(form, size) <= maxWidth) return { text: form, size };
    }
  }
  const size = sizes.includes(12) ? 12 : sizes[sizes.length - 1] || 12;
  return {
    text: fitCycleGroupName(name, maxWidth, value => measure(value, size)),
    size,
  };
}

function limitPage(
  group: QuotaGroupView,
  bucket: QuotaBucketView
): UsagePressPage {
  const names = cycleGroupName(group);
  const text = WINDOW_TEXT[bucket.window];
  const window = text
    ? { en: text.en, zh: text.zh, tag: text.tag }
    : {
        en: bucket.window || bucket.name,
        zh: bucket.window || bucket.name,
        tag: '',
      };
  const chip = window.tag || window.en;
  return {
    metricId: bucket.metricId,
    shown: 'remaining',
    group: names,
    window,
    label: {
      en: cleanText(`${names.en} ${chip}`.trim(), 48),
      zh: cleanText(`${names.zh} ${text ? text.zh : window.zh}`.trim(), 48),
    },
  };
}

/**
 * Pages a press walks, in settings-page order. Empty when there is nothing
 * to show (the key press then only refreshes).
 */
export function buildUsagePressPages(input: UsageCycleInput): UsagePressPage[] {
  const pages: UsagePressPage[] = [];
  const plan = planLabel(input.plan);
  if (plan) {
    pages.push({
      text: {
        en: { title: PLAN_TITLE.en, message: plan },
        zh: { title: PLAN_TITLE.zh, message: plan },
      },
    });
  }
  const credits = creditsMessage(input.overage, input.creditsLeft);
  if (credits) {
    pages.push({
      text: {
        en: { title: CREDITS_TITLE.en, message: credits.en },
        zh: { title: CREDITS_TITLE.zh, message: credits.zh },
      },
    });
  }
  if (input.groups.length > 0) {
    for (const group of input.groups) {
      const buckets = group.buckets
        .filter(usable)
        .sort((a, b) => windowRank(a.window) - windowRank(b.window));
      for (const bucket of buckets) pages.push(limitPage(group, bucket));
    }
    return pages;
  }
  for (const metric of input.models) {
    if (!metric.id.startsWith('model:')) continue;
    pages.push({
      metricId: metric.id,
      shown: 'remaining',
      group: { en: metric.label, zh: metric.label },
      label: { en: metric.label, zh: metric.label },
    });
  }
  return pages;
}
