import { describe, expect, it } from "vitest";

import {
	DEFAULT_RECONNECT_MAX_ELAPSED_MS,
	equalJitterDelayMs,
	ReconnectBackoff,
} from "./reconnect.js";

describe("ReconnectBackoff", () => {
	it("uses equal-jitter exponential delays capped by policy", () => {
		expect(equalJitterDelayMs(0, 1_000, 60_000, () => 0)).toBe(500);
		expect(equalJitterDelayMs(1, 1_000, 60_000, () => 0.5)).toBe(1_500);
		expect(equalJitterDelayMs(10, 1_000, 60_000, () => 0)).toBe(30_000);
	});

	it("does not let clock rollback extend the reconnect episode", () => {
		let now = 100;
		const backoff = new ReconnectBackoff({
			baseMs: 10,
			capMs: 10,
			maxAttempts: 5,
			maxElapsedMs: 20,
			random: () => 0,
			now: () => now,
		});
		expect(backoff.next()).toMatchObject({
			attempt: 1,
			delayMs: 5,
			remainingMs: 20,
		});
		now = 90;
		expect(backoff.next()).toMatchObject({ attempt: 2, remainingMs: 20 });
		now = 120;
		expect(backoff.next()).toBeUndefined();
	});

	it("resets attempts only when explicitly marked stable", () => {
		const backoff = new ReconnectBackoff({
			baseMs: 10,
			capMs: 20,
			random: () => 0,
		});
		expect(backoff.next()).toMatchObject({ attempt: 1, delayMs: 5 });
		expect(backoff.next()).toMatchObject({ attempt: 2, delayMs: 10 });
		backoff.reset();
		expect(backoff.next()).toMatchObject({ attempt: 1, delayMs: 5 });
	});

	it("reconnects indefinitely by default", () => {
		let now = 0;
		const backoff = new ReconnectBackoff({
			baseMs: 10,
			capMs: 10,
			random: () => 0,
			now: () => now,
		});
		expect(backoff.next()).toMatchObject({
			attempt: 1,
			delayMs: 5,
			remainingMs: Number.POSITIVE_INFINITY,
		});
		now = DEFAULT_RECONNECT_MAX_ELAPSED_MS * 2;
		expect(backoff.next()).toMatchObject({
			attempt: 2,
			delayMs: 5,
			remainingMs: Number.POSITIVE_INFINITY,
		});
	});

	it("rejects invalid policy configuration", () => {
		expect(() => new ReconnectBackoff({ baseMs: 0 })).toThrow(
			"reconnect.baseMs must be a positive safe integer",
		);
		expect(() => new ReconnectBackoff({ baseMs: 2, capMs: 1 })).toThrow(
			"reconnect.baseMs must not exceed reconnect.capMs",
		);
		expect(() => new ReconnectBackoff({ random: () => 1 })).toThrow(
			"reconnect.random must return a finite number in [0, 1)",
		);
	});
});
