/**
 * The Claude Usage key's 'dual' face (its default): what is LEFT of the
 * 5-hour and weekly limits on one key, drawn by src/usageDualRender.ts. Kept
 * apart from ./usage.ts so tests can load it without the usage endpoint.
 */
import { KeyMetric, Metric } from '../../types';
import { remainingPercent } from '../../usage';
import { renderDualUsageKey } from '../../usageDualRender';
import { UsageFace, UsageFaceRequest } from '../types';

/** The metric setting of the dual face, the key's default. */
export const DUAL_METRIC: KeyMetric = 'dual';

/**
 * The dual face for a key showing DUAL_METRIC, null for any other metric
 * (the single used-% meter). Like the key always did, it has no Clawd and
 * English text only; "No data for these limits" when the last fetch has
 * neither limit.
 */
export function claudeUsageFace(request: UsageFaceRequest): UsageFace | null {
  if (request.metric !== DUAL_METRIC) return null;
  const limit = (id: Metric) =>
    request.metrics.find(metric => metric.id === id) ?? null;
  const session = limit('session');
  const weekly = limit('weekly');
  if (remainingPercent(session) === null && remainingPercent(weekly) === null) {
    return {
      text: { title: 'Claude Code', message: 'No data for these limits' },
    };
  }
  return {
    image: renderDualUsageKey(request.width, session, weekly, {
      showResetTime: request.showResetTime,
      bgColor: request.bgColor,
    }),
  };
}
