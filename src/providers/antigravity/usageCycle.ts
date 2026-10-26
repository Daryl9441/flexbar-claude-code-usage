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
import { QuotaBucketView, QuotaGroupView, cleanText } from './usageMetrics';
import { parseJson } from './usageRpc';

/** Weekly before the five-hour limit, matching the settings page. */
const CYCLE_WINDOWS = ['weekly', '5h', 'daily', 'monthly'];

const WINDOW_PHRASE: Readonly<Record<string, { en: string; zh: string }>> = {
  '5h': { en: 'Five Hour', zh: '5 小时' },
  daily: { en: 'Daily', zh: '每日' },
  weekly: { en: 'Weekly', zh: '每周' },
  monthly: { en: 'Monthly', zh: '每月' },
};

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

function limitPage(
  group: QuotaGroupView,
  bucket: QuotaBucketView
): UsagePressPage {
  const name = group.name || group.short;
  const phrase = WINDOW_PHRASE[bucket.window];
  const en = phrase
    ? `${name} ${phrase.en}`
    : `${name} ${bucket.name || bucket.window}`.trim();
  const zh = phrase ? `${name} ${phrase.zh}` : en;
  return {
    metricId: bucket.metricId,
    shown: 'remaining',
    label: { en: cleanText(en, 48), zh: cleanText(zh, 48) },
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
      label: { en: metric.label, zh: metric.label },
    });
  }
  return pages;
}
