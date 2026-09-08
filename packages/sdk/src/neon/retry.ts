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
import { NeonError } from "./errors.js";

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

const DEFAULT_RETRIES = 2;

/**
 * Client-wide `retries`. `NaN` and `Infinity` make `attempt >= retries` always false,
 * so a 429 would poll forever; reject them here the way `requestTimeoutMs` is rejected.
 */
export function resolveRetries(retries: number | undefined): number {
	if (retries === undefined) return DEFAULT_RETRIES;
	if (
		typeof retries !== "number" ||
		!Number.isInteger(retries) ||
		retries < 0
	) {
		throw new NeonError(
			`retries must be a non-negative integer; received ${String(retries)}.`,
			"client",
		);
	}
	return retries;
}

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

	// RFC 9110 delta-seconds is a non-negative integer.
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds * 1000)
			? seconds * 1000
			: Number.POSITIVE_INFINITY;
	}

	// A malformed number must be rejected here rather than fall through to the date
	// parser. `Date.parse` is permissive enough to read "-1", "1.5" and "+5" as dates in
	// 2001 — all in the past, so the delay clamped to 0 and a malformed header became an
	// immediate retry, which is the opposite of what it asks for.
	if (Number.isFinite(Number(trimmed))) return undefined;

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
