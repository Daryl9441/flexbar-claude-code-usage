/**
 * Gemini usage key: turns Code Assist quota buckets (one per model, each
 * with the fraction left and a daily reset time) into meter metrics.
 *
 * Metric ids (the key's `metric` setting):
 * - `lowest` (default): the model with the least quota left; its chip
 *   names that model ("2.5 Pro")
 * - `pro` / `flash`: the most used model of that family
 * - `pooled`: the CLI's Auto mode pool, Pro and Flash together
 *   (Σ remaining / Σ limit, limit = remainingAmount / remainingFraction)
 * - `model:<modelId>`: one model as the server names it
 */
import { UsageMetric } from '../types';

import { QuotaBucket } from './usageApi';

export type ModelFamily = 'pro' | 'flash' | 'flash-lite' | 'other';

type Bucket = {
  modelId: string;
  tokenType: string | null;
  fraction: number;
  remaining: number | null;
  resetsAt: string | null;
  family: ModelFamily;
  label: string;
  percent: number;
};

// the model pairs the CLI's Auto mode pools (getPooledQuota)
const PREVIEW_POOL = ['gemini-3-pro-preview', 'gemini-3-flash-preview'];
const DEFAULT_POOL = ['gemini-2.5-pro', 'gemini-2.5-flash'];

const FAMILY_ORDER: ModelFamily[] = ['pro', 'flash', 'flash-lite', 'other'];

const WORDS: Record<string, string> = {
  pro: 'Pro',
  flash: 'Flash',
  lite: 'Lite',
  customtools: 'Tools',
};

export function modelFamily(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  if (/flash[-_]?lite/.test(id)) return 'flash-lite';
  if (id.includes('flash')) return 'flash';
  if (id.includes('pro')) return 'pro';
  return 'other';
}

/**
 * A short chip label for a model id: "gemini-2.5-pro" → "2.5 Pro",
 * "gemini-3-flash-preview" → "3 Flash".
 */
export function modelLabel(modelId: string): string {
  const words = modelId
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/^gemini-/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .filter(word => !['preview', 'latest', 'exp'].includes(word))
    .filter(word => !/^\d{2,4}$/.test(word) || /\./.test(word));
  const label = words
    .map(word => WORDS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return label || modelId;
}

function parseBucket(raw: QuotaBucket): Bucket | null {
  if (!raw || typeof raw !== 'object') return null;
  const modelId =
    typeof raw.modelId === 'string' ? raw.modelId.trim().slice(0, 80) : '';
  const fraction = Number(raw.remainingFraction);
  if (!modelId || raw.remainingFraction === null || !Number.isFinite(fraction))
    return null;
  const left = Math.max(0, Math.min(1, fraction));
  const amount =
    typeof raw.remainingAmount === 'string' ||
    typeof raw.remainingAmount === 'number'
      ? Number.parseInt(`${raw.remainingAmount}`, 10)
      : NaN;
  const reset =
    typeof raw.resetTime === 'string' &&
    !Number.isNaN(Date.parse(raw.resetTime))
      ? raw.resetTime
      : null;
  return {
    modelId,
    tokenType:
      typeof raw.tokenType === 'string' && raw.tokenType
        ? raw.tokenType.slice(0, 40)
        : null,
    fraction: left,
    remaining: Number.isFinite(amount) && amount >= 0 ? amount : null,
    resetsAt: reset,
    family: modelFamily(modelId),
    label: modelLabel(modelId),
    percent: Math.max(0, Math.min(100, Math.round((1 - left) * 100))),
  };
}

/** Pro first, then Flash, Flash-Lite, others; newer versions first. */
function compareBuckets(a: Bucket, b: Bucket): number {
  const family =
    FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family);
  if (family !== 0) return family;
  return b.modelId.localeCompare(a.modelId, undefined, { numeric: true });
}

/** The most used bucket (least left); ties keep the sort order. */
function mostUsed(buckets: Bucket[]): Bucket | null {
  let best: Bucket | null = null;
  for (const bucket of buckets) {
    if (!best || bucket.fraction < best.fraction) best = bucket;
  }
  return best;
}

function latestReset(buckets: Bucket[]): string | null {
  let latest: string | null = null;
  for (const bucket of buckets) {
    if (
      bucket.resetsAt &&
      (!latest || Date.parse(bucket.resetsAt) > Date.parse(latest))
    ) {
      latest = bucket.resetsAt;
    }
  }
  return latest;
}

/**
 * The Auto-mode pool, or null when no request limit is known. `limits`
 * remembers each model's limit across polls, for a bucket that is used up
 * (remainingFraction 0 hides its limit), like the CLI does.
 */
function pooled(
  buckets: Bucket[],
  limits: Map<string, number>
): UsageMetric | null {
  // the CLI pools the preview pair in preview mode, else the 2.5 pair; the
  // user's mode is not known here, so the first pair with amounts is used
  for (const pair of [PREVIEW_POOL, DEFAULT_POOL]) {
    let remaining = 0;
    let limit = 0;
    const used: Bucket[] = [];
    for (const id of pair) {
      const bucket = buckets.find(
        b => b.modelId === id && b.remaining !== null
      );
      if (!bucket || bucket.remaining === null) continue;
      const known =
        bucket.fraction > 0
          ? Math.round(bucket.remaining / bucket.fraction)
          : (limits.get(id) ?? 0);
      if (!Number.isFinite(known) || known <= 0) continue;
      limits.set(id, known);
      remaining += Math.min(bucket.remaining, known);
      limit += known;
      used.push(bucket);
    }
    if (limit > 0) {
      return {
        id: 'pooled',
        label: 'Auto',
        percent: Math.max(
          0,
          Math.min(100, Math.round((1 - remaining / limit) * 100))
        ),
        resetsAt: latestReset(used),
      };
    }
  }
  return null;
}

/**
 * Every metric the buckets support, the default (`lowest`) first. Empty
 * when no bucket is usable.
 */
export function bucketsToMetrics(
  raw: unknown,
  limits: Map<string, number> = new Map()
): UsageMetric[] {
  const buckets = (Array.isArray(raw) ? raw : [])
    .map(b => parseBucket(b as QuotaBucket))
    .filter((b): b is Bucket => b !== null)
    .sort(compareBuckets);
  if (buckets.length === 0) return [];

  const metric = (id: string, label: string, b: Bucket): UsageMetric => ({
    id,
    label,
    percent: b.percent,
    resetsAt: b.resetsAt,
  });
  const metrics: UsageMetric[] = [];
  const lowest = mostUsed(buckets);
  if (lowest) metrics.push(metric('lowest', lowest.label, lowest));
  const pro = mostUsed(buckets.filter(b => b.family === 'pro'));
  if (pro) metrics.push(metric('pro', 'Pro', pro));
  const flash = mostUsed(buckets.filter(b => b.family === 'flash'));
  if (flash) metrics.push(metric('flash', 'Flash', flash));
  const pool = pooled(buckets, limits);
  if (pool) metrics.push(pool);

  const seen = new Set<string>();
  for (const bucket of buckets) {
    let id = `model:${bucket.modelId}`;
    if (seen.has(id) && bucket.tokenType) id += `:${bucket.tokenType}`;
    if (seen.has(id)) continue;
    seen.add(id);
    metrics.push(metric(id, bucket.label, bucket));
  }
  return metrics;
}
