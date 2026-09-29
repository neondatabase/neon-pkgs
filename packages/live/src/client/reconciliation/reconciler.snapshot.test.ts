import { describe, expect, it } from "vitest";

import type { SnapshotPublicationReconciler } from "./reconciler.js";
import {
	accept,
	completeEmptySnapshot,
	keyedPublication,
	ROW_A,
	ROW_B,
	resetPublication,
	row,
	snapshotChunk,
	snapshotEnd,
	snapshotStart,
	subscribed,
	target,
	upsert,
} from "./reconciler.test-helpers.js";

describe("snapshot reconciliation", () => {
	it("replays every publication delivered after an exact-frontier snapshot", () => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));

		accept(reconciler, {
			type: "snapshot_start",
			live_id: "9",
			epoch: "1",
			snapshot_attempt: "1",
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
		accept(reconciler, snapshotChunk(0, [row(ROW_A, "snapshot")]));
		accept(reconciler, snapshotEnd(1));

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
		"before snapshot start",
		"between a chunk and snapshot end",
	])("replays a publication delivered %s", (position) => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));
		if (position !== "before snapshot start") {
			accept(reconciler, snapshotStart());
			accept(reconciler, snapshotChunk(0, [row(ROW_A, "snapshot")]));
		}
		keyedPublication(reconciler, "p1", "1", "1", [upsert(ROW_B, "change")]);
		if (position === "before snapshot start") {
			accept(reconciler, snapshotStart());
			accept(reconciler, snapshotChunk(0, [row(ROW_A, "snapshot")]));
		}
		accept(reconciler, snapshotEnd(1));

		expect(events).toEqual([
			"installReset:a",
			"apply:b",
			"publishReset:a",
			"publishBatch:7:b",
			"caughtUp",
		]);
	});

	it("supersedes an incomplete snapshot attempt without publishing it", () => {
		const state = target();
		const reconciler = subscribed(state);
		const supersededMvcc = { xmin: "10", xmax: "20", xip: ["15"] };
		const appliedMvcc = { xmin: "30", xmax: "40", xip: ["35"] };
		accept(reconciler, {
			...snapshotStart("1", "1"),
			mvcc: supersededMvcc,
		});
		accept(reconciler, {
			...snapshotStart("1", "2"),
			mvcc: appliedMvcc,
		});
		accept(reconciler, snapshotChunk(0, [row(ROW_A, "old")], "1", "1"));
		accept(reconciler, snapshotEnd(0, "1", "2"));

		expect(state.publishReset).toHaveBeenCalledOnce();
		expect(state.publishReset).toHaveBeenCalledWith([], appliedMvcc);
	});

	it("preserves buffered publications across superseded snapshot attempts", () => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));
		accept(reconciler, snapshotStart("1", "1"));
		accept(reconciler, snapshotChunk(0, [row(ROW_A, "old")], "1", "1"));
		keyedPublication(reconciler, "p1", "1", "1", [upsert(ROW_B, "change")]);
		accept(reconciler, snapshotStart("1", "2"));
		accept(
			reconciler,
			snapshotChunk(0, [row(ROW_A, "replacement")], "1", "2"),
		);
		accept(reconciler, snapshotEnd(1, "1", "1"));
		expect(events).toEqual([]);
		accept(reconciler, snapshotEnd(1, "1", "2"));

		expect(events).toEqual([
			"installReset:a",
			"apply:b",
			"publishReset:a",
			"publishBatch:7:b",
			"caughtUp",
		]);
	});

	it("moves to a replacement epoch only after a committed reset", () => {
		const state = target();
		const reconciler = subscribed(state);
		completeEmptySnapshot(reconciler);
		resetPublication(reconciler, "reset", "2");

		expect(state.resetRequired).toHaveBeenCalledOnce();
		accept(reconciler, snapshotStart("2"));
		accept(reconciler, snapshotEnd(0, "2"));
		expect(state.publishReset).toHaveBeenCalledTimes(2);
	});

	it("drops an old epoch backlog when a later reset supersedes it", () => {
		const events: string[] = [];
		const reconciler = subscribed(target(events));
		completeEmptySnapshot(reconciler);
		events.length = 0;

		resetPublication(reconciler, "r2", "2");
		keyedPublication(reconciler, "p2", "2", "1", [
			upsert(ROW_A, "discarded"),
		]);
		resetPublication(reconciler, "r3", "3");
		accept(reconciler, snapshotChunk(0, [row(ROW_A, "stale")], "2"));
		accept(reconciler, snapshotEnd(1, "2"));
		accept(reconciler, snapshotStart("3"));
		accept(reconciler, snapshotChunk(0, [row(ROW_B, "current")], "3"));
		accept(reconciler, snapshotEnd(1, "3"));

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
			type: "snapshot_start",
			live_id: "9",
			epoch: "1",
			snapshot_attempt: "1",
			mvcc: { xmin: "100", xmax: "105", xip: [] },
		});
		keyedPublication(reconciler, "p", "1", "1", [], ["99", "105"]);

		expect(() => accept(reconciler, snapshotEnd(0))).not.toThrow();
	});

	it("rejects a later snapshot attempt after installing the epoch", () => {
		const reconciler = subscribed(target());
		completeEmptySnapshot(reconciler);

		expect(() => accept(reconciler, snapshotStart("1", "2"))).toThrow(
			"invalid snapshot start",
		);
	});

	it("assembles multiple snapshot chunks in order", () => {
		const state = target();
		const reconciler = subscribed(state);
		accept(reconciler, snapshotStart());
		accept(reconciler, snapshotChunk(0, [row(ROW_A, "a")]));
		accept(reconciler, snapshotChunk(1, [row(ROW_B, "b")]));
		accept(reconciler, snapshotEnd(2));

		expect(state.publishReset).toHaveBeenCalledWith(
			[row(ROW_A, "a"), row(ROW_B, "b")],
			{ xmin: "1", xmax: "2", xip: [] },
		);
	});

	it.each([
		[
			"a chunk without a start",
			(reconciler: SnapshotPublicationReconciler) => {
				accept(reconciler, snapshotChunk(0, []));
			},
		],
		[
			"a non-contiguous chunk",
			(reconciler: SnapshotPublicationReconciler) => {
				accept(reconciler, snapshotStart());
				accept(reconciler, snapshotChunk(1, []));
			},
		],
		[
			"a duplicate chunk",
			(reconciler: SnapshotPublicationReconciler) => {
				accept(reconciler, snapshotStart());
				accept(reconciler, snapshotChunk(0, []));
				accept(reconciler, snapshotChunk(0, []));
			},
		],
		[
			"a mismatched chunk count",
			(reconciler: SnapshotPublicationReconciler) => {
				accept(reconciler, snapshotStart());
				accept(reconciler, snapshotChunk(0, []));
				accept(reconciler, snapshotEnd(2));
			},
		],
	])("rejects %s", (_description, drive) => {
		const state = target();
		expect(() => drive(subscribed(state))).toThrow(/invalid snapshot/);
		expect(state.publishReset).not.toHaveBeenCalled();
	});

	it("rejects invalid row arity and duplicate snapshot keys", () => {
		const arity = subscribed(target());
		accept(arity, snapshotStart());
		expect(() =>
			accept(
				arity,
				snapshotChunk(0, [
					{
						row_key: ROW_A,
						values: ["a", "b"],
					},
				]),
			),
		).toThrow("snapshot row arity does not match columns");

		const duplicate = subscribed(target());
		accept(duplicate, snapshotStart());
		expect(() =>
			accept(
				duplicate,
				snapshotChunk(0, [row(ROW_A, "first"), row(ROW_A, "second")]),
			),
		).toThrow("snapshot contains a duplicate row key");
	});
});
