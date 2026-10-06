import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMvccSnapshot } from "./mvcc.js";
import { TransactionTracker } from "./transaction-tracker.js";

afterEach(() => vi.useRealTimers());

describe("transaction confirmation", () => {
	it("resolves pending and late waits from applied progress", async () => {
		const tracker = new TransactionTracker();
		const beforeXmin = tracker.wait("99");
		const atXmin = tracker.wait("100");
		const hole = tracker.wait("103");
		const cutoff = tracker.wait("110");
		tracker.applyProgress(
			parseMvccSnapshot({ xmin: "100", xmax: "110", xip: ["103"] }),
		);
		await expect(beforeXmin).resolves.toBeUndefined();
		await expect(atXmin).resolves.toBeUndefined();
		await expect(tracker.wait("00109")).resolves.toBeUndefined();
		const holeResult = expect(hole).rejects.toThrow(
			"subscription is closed",
		);
		const cutoffResult = expect(cutoff).rejects.toThrow(
			"subscription is closed",
		);
		tracker.close();
		await Promise.all([holeResult, cutoffResult]);
	});

	it("keeps earlier proof for late waits after truncation and fills holes later", async () => {
		const tracker = new TransactionTracker();
		tracker.applySnapshot({ xmin: "100", xmax: "200", xip: ["103"] });
		const hole = tracker.wait("103");
		tracker.applyProgress(
			parseMvccSnapshot({ xmin: "100", xmax: "103", xip: [] }),
		);
		await expect(tracker.wait("150")).resolves.toBeUndefined();
		tracker.applySnapshot({ xmin: "104", xmax: "110", xip: [] });
		await expect(hole).resolves.toBeUndefined();
		await expect(tracker.wait("199")).resolves.toBeUndefined();
		tracker.close();
	});

	it("resolves all waiters for a transaction and clears their timers", async () => {
		vi.useFakeTimers();
		const tracker = new TransactionTracker();
		const first = tracker.wait("42", 100);
		const second = tracker.wait("00042", 200);
		tracker.applyProgress(
			parseMvccSnapshot({ xmin: "43", xmax: "43", xip: [] }),
		);
		await expect(Promise.all([first, second])).resolves.toEqual([
			undefined,
			undefined,
		]);
		expect(vi.getTimerCount()).toBe(0);
		tracker.close();
	});

	it("times out unknown transactions without timing out another waiter", async () => {
		vi.useFakeTimers();
		const tracker = new TransactionTracker();
		const expired = expect(tracker.wait("42", 10)).rejects.toThrow(
			"Timed out waiting for live-query transaction 42",
		);
		const remaining = tracker.wait("42", 100);
		await vi.advanceTimersByTimeAsync(10);
		await expired;
		tracker.seen("42");
		await expect(remaining).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		tracker.close();
	});

	it("rejects pending and future waits when closed and ignores later proofs", async () => {
		vi.useFakeTimers();
		const tracker = new TransactionTracker();
		const pending = expect(tracker.wait("42", 100)).rejects.toThrow(
			"subscription is closed",
		);
		tracker.close();
		tracker.close();
		tracker.applyProgress(
			parseMvccSnapshot({ xmin: "43", xmax: "43", xip: [] }),
		);
		tracker.seen("42");
		await pending;
		await expect(tracker.wait("42")).rejects.toThrow(
			"subscription is closed",
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves exact transaction IDs and validates wait inputs", async () => {
		const tracker = new TransactionTracker();
		tracker.seen("18446744073709551615");
		await expect(
			tracker.wait("18446744073709551615"),
		).resolves.toBeUndefined();
		for (const invalid of ["-1", "1.5", "", "x"]) {
			await expect(tracker.wait(invalid)).rejects.toThrow(
				"must be a decimal string",
			);
		}
		await expect(tracker.wait("18446744073709551616")).rejects.toThrow(
			"exceeds uint64",
		);
		for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(tracker.wait("42", timeout)).rejects.toThrow(
				"non-negative number",
			);
		}
		tracker.close();
	});
});
