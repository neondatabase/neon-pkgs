import { describe, expect, it } from "vitest";

import { ContinuityTracker } from "./continuity.js";

const HISTORY_A = "a".repeat(64);
const HISTORY_B = "b".repeat(64);

describe("subscription continuity", () => {
	it("accepts an initial baseline and same-history forward progress", () => {
		const tracker = new ContinuityTracker();

		expect(
			tracker.installBaseline({ history: HISTORY_A, lsn: "0/10" }),
		).toBe(true);
		tracker.advance("0/20");
		expect(
			tracker.installBaseline({ history: HISTORY_A, lsn: "0/20" }),
		).toBe(true);
		expect(
			tracker.installBaseline({ history: HISTORY_A, lsn: "1/0" }),
		).toBe(true);
	});

	it("rejects an older baseline even if it shares the history", () => {
		const tracker = new ContinuityTracker();
		tracker.installBaseline({ history: HISTORY_A, lsn: "1/0" });

		expect(
			tracker.installBaseline({ history: HISTORY_A, lsn: "0/FFFFFFFF" }),
		).toBe(false);
	});

	it("rejects a baseline from another history regardless of its LSN", () => {
		const tracker = new ContinuityTracker();
		tracker.installBaseline({ history: HISTORY_A, lsn: "1/0" });

		expect(
			tracker.installBaseline({
				history: HISTORY_B,
				lsn: "FFFFFFFF/FFFFFFFF",
			}),
		).toBe(false);
	});

	it("uses the replacement baseline as the new comparison point", () => {
		const tracker = new ContinuityTracker();
		tracker.installBaseline({ history: HISTORY_A, lsn: "1/0" });
		expect(
			tracker.installBaseline({ history: HISTORY_B, lsn: "0/10" }),
		).toBe(false);

		expect(
			tracker.installBaseline({ history: HISTORY_B, lsn: "0/11" }),
		).toBe(true);
	});
});
