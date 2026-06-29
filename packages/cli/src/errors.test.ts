import { describe, expect, it } from 'vitest';

import { isNetworkError, matchErrorCode } from './errors.js';

describe('matchErrorCode', () => {
  it('maps known message shapes to their codes', () => {
    expect(matchErrorCode('Unknown command: frobnicate')).toBe(
      'UNKNOWN_COMMAND',
    );
    expect(matchErrorCode('Missing required argument: project-id')).toBe(
      'MISSING_ARGUMENT',
    );
  });

  it('falls back to UNKNOWN_ERROR for unmatched / empty messages', () => {
    expect(matchErrorCode('something else entirely')).toBe('UNKNOWN_ERROR');
    expect(matchErrorCode(undefined)).toBe('UNKNOWN_ERROR');
  });
});

describe('isNetworkError', () => {
  it('detects a Node fetch failure whose cause carries the socket code', () => {
    // What `await fetch(...)` rejects with when the host is unreachable: a bare
    // `TypeError: fetch failed` with the real code one level down on `cause`.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(isNetworkError(err)).toBe(true);
  });

  it('detects a browser-style "Failed to fetch" message', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('detects a "Network Error" message', () => {
    expect(isNetworkError(new Error('Network Error'))).toBe(true);
  });

  it('detects a top-level socket code without a wrapping message', () => {
    expect(
      isNetworkError(
        Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe(true);
  });

  it('does not treat an HTTP API error as a network error', () => {
    // A real 4xx/5xx must still surface to the user, never be swallowed as "offline".
    const apiError = {
      response: { status: 404, data: { message: 'not found' } },
    };
    expect(isNetworkError(apiError)).toBe(false);
    expect(isNetworkError(new Error('Project not found'))).toBe(false);
  });

  it('does not treat an axios timeout (ECONNABORTED) as a network error', () => {
    // Timeouts have their own dedicated message in the CLI; keep them distinct.
    const timeout = Object.assign(new Error('timeout of 60000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    expect(isNetworkError(timeout)).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError('fetch failed')).toBe(false);
  });
});
