/**
 * Retry-with-backoff for the statuses Neon documents as always safe to replay. The raw
 * layer does no retries; the ergonomic client opts in via `retries`.
 *
 * The scheduling decisions are pure functions so they can be tested directly, without
 * fake timers or a stopwatch: {@link parseRetryAfterMs} reads the header,
 * {@link backoffMs} picks a delay, and {@link nextRetryDelayMs} decides whether a retry
 * is worth waiting for at all.
 */

import { type Deadline, delay } from "./deadline.js";

export interface RawOutcome {
	error?: unknown;
	response?: Response | undefined;
}

// Only statuses Neon documents as always-safe to retry (no work performed / locked /
// rate limited) — safe for non-idempotent methods too. 5xx other than 503 is
// intentionally excluded, since a mutating request may have partially applied.
const RETRYABLE_STATUS = new Set([423, 429, 503]);

/** Ceiling on generated backoff, and on how long a `Retry-After` is worth honouring. */
export const MAX_RETRY_WAIT_MS = 10_000;

/**
 * `Retry-After` in milliseconds, or `undefined` when absent or unparseable.
 *
 * The header comes in two forms and only one of them is a number. Reading just the
 * numeric form leaves an HTTP-date parsing as `NaN`, which silently falls through to
 * generated backoff — retrying far sooner than the server asked.
 */
export function parseRetryAfterMs(
	header: string | null | undefined,
	now: number,
): number | undefined {
	if (!header) return undefined;
	const trimmed = header.trim();
	if (trimmed === "") return undefined;

	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/** Exponential backoff with full jitter: base 250ms, capped at {@link MAX_RETRY_WAIT_MS}. */
export function backoffMs(attempt: number, random = Math.random): number {
	const ceiling = Math.min(MAX_RETRY_WAIT_MS, 250 * 2 ** attempt);
	return random() * ceiling;
}

/**
 * How long to wait before the next attempt, or `undefined` to stop retrying.
 *
 * `Retry-After` is the server's requested **minimum** delay, so it is never shortened —
 * retrying earlier than instructed is worse than not retrying at all. When honouring it
 * would cost more than {@link MAX_RETRY_WAIT_MS}, or more budget than the call has left,
 * the answer is to stop and let the caller see the real `423`/`429`/`503` rather than to
 * wait for minutes or to report a timeout that hides the status.
 */
export function nextRetryDelayMs(
	attempt: number,
	retryAfterMs: number | undefined,
	remainingMs: number,
	random?: () => number,
): number | undefined {
	const wait = retryAfterMs ?? backoffMs(attempt, random);
	if (wait > MAX_RETRY_WAIT_MS) return undefined;
	if (wait >= remainingMs) return undefined;
	return wait;
}

/**
 * Run `exec` up to `retries + 1` times, retrying only on `423`, `429` and `503`.
 * Non-retryable errors and successes return immediately, as does a cancelled deadline —
 * the caller inspects {@link Deadline.source} to tell cancellation from the last result.
 */
export async function withRetries<T extends RawOutcome>(
	exec: () => Promise<T>,
	retries: number,
	deadline: Deadline,
): Promise<T> {
	let attempt = 0;
	for (;;) {
		const result = await exec();
		const status = result.response?.status;
		const retryable = status !== undefined && RETRYABLE_STATUS.has(status);
		if (!result.error || !retryable || attempt >= retries) return result;
		if (deadline.source()) return result;

		const wait = nextRetryDelayMs(
			attempt,
			parseRetryAfterMs(
				result.response?.headers.get("retry-after"),
				Date.now(),
			),
			deadline.remainingMs(),
		);
		if (wait === undefined) return result;

		if ((await delay(wait, deadline.signal)) === "cancelled") return result;
		attempt += 1;
	}
}
