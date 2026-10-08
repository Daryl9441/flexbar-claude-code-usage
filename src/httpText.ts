/** Small helpers for reading HTTP responses without trusting their size. */

/** Up to `max` bytes of a response body as text ('' when it cannot be read). */
export async function readTextPrefix(
  response: Response,
  max: number
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return '';
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}
