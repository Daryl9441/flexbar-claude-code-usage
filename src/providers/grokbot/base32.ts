/**
 * RFC 4648 base32, lowercase and unpadded: the names of Grok Bot's
 * sand-client-persistence slice files. Encode exists so tests can build
 * those names the same way the app does.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function encodeBase32(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Null when `name` is not unpadded lowercase base32. */
export function decodeBase32(name: string): string | null {
  if (!name || /[^a-z2-7]/.test(name)) return null;
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const char of name) {
    const index = ALPHABET.indexOf(char);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
