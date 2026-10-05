import { describe, expect, it } from "vitest";

import { parseMvccSnapshot } from "../mvcc.js";
import {
	accept,
	baselineSyncEnd,
	baselineSyncStart,
	commit,
	completeEmptyBaselineSync,
	keyedResults,
	ROW_A,
	resetPublication,
	subscribed,
	target,
	upsert,
	wireBytes,
} from "./reconciler.test-helpers.js";

const progress = {
	type: "progress" as const,
	mvcc: { xmin: "10", xmax: "100", xip: ["10", "80"] },
};

describe("ordered MVCC progress", () => {
	it("shares one parsed proof with ready targets without row notifications", () => {
		const left = target();
		const right = target();
		const reconciler = subscribed(left);
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: right,
		});
		completeEmptyBaselineSync(reconciler);
		completeEmptyBaselineSync(reconciler, "10");
		const parsed = parseMvccSnapshot(progress.mvcc);
		reconciler.accept(progress, wireBytes(progress), parsed);

		expect(left.applyProgress).toHaveBeenCalledWith(parsed);
		expect(right.applyProgress.mock.calls[0]?.[0]).toBe(parsed);
		expect(left.publishBatch).not.toHaveBeenCalled();
		expect(right.publishBatch).not.toHaveBeenCalled();
		expect(left.publishReset).toHaveBeenCalledOnce();
		expect(reconciler.stagingBytes).toBe(0);
	});

	it("does not give cached progress to a later admission or incomplete baseline", () => {
		const first = target();
		const later = target();
		const reconciler = subscribed(first);
		completeEmptyBaselineSync(reconciler);
		accept(reconciler, progress);
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: later,
		});
		accept(reconciler, { ...baselineSyncStart(), live_id: "10" });
		accept(reconciler, progress);
		expect(first.applyProgress).toHaveBeenCalledTimes(2);
		expect(later.applyProgress).not.toHaveBeenCalled();
		accept(reconciler, { ...baselineSyncEnd(0), live_id: "10" });
		expect(later.applyProgress).not.toHaveBeenCalled();
		// An idle backend must replay this ordered barrier after catch-up.
		accept(reconciler, progress);
		expect(later.applyProgress).toHaveBeenCalledOnce();
	});

	it("rejects a proof inside a publication before acknowledging any target", () => {
		const events: string[] = [];
		const state = target(events);
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		events.length = 0;
		accept(reconciler, { type: "open", publication_id: "p" });
		accept(
			reconciler,
			keyedResults("p", 0, "1", "1", [upsert(ROW_A, "new")], ["42"]),
		);
		expect(() => accept(reconciler, progress)).toThrow(
			"progress interrupted a publication",
		);
		expect(state.applyProgress).not.toHaveBeenCalled();
		accept(reconciler, commit("p", 1));
		accept(reconciler, progress);
		expect(events).toEqual(["apply:a", "publishBatch:42:a", "progress"]);
	});

	it("waits for reset catch-up, including superseded attempts", () => {
		const state = target();
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		resetPublication(reconciler, "reset", "2");
		accept(reconciler, progress);
		accept(reconciler, baselineSyncStart("2", "1"));
		accept(reconciler, progress);
		accept(reconciler, baselineSyncStart("2", "2"));
		accept(reconciler, baselineSyncEnd(0, "2", "1"));
		expect(state.applyProgress).not.toHaveBeenCalled();
		accept(reconciler, baselineSyncEnd(0, "2", "2"));
		expect(state.applyProgress).not.toHaveBeenCalled();
		accept(reconciler, progress);
		expect(state.applyProgress).toHaveBeenCalledOnce();
	});

	it("ignores inactive, removed, and disconnected targets", () => {
		const state = target();
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		reconciler.deactivate("9");
		accept(reconciler, progress);
		reconciler.remove("9");
		accept(reconciler, progress);
		reconciler.clear();
		accept(reconciler, progress);
		expect(state.applyProgress).not.toHaveBeenCalled();
	});

	it("does not acknowledge a baseline whose installation failed", () => {
		const state = target();
		state.installReset.mockImplementation(() => {
			throw new Error("invalid row");
		});
		state.decodeFailed.mockImplementation(() => {});
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		accept(reconciler, progress);
		expect(state.decodeFailed).toHaveBeenCalledOnce();
		expect(state.applyProgress).not.toHaveBeenCalled();
	});
});
