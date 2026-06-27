export type ErrorCode =
  | 'REQUEST_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'AUTH_FAILED'
  | 'AUTH_BROWSER_FAILED'
  | 'API_ERROR'
  | 'UNKNOWN_COMMAND'
  | 'MISSING_ARGUMENT'
  | 'CREDENTIALS_DELETE_FAILED'
  | 'NPX_NOT_FOUND'
  | 'NEON_INIT_FAILED'
  | 'UNKNOWN_ERROR';

const ERROR_MATCHERS = [
  [/^Unknown command: (.*)$/, 'UNKNOWN_COMMAND'],
  [/^Missing required argument: (.*)$/, 'MISSING_ARGUMENT'],
  [/^Failed to open web browser. (.*)$/, 'AUTH_BROWSER_FAILED'],
] as const;

export const matchErrorCode = (message?: string): ErrorCode => {
  if (!message) {
    return 'UNKNOWN_ERROR';
  }
  for (const [matcher, code] of ERROR_MATCHERS) {
    const match = message.match(matcher);
    if (match) {
      return code;
    }
  }
  return 'UNKNOWN_ERROR';
};

/**
 * The single, human-readable line shown when the CLI couldn't reach the Neon API because
 * of a connection-level failure (DNS, refused/reset connection, offline). It replaces the
 * cryptic `fetch failed` / empty axios message a network blip otherwise surfaces (see
 * {@link isNetworkError}), pointing at the two things the user can actually check.
 */
export const NETWORK_ERROR_MESSAGE =
  'Could not reach the Neon API. Please check your internet connection and try again. ' +
  'If your connection is fine and this keeps happening, check https://neonstatus.com for ongoing incidents.';

/**
 * Node-level socket/DNS error codes that mean the request never reached the server — a
 * genuine connectivity problem rather than an API response we should surface. Deliberately
 * excludes `ECONNABORTED` (axios' timeout), which the CLI already reports as a timeout.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
]);

/**
 * Message fragments that mark a connection-level failure across our two transports: the
 * `@neon/sdk` / global `fetch` path (used by `env pull` / `config` / `deploy`, and `link`'s
 * bundled env pull) throws a bare `TypeError: fetch failed` / "Failed to fetch", while the
 * axios `api-client` path throws an `AxiosError` whose message is "Network Error".
 */
const NETWORK_ERROR_MESSAGE_PATTERN =
  /fetch failed|failed to fetch|network error/i;

const readErrorCode = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Whether `err` is a connection-level failure (the network blip the user sees as a cryptic
 * `fetch failed`, or no message at all on the axios path) rather than an actual API response.
 *
 * A Node `fetch` failure is a bare `TypeError: fetch failed` whose underlying `cause` carries
 * the real socket `code` (e.g. `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`), so we walk the
 * `cause` chain checking both the code and the message. This is what lets the CLI swap the
 * confusing default for {@link NETWORK_ERROR_MESSAGE}. It matches only failures where no
 * response was ever received, so it never masks a real 4xx/5xx the user needs to see.
 */
export const isNetworkError = (err: unknown): boolean => {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < 6 && current !== null && current !== undefined;
    depth++
  ) {
    const code = readErrorCode(current);
    if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    if (
      current instanceof Error &&
      NETWORK_ERROR_MESSAGE_PATTERN.test(current.message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};
