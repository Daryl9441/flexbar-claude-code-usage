/**
 * Antigravity usage key: turns the language server's quota summary
 * (`RetrieveUserQuotaSummary`: groups of models, each with buckets such as a
 * 5-hour and a weekly limit, as the fraction left and a reset time) into
 * meter metrics. Nothing is hard-wired to today's two groups: every bucket
 * the server reports becomes a metric; the known ids only get nicer names.
 *
 * Metric ids (the key's `metric` setting):
 * - `lowest` (default): the bucket with the least left, over every group;
 *   its chip names that bucket ("Gemini 5h")
 * - `group:<key>`: the bucket with the least left in one group
 *   (`group:gemini`, `group:3p`)
 * - `gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly`: today's buckets by
 *   their server ids; `bucket:<id>` for any other bucket id
 * - `<key>-dual` (`gemini-dual`, `3p-dual`): a view, not a metric: what is
 *   left of one group's 5-hour and weekly limits on one key (./usageFace.ts)
 * - `model:<name>`: per-model quota from GetUserStatus, only used when the
 *   server reports no groups
 *
 * `percent` is the share USED (0–100), like every other meter. A bucket
 * whose reset time has passed is shown as reset (nothing used) until the
 * server reports again.
 *
 * Narrow keys show a bucket's short tag instead of its label; the tag keeps
 * the group's initial ("G 5h", "C 7d"), since `lowest` can move between
 * groups (the bare window when two groups share an initial).
 */
import { Lang, UsageMetric } from '../types';

/** Bucket ids the server uses today; others become `bucket:<id>`. */
const KNOWN_BUCKETS = new Set([
  'gemini-5h',
  'gemini-weekly',
  '3p-5h',
  '3p-weekly',
]);

/** Short chip names of the known groups (the 3P group is Claude + GPT-OSS). */
const KNOWN_GROUPS: Readonly<Record<string, string>> = {
  gemini: 'Gemini',
  '3p': 'Claude',
};

/** Window words on chips, and the short tags for narrow keys. */
export const WINDOW_TEXT: Readonly<
  Record<string, { en: string; zh: string; tag: string }>
> = {
  '5h': { en: '5h', zh: '5 小时', tag: '5h' },
  daily: { en: 'Daily', zh: '每日', tag: '1d' },
  weekly: { en: 'Weekly', zh: '每周', tag: '7d' },
  monthly: { en: 'Monthly', zh: '每月', tag: '30d' },
};

/** Order of the windows within a group. */
const WINDOW_ORDER = ['5h', 'daily', 'weekly', 'monthly'];

export type QuotaBucketView = {
  /** Server bucket id (sanitised) */
  bucketId: string;
  metricId: string;
  /** Server display name, e.g. "Five Hour Limit Remaining" */
  name: string;
  /** '5h' | 'daily' | 'weekly' | 'monthly' | other short word | '' */
  window: string;
  /** Chip label, e.g. "Gemini 5h" */
  label: string;
  tag?: string;
  /** Percent left (0–100), null when the server gives no fraction */
  left: number | null;
  /** Requests left, when the server counts them instead of a fraction */
  amount: number | null;
  resetsAt: string | null;
  disabled: boolean;
  /** The reset time had passed: the server's answer is older than it */
  stale: boolean;
};

export type QuotaGroupView = {
  /** Stable key from the bucket ids, e.g. 'gemini', '3p' */
  key: string;
  /** Short chip name, e.g. "Gemini", "Claude" */
  short: string;
  /** Server display name, e.g. "Gemini Models" */
  name: string;
  /** Server description (the models in the group) */
  description: string;
  buckets: QuotaBucketView[];
};

/** A dual view: one group's 5-hour and weekly metrics. */
export type DualView = {
  id: string;
  short: string;
  group: string;
  fiveHour: string;
  weekly: string;
};

/** Server text, cleaned of control characters and cut to `max`. */
export function cleanText(value: unknown, max = 60): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const squeezed = text.replace(/\s+/g, ' ').trim();
  return squeezed.length > max ? `${squeezed.slice(0, max - 1)}…` : squeezed;
}

