import { Metric, UsageData, UsageLimit } from './types';

export type MetricSnapshot = {
  percent: number;
  resetsAt: string | null;
  label: string;
  /** short name for narrow keys ("5h", "7d"), as on the dual key's rows */
  tag?: string;
};

function fromLimit(
  limit: UsageLimit,
  label: string,
  tag?: string
): MetricSnapshot {
  return {
    percent: Math.max(0, Math.min(100, Math.round(limit.percent))),
    resetsAt: limit.resets_at,
    label,
    ...(tag ? { tag } : {}),
  };
}

/**
 * Extracts the requested metric from a usage response. Prefers the rich
 * `limits` array and falls back to the flat `five_hour`/`seven_day` windows
 * for older/newer response shapes.
 */
export function getMetricSnapshot(
  usage: UsageData,
  metric: Metric
): MetricSnapshot | null {
  const limits = usage.limits ?? [];

  if (metric === 'session') {
    const limit = limits.find(l => l.kind === 'session');
    if (limit) return fromLimit(limit, 'Session', '5h');
    if (usage.five_hour) {
      return {
        percent: Math.round(usage.five_hour.utilization),
        resetsAt: usage.five_hour.resets_at,
        label: 'Session',
        tag: '5h',
      };
    }
    return null;
  }

  if (metric === 'weekly') {
    const limit = limits.find(l => l.kind === 'weekly_all');
    if (limit) return fromLimit(limit, 'Weekly', '7d');
    if (usage.seven_day) {
      return {
        percent: Math.round(usage.seven_day.utilization),
        resetsAt: usage.seven_day.resets_at,
        label: 'Weekly',
        tag: '7d',
      };
    }
    return null;
  }

  // weekly_model: the model-scoped weekly bucket (e.g. Opus/Fable)
  const scoped = limits.find(l => l.kind === 'weekly_scoped');
  if (scoped) {
    const model = scoped.scope?.model?.display_name;
    return fromLimit(scoped, model ?? 'Model');
  }
  const window = usage.seven_day_opus ?? usage.seven_day_sonnet;
  if (window) {
    return {
      percent: Math.round(window.utilization),
      resetsAt: window.resets_at,
      label: usage.seven_day_opus ? 'Opus' : 'Sonnet',
    };
  }
  return null;
}

/**
 * What is left of a limit, in percent: 100 minus the used percentage, clamped
 * to 0..100 and rounded. Null for a missing window or a non-numeric value.
 */
export function remainingPercent(
  snapshot: MetricSnapshot | null | undefined
): number | null {
  if (!snapshot) return null;
  const used = Number(snapshot.percent);
  if (!Number.isFinite(used)) return null;
  return Math.round(100 - Math.max(0, Math.min(100, used)));
}

export type DualSnapshot = {
  session: MetricSnapshot | null;
  weekly: MetricSnapshot | null;
};

/** The two limits of the dual key: the 5-hour session and weekly windows. */
export function getDualSnapshot(usage: UsageData): DualSnapshot {
  return {
    session: getMetricSnapshot(usage, 'session'),
    weekly: getMetricSnapshot(usage, 'weekly'),
  };
}

/**
 * Formats the remaining time until a reset as a compact "3h 12m" string
 * ("3小时12分" in Chinese); '' without a time, "now" ("现在") once past.
 */
export function formatTimeUntilReset(
  resetsAt: string | null,
  lang: 'en' | 'zh' = 'en'
): string {
  if (!resetsAt) return '';
  const remaining = new Date(resetsAt).getTime() - Date.now();
  if (Number.isNaN(remaining) || remaining <= 0) {
    return lang === 'zh' ? RESET_NOW_ZH : 'now';
  }

  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (lang === 'zh') {
    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) return `${hours}小时${mins}分`;
    return `${mins}分钟`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** formatTimeUntilReset's Chinese "now" */
export const RESET_NOW_ZH = '现在';

/** "Resets 2h 15m" / "2小时15分钟后重置" from a formatTimeUntilReset text. */
export function resetsText(time: string, lang: 'en' | 'zh' = 'en'): string {
  if (!time) return '';
  if (lang !== 'zh') return `Resets ${time}`;
  return time === RESET_NOW_ZH ? '即将重置' : `${time}后重置`;
}
