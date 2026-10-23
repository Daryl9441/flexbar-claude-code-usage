/**
 * DeepSeek's balance face. The selected row's amount is the reading; the
 * total row also names granted and topped-up balances when they fit.
 */
import { formatMoney } from '../../balance';
import { renderBalanceKey } from '../../balanceRender';
import { Lang, UsageFace, UsageFaceRequest, UsageMetric } from '../types';

import { DEEPSEEK_ACCENT, DEEPSEEK_BRAND } from './brand';

const CAPTION: Record<'total' | 'granted' | 'topped', Record<Lang, string>> = {
  total: { en: 'Balance', zh: '余额' },
  granted: { en: 'Granted', zh: '赠金' },
  topped: { en: 'Top-up', zh: '充值' },
};

function kindOf(id: string): 'total' | 'granted' | 'topped' {
  if (id.endsWith('_granted')) return 'granted';
  if (id.endsWith('_topped_up')) return 'topped';
  return 'total';
}

function sibling(
  metrics: UsageMetric[],
  currency: string,
  suffix: '' | '_granted' | '_topped_up'
): UsageMetric | undefined {
  const id = `${currency.toLowerCase()}${suffix}`;
  return metrics.find(metric => metric.id === id);
}

function breakdown(
  metrics: UsageMetric[],
  currency: string,
  lang: Lang
): string {
  const granted = sibling(metrics, currency, '_granted');
  const topped = sibling(metrics, currency, '_topped_up');
  const parts: string[] = [];
  if (granted && typeof granted.amount === 'number') {
    const label = lang === 'zh' ? '赠' : 'Grant';
    parts.push(`${label} ${formatMoney(granted.amount, currency)}`);
  }
  if (topped && typeof topped.amount === 'number') {
    const label = lang === 'zh' ? '充' : 'Top-up';
    parts.push(`${label} ${formatMoney(topped.amount, currency)}`);
  }
  return parts.join(' · ');
}

export function deepseekUsageFace(request: UsageFaceRequest): UsageFace | null {
  const metric = request.metrics.find(item => item.id === request.metric);
  if (!metric || typeof metric.amount !== 'number' || !metric.currency) {
    return null;
  }
  const lang = request.lang;
  const kind = kindOf(metric.id);
  const blocked = metric.available === false;
  const detail = blocked
    ? lang === 'zh'
      ? '余额不足，无法调用'
      : 'Too low for API calls'
    : kind === 'total'
      ? breakdown(request.metrics, metric.currency, lang)
      : '';
  const mark = DEEPSEEK_BRAND.mark === 'clawd' ? null : DEEPSEEK_BRAND.mark;
  return {
    image: renderBalanceKey(request.width, {
      product: 'DeepSeek',
      caption: CAPTION[kind][lang],
      amountText: formatMoney(metric.amount, metric.currency),
      detail,
      available: !blocked,
      accent: DEEPSEEK_ACCENT,
      showMark: request.data.showMark !== false,
      mark,
      bgColor: request.bgColor,
    }),
  };
}
