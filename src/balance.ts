/**
 * Prepaid API-balance numbers shared by DeepSeek and the Kimi/Moonshot
 * balance metric. Quota meters do not use this: they report a used percent.
 * Nothing here sees an API key.
 */

/** A config or environment value that is one token, or a rejection of one. */
export type SecretResolution = {
  /** The token to send, when it is a single trimmed value. */
  key: string | null;
  /**
   * The user typed something that is not one token (internal whitespace).
   * Callers must not fall through to another source and must not log it.
   */
  rejected: boolean;
};

/**
 * The first non-empty candidate, config before the environment. A value
 * that is not a single token is rejected and later candidates are ignored.
 */
export function resolveSecret(...candidates: unknown[]): SecretResolution {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const key = candidate.trim();
    if (!key) continue;
    if ([...key].some(char => char.charCodeAt(0) <= 32)) {
      return { key: null, rejected: true };
    }
    return { key, rejected: false };
  }
  return { key: null, rejected: false };
}

/** A finite money amount from a JSON number or a decimal string. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/,/g, '');
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

/** Two-decimal money for a key face. CNY and USD use a symbol. */
export function formatMoney(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100;
  const negative = rounded < 0;
  const text = Math.abs(rounded).toFixed(2);
  const code = currency.trim().toUpperCase();
  const body =
    code === 'CNY'
      ? `¥${text}`
      : code === 'USD'
        ? `$${text}`
        : `${text} ${code}`;
  return negative ? `-${body}` : body;
}
