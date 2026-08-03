import { describe, expect, it } from "vitest";
import {
	backoffMs,
	MAX_RETRY_WAIT_MS,
	nextRetryDelayMs,
	parseRetryAfterMs,
} from "./retry.js";

const NOW = Date.parse("2026-08-03T00:00:00Z");

describe("parseRetryAfterMs", () => {
	it("reads the delay-seconds form", () => {
		expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
	});

	it("reads the HTTP-date form, which the numeric parse alone leaves as NaN", () => {
		const header = new Date(NOW + 90_000).toUTCString();
		expect(parseRetryAfterMs(header, NOW)).toBe(90_000);
	});

	it("clamps a date already in the past to zero rather than going negative", () => {
		const header = new Date(NOW - 60_000).toUTCString();
		expect(parseRetryAfterMs(header, NOW)).toBe(0);
	});

	it("returns undefined for an absent, blank, or unparseable header", () => {
		expect(parseRetryAfterMs(null, NOW)).toBeUndefined();
		expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
		expect(parseRetryAfterMs("   ", NOW)).toBeUndefined();
		expect(parseRetryAfterMs("soon", NOW)).toBeUndefined();
	});

	it("rejects malformed numbers instead of letting the date parser rescue them", () => {
		// `Date.parse` reads "-1", "1.5" and "+5" as dates in 2001 — all in the past, so
		// the delay clamped to 0 and a malformed header became an immediate retry.
		for (const header of ["-1", "1.5", "+5", "1e3", "0x10", "007.0"]) {
			expect(parseRetryAfterMs(header, NOW)).toBeUndefined();
		}
	});

	it("still reads a leading-zero integer, which is valid delta-seconds", () => {
		expect(parseRetryAfterMs("007", NOW)).toBe(7_000);
	});
});

describe("backoffMs", () => {
	it("grows exponentially from a 250ms base", () => {
		expect(backoffMs(0, () => 1)).toBe(250);
		expect(backoffMs(1, () => 1)).toBe(500);
		expect(backoffMs(2, () => 1)).toBe(1000);
	});

	it("never exceeds the ceiling however many attempts have passed", () => {
		expect(backoffMs(50, () => 1)).toBe(MAX_RETRY_WAIT_MS);
	});

	it("jitters across the full range below the ceiling", () => {
		expect(backoffMs(3, () => 0)).toBe(0);
		expect(backoffMs(3, () => 0.5)).toBe(1000);
	});
});

describe("nextRetryDelayMs", () => {
	it("honours Retry-After exactly rather than shortening it", () => {
		// Retrying earlier than the server asked is worse than not retrying, so a
		// server-supplied delay is never replaced by a smaller generated one.
		expect(nextRetryDelayMs(0, 5_000, Number.POSITIVE_INFINITY)).toBe(
			5_000,
		);
	});

	it("declines to retry when Retry-After exceeds the ceiling", () => {
		expect(
			nextRetryDelayMs(0, 3_600_000, Number.POSITIVE_INFINITY),
		).toBeUndefined();
	});

	it("declines to retry when the wait would outlast the remaining budget", () => {
		expect(nextRetryDelayMs(0, 5_000, 1_000)).toBeUndefined();
	});

	it("falls back to generated backoff when no header is present", () => {
		expect(
			nextRetryDelayMs(0, undefined, Number.POSITIVE_INFINITY, () => 1),
		).toBe(250);
	});

	it("declines when even generated backoff would outlast the budget", () => {
		expect(nextRetryDelayMs(4, undefined, 10, () => 1)).toBeUndefined();
	});
});
