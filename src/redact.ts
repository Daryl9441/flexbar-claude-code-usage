/**
 * Keeps credentials out of logs, key faces and settings-UI messages. Any
 * error text that may have passed through the credential or usage code goes
 * through safeErrorMessage before it is logged or shown.
 */

const REDACTED = '[redacted]';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic API keys and OAuth access/refresh tokens
  [/\bsk-ant-[A-Za-z0-9_-]{4,}/g, REDACTED],
  // GitHub tokens
  [/\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]{8,}/g, REDACTED],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Authorization headers
  [/\b(Bearer\s+)[^\s"',;]+/gi, `$1${REDACTED}`],
  // token / secret fields in JSON, form bodies and command lines
  [
    /((?:access|refresh|id)_?token|client_?secret|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
    `$1$2${REDACTED}`,
  ],
];

/** Long opaque strings with mixed case and digits look like credentials. */
const OPAQUE = /[A-Za-z0-9+/_=-]{40,}/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(OPAQUE, run =>
    /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? REDACTED : run
  );
}

/**
 * A short, credential-free description of an error. Child-process errors
 * are reduced to their exit code and first stderr line, because their message
 * repeats the whole command line (the Keychain write passes the token pair as
 * an argument). JSON parse errors quote the input they failed on, so callers
 * must not parse credential data with a bare JSON.parse either.
 */
export function safeErrorMessage(error: unknown, max = 200): string {
  let text: string;
  if (error instanceof Error) {
    const details = error as Error & {
      cmd?: unknown;
      code?: unknown;
      stderr?: unknown;
      cause?: unknown;
    };
    if (details.cmd !== undefined) {
      const stderr = `${details.stderr ?? ''}`.trim().split('\n')[0];
      text = `Command failed (exit ${details.code ?? '?'})${stderr ? `: ${stderr}` : ''}`;
    } else {
      text =
        error.name && error.name !== 'Error'
          ? `${error.name}: ${error.message}`
          : error.message;
      // fetch() reports the actual network failure as the cause
      if (details.cause instanceof Error) text += ` (${details.cause.message})`;
    }
  } else {
    text = `${error}`;
  }
  text = redactSecrets(text);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
