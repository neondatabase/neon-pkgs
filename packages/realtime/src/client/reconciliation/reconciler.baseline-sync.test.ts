import { describe, expect, it } from "vitest";

import type { BaselineSyncPublicationReconciler } from "./reconciler.js";
import {
	accept,
	baselineSyncBatch,
	baselineSyncEnd,
	baselineSyncStart,
	completeEmptyBaselineSync,
	keyedPublication,
	ROW_A,
	ROW_B,
	ROW_C,
	resetPublication,
	row,
	subscribed,
	target,
	upsert,
} from "./reconciler.test-helpers.js";

describe("baseline-sync reconciliation", () => {
	it("replays every publication delivered after an exact-frontier baseline", () => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));

		accept(reconciler, {
			type: "baseline_sync_start",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			mvcc: { xmin: "100", xmax: "105", xip: ["103"] },
		});
		keyedPublication(
			reconciler,
			"p1",
			"1",
			"1",
			[upsert(ROW_A, "already-in-snapshot")],
			["99"],
		);
		keyedPublication(
			reconciler,
			"p2",
			"1",
			"2",
			[upsert(ROW_B, "after-snapshot")],
			["105"],
		);
		accept(reconciler, baselineSyncBatch(0, [row(ROW_A, "snapshot")]));
		accept(reconciler, baselineSyncEnd(1));

		expect(events).toEqual([
			"installReset:a",
			"apply:a",
			"apply:b",
			"publishReset:a",
			"publishBatch:99:a",
			"publishBatch:105:b",
			"caughtUp",
		]);
	});

	it.each([
		"before baseline-sync start",
		"between a batch and baseline-sync end",
	])("replays a publication delivered %s", (position) => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));
		if (position !== "before baseline-sync start") {
			accept(reconciler, baselineSyncStart());
			accept(reconciler, baselineSyncBatch(0, [row(ROW_A, "snapshot")]));
		}
		keyedPublication(reconciler, "p1", "1", "1", [upsert(ROW_B, "change")]);
		if (position === "before baseline-sync start") {
			accept(reconciler, baselineSyncStart());
			accept(reconciler, baselineSyncBatch(0, [row(ROW_A, "snapshot")]));
		}
		accept(reconciler, baselineSyncEnd(1));

		expect(events).toEqual([
			"installReset:a",
			"apply:b",
			"publishReset:a",
			"publishBatch:7:b",
			"caughtUp",
		]);
	});

	it("supersedes an incomplete baseline-sync attempt without publishing it", () => {
		const state = target();
		const reconciler = subscribed(state);
		const supersededMvcc = { xmin: "10", xmax: "20", xip: ["15"] };
		const appliedMvcc = { xmin: "30", xmax: "40", xip: ["35"] };
		accept(reconciler, {
			...baselineSyncStart("1", "1"),
			mvcc: supersededMvcc,
		});
		accept(reconciler, {
			...baselineSyncStart("1", "2"),
			mvcc: appliedMvcc,
		});
		accept(reconciler, baselineSyncBatch(0, [row(ROW_A, "old")], "1", "1"));
		accept(reconciler, baselineSyncEnd(0, "1", "2"));

		expect(state.publishReset).toHaveBeenCalledOnce();
		expect(state.publishReset).toHaveBeenCalledWith([], appliedMvcc);
	});

	it("preserves order and buffered publications across superseded baseline-sync attempts", () => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));
		accept(reconciler, baselineSyncStart("1", "1"));
		accept(reconciler, baselineSyncBatch(0, [row(ROW_A, "old")], "1", "1"));
		keyedPublication(reconciler, "p1", "1", "1", [upsert(ROW_C, "change")]);
		accept(reconciler, baselineSyncStart("1", "2"));
		accept(
			reconciler,
			baselineSyncBatch(
				0,
				[row(ROW_B, "replacement-b"), row(ROW_A, "replacement-a")],
				"1",
				"2",
			),
		);
		accept(reconciler, baselineSyncEnd(1, "1", "1"));
		expect(events).toEqual([]);
		accept(reconciler, baselineSyncEnd(1, "1", "2"));

		expect(events).toEqual([
			"installReset:b,a",
			"apply:c",
			"publishReset:b,a",
			"publishBatch:7:c",
			"caughtUp",
		]);
	});

	it("moves to a replacement epoch only after a committed reset", () => {
		const state = target();
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		resetPublication(reconciler, "reset", "2");

		expect(state.resetRequired).toHaveBeenCalledOnce();
		accept(reconciler, baselineSyncStart("2"));
		accept(reconciler, baselineSyncEnd(0, "2"));
		expect(state.publishReset).toHaveBeenCalledTimes(2);
	});

	it("drops an old epoch backlog when a later reset supersedes it", () => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));
		completeEmptyBaselineSync(reconciler);
		events.length = 0;

		resetPublication(reconciler, "r2", "2");
		keyedPublication(reconciler, "p2", "2", "1", [
			upsert(ROW_A, "discarded"),
		]);
		resetPublication(reconciler, "r3", "3");
		accept(reconciler, baselineSyncBatch(0, [row(ROW_A, "stale")], "2"));
		accept(reconciler, baselineSyncEnd(1, "2"));
		accept(reconciler, baselineSyncStart("3"));
		accept(reconciler, baselineSyncBatch(0, [row(ROW_B, "current")], "3"));
		accept(reconciler, baselineSyncEnd(1, "3"));

		expect(events).toEqual([
			"resetRequired",
			"resetRequired",
			"installReset:b",
			"publishReset:b",
			"caughtUp",
		]);
	});

	it("does not reinterpret a contiguous publication using snapshot MVCC metadata", () => {
		const reconciler = subscribed(target());
		accept(reconciler, {
			type: "baseline_sync_start",
			live_id: "9",
			epoch: "1",
			baseline_sync_attempt: "1",
			mvcc: { xmin: "100", xmax: "105", xip: [] },
		});
		keyedPublication(reconciler, "p", "1", "1", [], ["99", "105"]);

		expect(() => accept(reconciler, baselineSyncEnd(0))).not.toThrow();
	});

	it("rejects a later baseline-sync attempt after installing the epoch", () => {
		const reconciler = subscribed(target());
		completeEmptyBaselineSync(reconciler);

		expect(() => accept(reconciler, baselineSyncStart("1", "2"))).toThrow(
			"invalid baseline sync start",
		);
	});

	it("preserves wire order within and across baseline-sync batches", () => {
		const state = target();
		const reconciler = subscribed(state);
		accept(reconciler, baselineSyncStart());
		accept(
			reconciler,
			baselineSyncBatch(0, [row(ROW_C, "c"), row(ROW_A, "a")]),
		);
		accept(reconciler, baselineSyncBatch(1, [row(ROW_B, "b")]));
		accept(reconciler, baselineSyncEnd(2));

		expect(state.publishReset).toHaveBeenCalledWith(
			[row(ROW_C, "c"), row(ROW_A, "a"), row(ROW_B, "b")],
			{ xmin: "1", xmax: "2", xip: [] },
		);
	});

	it.each([
		[
			"a chunk without a start",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, baselineSyncBatch(0, []));
			},
		],
		[
			"a non-contiguous chunk",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, baselineSyncStart());
				accept(reconciler, baselineSyncBatch(1, []));
			},
		],
		[
			"a duplicate chunk",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, baselineSyncStart());
				accept(reconciler, baselineSyncBatch(0, []));
				accept(reconciler, baselineSyncBatch(0, []));
			},
		],
		[
			"a mismatched chunk count",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, baselineSyncStart());
				accept(reconciler, baselineSyncBatch(0, []));
				accept(reconciler, baselineSyncEnd(2));
			},
		],
	])("rejects %s", (_description, drive) => {
		const state = target();
		expect(() => drive(subscribed(state))).toThrow(/invalid baseline sync/);
		expect(state.publishReset).not.toHaveBeenCalled();
	});

	it("rejects invalid row arity and duplicate baseline-sync keys", () => {
		const arity = subscribed(target());
		accept(arity, baselineSyncStart());
		expect(() =>
			accept(
				arity,
				baselineSyncBatch(0, [
					{
						row_key: ROW_A,
						values: ["a", "b"],
					},
				]),
			),
		).toThrow("baseline sync row arity does not match columns");

		const duplicate = subscribed(target());
		accept(duplicate, baselineSyncStart());
		expect(() =>
			accept(
				duplicate,
				baselineSyncBatch(0, [
					row(ROW_A, "first"),
					row(ROW_A, "second"),
				]),
			),
		).toThrow("baseline sync contains a duplicate row key");

		const duplicateAcrossChunks = subscribed(target());
		accept(duplicateAcrossChunks, baselineSyncStart());
		accept(
			duplicateAcrossChunks,
			baselineSyncBatch(0, [row(ROW_A, "first")]),
		);
		expect(() =>
			accept(
				duplicateAcrossChunks,
				baselineSyncBatch(1, [row(ROW_A, "second")]),
			),
		).toThrow("baseline sync contains a duplicate row key");
	});
});