function cleanId(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, '')
        .slice(0, 64)
    : '';
}

/** The window of a bucket: its `window` field, else its id's last part. */
export function windowOf(raw: unknown, bucketId: string): string {
  const word = (value: string) => {
    const w = value.toLowerCase().replace(/[\s_-]+/g, '');
    if (['5h', '5hour', '5hours', 'fivehour', 'fivehours'].includes(w))
      return '5h';
    if (['daily', 'day', '1d', '24h'].includes(w)) return 'daily';
    if (['weekly', 'week', '7d'].includes(w)) return 'weekly';
    if (['monthly', 'month', '30d'].includes(w)) return 'monthly';
    return /^[a-z0-9]{1,12}$/.test(w) ? w : '';
  };
  const own = typeof raw === 'string' ? word(raw) : '';
  if (own) return own;
  const tail = bucketId.includes('-') ? bucketId.split('-').pop() : '';
  const fromId = tail ? word(tail) : '';
  return WINDOW_TEXT[fromId] ? fromId : '';
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** A group's key: the shared prefix of its bucket ids, else its name. */
function groupKey(name: string, bucketIds: string[], index: number): string {
  const prefixes = new Set(
    bucketIds
      .filter(id => id.includes('-'))
      .map(id => id.slice(0, id.lastIndexOf('-')).toLowerCase())
  );
  if (prefixes.size === 1) {
    const [prefix] = prefixes;
    if (/^[a-z0-9._-]{1,32}$/.test(prefix)) return prefix;
  }
  return slug(name) || `group${index + 1}`;
}

/** Short chip name of a group: known names, else its first word. */
function groupShort(key: string, name: string): string {
  if (KNOWN_GROUPS[key]) return KNOWN_GROUPS[key];
  const first = name
    .replace(/\bmodels?\b/gi, ' ')
    .trim()
    .split(/\s+/)[0];
  return cleanText(first || key, 14) || key;
}

function bucketLabel(short: string, window: string, name: string): string {
  const text = WINDOW_TEXT[window];
  if (text) return `${short} ${text.en}`;
  if (window) return `${short} ${window}`;
  return name ? `${short} ${cleanText(name, 20)}` : short;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function parseBucket(
  raw: unknown,
  short: string,
  key: string,
  index: number,
  now: number
): QuotaBucketView | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const name = cleanText(b.displayName);
  let bucketId = cleanId(b.bucketId);
  const window = windowOf(b.window, bucketId);
  if (!bucketId && !name) return null; // the app skips these too
  if (!bucketId) bucketId = `${key}-${window || `b${index + 1}`}`;

  const fraction =
    typeof b.remainingFraction === 'number' ||
    typeof b.remainingFraction === 'string'
      ? Number(b.remainingFraction)
      : NaN;
  const amountRaw =
    typeof b.remainingAmount === 'number' ||
    typeof b.remainingAmount === 'string'
      ? Number.parseInt(`${b.remainingAmount}`, 10)
      : NaN;
  const resetAt = timeOf(b.resetTime);
  const stale = resetAt !== null && resetAt <= now;
  let left: number | null = null;
  let resetsAt: string | null = null;
  if (Number.isFinite(fraction)) {
    const f = stale ? 1 : Math.max(0, Math.min(1, fraction));
    left = Math.round(f * 100);
    // a bucket with nothing used rolls: its reset is just now + window
    if (f < 1 && resetAt !== null) resetsAt = new Date(resetAt).toISOString();
  }
  const text = WINDOW_TEXT[window];
  return {
    bucketId,
    metricId: KNOWN_BUCKETS.has(bucketId) ? bucketId : `bucket:${bucketId}`,
    name,
    window,
    label: bucketLabel(short, window, name),
    ...(text ? { tag: text.tag } : {}),
    left,
    amount: Number.isFinite(amountRaw) && amountRaw >= 0 ? amountRaw : null,
    resetsAt,
    disabled: b.disabled === true,
    stale,
  };
}

function windowRank(window: string): number {
  const i = WINDOW_ORDER.indexOf(window);
  return i < 0 ? WINDOW_ORDER.length : i;
}

/**
 * The groups of a RetrieveUserQuotaSummary answer (`{response: {groups,
 * buckets}}`), buckets ordered 5h, daily, weekly, monthly. Buckets outside
 * any group form one more group. Malformed parts are skipped.
 */
export function parseQuotaSummary(
  json: unknown,
  now: number
): QuotaGroupView[] {
  const response =
    json && typeof json === 'object'
      ? ((json as { response?: unknown }).response ?? null)
      : null;
  if (!response || typeof response !== 'object') return [];
  const r = response as { groups?: unknown; buckets?: unknown };
  const rawGroups: Record<string, unknown>[] = (
    Array.isArray(r.groups) ? r.groups : []
  ).filter((g): g is Record<string, unknown> => !!g && typeof g === 'object');
  if (Array.isArray(r.buckets) && r.buckets.length > 0) {
    rawGroups.push({ displayName: '', buckets: r.buckets });
  }

  const groups: QuotaGroupView[] = [];
  const keys = new Set<string>();
  rawGroups.forEach((raw, index) => {
    const name = cleanText(raw.displayName);
    const rawBuckets = Array.isArray(raw.buckets) ? raw.buckets : [];
    const ids = rawBuckets.map(b =>
      cleanId((b as { bucketId?: unknown } | null)?.bucketId)
    );
    let key = groupKey(name, ids.filter(Boolean), index);
    while (keys.has(key)) key = `${key}-${index + 1}`;
    const short = groupShort(key, name);
    const buckets = rawBuckets
      .map((b, i) => parseBucket(b, short, key, i, now))
      .filter((b): b is QuotaBucketView => b !== null)
      .sort((a, b) => windowRank(a.window) - windowRank(b.window));
    // the same id twice: keep the first
    const seen = new Set<string>();
    const unique = buckets.filter(b => {
      if (seen.has(b.metricId)) return false;
      seen.add(b.metricId);
      return true;
    });
    if (unique.length === 0 && !name) return;
    keys.add(key);
    groups.push({
      key,
      short,
      name: name || short,
      description: cleanText(raw.description, 200),
      buckets: unique,
    });
  });
  tagGroups(groups);
  return groups;
}

/** A group's initial for the narrow tags: its first letter or digit. */
function initialOf(short: string): string {
  const first = Array.from(short.trim())[0] ?? '';
  return /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : '';
}

/** Puts each group's initial in its buckets' tags, when it tells them apart. */
function tagGroups(groups: QuotaGroupView[]): void {
  const initials = groups.map(group => initialOf(group.short));
  groups.forEach((group, index) => {
    const initial = initials[index];
    if (
      !initial ||
      initials.indexOf(initial) !== initials.lastIndexOf(initial)
    ) {
      return;
    }
    for (const bucket of group.buckets) {
      if (bucket.tag) bucket.tag = `${initial} ${bucket.tag}`;
    }
  });
}

function usable(bucket: QuotaBucketView): boolean {
  return !bucket.disabled && bucket.left !== null;
}

/** The bucket with the least left; ties keep the earlier one. */
function leastLeft(buckets: QuotaBucketView[]): QuotaBucketView | null {
  let best: QuotaBucketView | null = null;
  for (const bucket of buckets) {
    if (!usable(bucket)) continue;
    if (!best || (bucket.left ?? 100) < (best.left ?? 100)) best = bucket;
  }
  return best;
}

function toMetric(id: string, bucket: QuotaBucketView): UsageMetric {
  return {
    id,
    label: bucket.label,
    percent: 100 - (bucket.left ?? 100),
    resetsAt: bucket.resetsAt,
    ...(bucket.tag ? { tag: bucket.tag } : {}),
  };
}

/**
 * Every metric of the groups, `lowest` first, then per group its lowest
 * (when it has two or more limits) and each limit. Empty when no bucket
 * has a fraction.
 */
export function groupMetrics(groups: QuotaGroupView[]): UsageMetric[] {
  const all = groups.flatMap(g => g.buckets);
  const lowest = leastLeft(all);
  if (!lowest) return [];
  const metrics: UsageMetric[] = [toMetric('lowest', lowest)];
  for (const group of groups) {
    const live = group.buckets.filter(usable);
    if (live.length >= 2) {
      const least = leastLeft(live);
      if (least) metrics.push(toMetric(`group:${group.key}`, least));
    }
    for (const bucket of live) metrics.push(toMetric(bucket.metricId, bucket));
  }
  return metrics;
}

/** The dual views the groups allow: a 5-hour and a weekly limit each. */
export function dualViews(groups: QuotaGroupView[]): DualView[] {
  const views: DualView[] = [];
  for (const group of groups) {
    const fiveHour = group.buckets.find(b => usable(b) && b.window === '5h');
    const weekly = group.buckets.find(b => usable(b) && b.window === 'weekly');
    if (!fiveHour || !weekly) continue;
    views.push({
      id: `${group.key}-dual`,
      short: group.short,
      group: group.name,
      fiveHour: fiveHour.metricId,
      weekly: weekly.metricId,
    });
  }
  return views;
}

/** True when a bucket's reset time had passed (ask the server afresh). */
export function anyStale(groups: QuotaGroupView[]): boolean {
  return groups.some(g => g.buckets.some(b => b.stale));
}

/**
 * Per-model quota from GetUserStatus (`userStatus.cascadeModelConfigData.
 * clientModelConfigs[].quotaInfo`), one metric per model family ("Gemini
 * 3 Pro (High)" and "(Low)" share one), `lowest` first. Only used when the
 * quota summary has no groups. Nothing but labels and quota is read.
 */
export function modelMetrics(json: unknown, now: number): UsageMetric[] {
  const status =
    json && typeof json === 'object'
      ? (json as { userStatus?: unknown }).userStatus
      : null;
  const data =
    status && typeof status === 'object'
      ? (status as { cascadeModelConfigData?: unknown }).cascadeModelConfigData
      : null;
  const configs =
    data && typeof data === 'object'
      ? (data as { clientModelConfigs?: unknown }).clientModelConfigs
      : null;
  if (!Array.isArray(configs)) return [];
  const byName = new Map<string, UsageMetric & { left: number }>();
  for (const raw of configs) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (c.disabled === true) continue;
    const quota = c.quotaInfo as Record<string, unknown> | undefined;
    if (!quota || typeof quota !== 'object') continue;
    const name = cleanText(c.label, 40)
      .replace(/\s*\((?:low|medium|high|thinking)\)$/i, '')
      .trim();
    if (!name) continue;
    const resetAt = timeOf(quota.resetTime);
    // a plain proto3 float: 0 (used up) is left out of the JSON
    let fraction =
      quota.remainingFraction === undefined
        ? resetAt !== null
          ? 0
          : NaN
        : Number(quota.remainingFraction);
    if (!Number.isFinite(fraction)) continue;
    const stale = resetAt !== null && resetAt <= now;
    fraction = stale ? 1 : Math.max(0, Math.min(1, fraction));
    const left = Math.round(fraction * 100);
    const known = byName.get(name);
    if (known && known.left <= left) continue;
    byName.set(name, {
      id: `model:${name}`,
      label: name,
      percent: 100 - left,
      resetsAt:
        fraction < 1 && resetAt !== null
          ? new Date(resetAt).toISOString()
          : null,
      left,
    });
  }
  const models = [...byName.values()];
  if (models.length === 0) return [];
  let lowest = models[0];
  for (const m of models) if (m.left < lowest.left) lowest = m;
  const strip = (m: UsageMetric & { left: number }): UsageMetric => ({
    id: m.id,
    label: m.label,
    percent: m.percent,
    resetsAt: m.resetsAt,
  });
  return [{ ...strip(lowest), id: 'lowest' }, ...models.map(strip)];
}

/** A metric's chip text in a key language: window words in Chinese. */
export function localizeLabel(label: string, lang: Lang): string {
  if (lang !== 'zh') return label;
  for (const text of Object.values(WINDOW_TEXT)) {
    if (label.endsWith(` ${text.en}`)) {
      return `${label.slice(0, -text.en.length)}${text.zh}`;
    }
  }
  return label;
}
