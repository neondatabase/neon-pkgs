/**
 * Minimal retry-with-backoff for idempotent reads and 429s. The raw layer does no
 * retries; the ergonomic client opts in via `retries` config.
 */

export interface RawOutcome {
	error?: unknown;
	response?: Response | undefined;
}

// Only statuses Neon documents as always-safe to retry (no work performed / locked /
// rate limited) — safe for non-idempotent methods too. 5xx is intentionally excluded
// from the default since a mutating request may have partially applied.
const RETRYABLE_STATUS = new Set([423, 429, 503]);

function backoffMs(attempt: number, response: Response | undefined): number {
	const retryAfter = response?.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return seconds * 1000;
	}
	// exponential backoff with full jitter: base 250ms, capped at 10s
	const ceiling = Math.min(10_000, 250 * 2 ** attempt);
	return Math.random() * ceiling;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const id = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(id);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

/**
 * Run `exec` up to `retries + 1` times, retrying only on retryable HTTP statuses
 * (`423`, `429`, `5xx`). Non-retryable errors and successes return immediately.
 */
export async function withRetries<T extends RawOutcome>(
	exec: () => Promise<T>,
	retries: number,
	signal?: AbortSignal,
): Promise<T> {
	let attempt = 0;
	for (;;) {
		const result = await exec();
		const status = result.response?.status;
		const retryable = status !== undefined && RETRYABLE_STATUS.has(status);
		if (!result.error || !retryable || attempt >= retries) return result;
		await sleep(backoffMs(attempt, result.response), signal);
		attempt += 1;
	}
}
