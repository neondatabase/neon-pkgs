import { describe, expect, it } from "vitest";

import { BaselineSyncPublicationReconciler } from "./reconciler.js";
import {
	accept,
	baselineSyncStart,
	commit,
	completeEmptyBaselineSync,
	keyedPublication,
	keyedResults,
	ROW_A,
	ROW_B,
	resetRequired,
	subscribed,
	target,
	upsert,
} from "./reconciler.test-helpers.js";

describe("publication reconciliation", () => {
	it("advances every live target at an ordered publication frontier", () => {
		const changed = target();
		const unchanged = target();
		const reconciler = subscribed(changed);
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: unchanged,
		});
		completeEmptyBaselineSync(reconciler, "9");
		completeEmptyBaselineSync(reconciler, "10");
		changed.advanceContinuity.mockClear();
		unchanged.advanceContinuity.mockClear();

		keyedPublication(reconciler, "p", "1", "1", [upsert(ROW_A, "changed")]);

		expect(changed.advanceContinuity).toHaveBeenCalledWith("0/10");
		expect(unchanged.advanceContinuity).toHaveBeenCalledWith("0/10");
	});

	it("joins fragments, advances a target sequence once, and installs atomically", () => {
		const observations: string[] = [];
		const left = target(observations, "left");
		const right = target(observations, "right");
		const reconciler = new BaselineSyncPublicationReconciler();
		reconciler.add({
			liveId: "1",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: left,
		});
		reconciler.add({
			liveId: "2",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: right,
		});
		completeEmptyBaselineSync(reconciler, "1");
		completeEmptyBaselineSync(reconciler, "2");
		observations.length = 0;

		accept(reconciler, { type: "open", publication_id: "p" });
		accept(reconciler, {
			type: "keyed_results",
			publication_id: "p",
			index: 0,
			txids: ["7"],
			targets: [
				{ live_id: "1", epoch: "1", sequence: "1" },
				{ live_id: "2", epoch: "1", sequence: "1" },
			],
			changes: [{ op: "upsert", row_key: ROW_A, values: ["a"] }],
		});
		accept(reconciler, {
			type: "keyed_results",
			publication_id: "p",
			index: 1,
			txids: ["7"],
			targets: [
				{ live_id: "1", epoch: "1", sequence: "1" },
				{ live_id: "2", epoch: "1", sequence: "1" },
			],
			changes: [{ op: "upsert", row_key: ROW_B, values: ["b"] }],
		});
		accept(reconciler, commit("p", 2));

		expect(observations).toEqual([
			"left:apply:a,b",
			"right:apply:a,b",
			"left:publishBatch:7:a,b",
			"right:publishBatch:7:a,b",
		]);
	});

	it("does not publish an incomplete publication", () => {
		const state = target();
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		state.applyBatch.mockClear();
		state.publishBatch.mockClear();

		accept(reconciler, { type: "open", publication_id: "p" });
		accept(
			reconciler,
			keyedResults("p", 0, "1", "1", [upsert(ROW_A, "pending")]),
		);

		expect(state.applyBatch).not.toHaveBeenCalled();
		expect(state.publishBatch).not.toHaveBeenCalled();
	});

	it("counts an empty keyed publication as sequence progress", () => {
		const state = target();
		const reconciler = subscribed(state);
		completeEmptyBaselineSync(reconciler);
		state.publishBatch.mockClear();

		keyedPublication(reconciler, "empty", "1", "1", [], []);
		keyedPublication(reconciler, "next", "1", "2", [upsert(ROW_A, "next")]);

		expect(state.publishBatch).toHaveBeenCalledTimes(2);
		expect(state.publishBatch.mock.calls[0]?.[0]).toEqual({
			changes: [],
			txids: [],
		});
	});

	it.each([
		[
			"an overlapping open",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, { type: "open", publication_id: "p" });
				accept(reconciler, { type: "open", publication_id: "other" });
			},
		],
		[
			"a body for another publication",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, { type: "open", publication_id: "p" });
				accept(reconciler, keyedResults("other", 0, "1", "1", []));
			},
		],
		[
			"a non-contiguous body index",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, { type: "open", publication_id: "p" });
				accept(reconciler, keyedResults("p", 1, "1", "1", []));
			},
		],
		[
			"a commit for another publication",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, { type: "open", publication_id: "p" });
				accept(reconciler, commit("other", 0));
			},
		],
		[
			"a mismatched body count",
			(reconciler: BaselineSyncPublicationReconciler) => {
				accept(reconciler, { type: "open", publication_id: "p" });
				accept(reconciler, keyedResults("p", 0, "1", "1", []));
				accept(reconciler, commit("p", 2));
			},
		],
	])("rejects %s", (_description, drive) => {
		expect(() => drive(subscribed(target()))).toThrow(/publication/);
	});

	it.each([
		["the wrong epoch", keyedResults("p", 0, "2", "1", [])],
		["a sequence gap", keyedResults("p", 0, "1", "2", [])],
		[
			"a duplicate target",
			{
				...keyedResults("p", 0, "1", "1", []),
				targets: [
					{ live_id: "9", epoch: "1", sequence: "1" },
					{ live_id: "9", epoch: "1", sequence: "1" },
				],
			},
		],
		[
			"an upsert with the wrong arity",
			keyedResults("p", 0, "1", "1", [
				{
					op: "upsert",
					row_key: ROW_A,
					values: ["a", "b"],
				},
			]),
		],
	])("rejects a target with %s", (_description, message) => {
		const reconciler = subscribed(target());
		accept(reconciler, { type: "open", publication_id: "p" });
		expect(() => accept(reconciler, message)).toThrow(/publication/);
	});

	it("rejects inconsistent transaction IDs across keyed fragments", () => {
		const reconciler = subscribed(target());
		accept(reconciler, { type: "open", publication_id: "p" });
		accept(reconciler, keyedResults("p", 0, "1", "1", [], ["7"]));

		expect(() =>
			accept(reconciler, keyedResults("p", 1, "1", "1", [], ["8"])),
		).toThrow("invalid publication target");
	});

	it("rejects reset targets that do not advance the epoch or also receive changes", () => {
		const oldEpoch = subscribed(target());
		accept(oldEpoch, { type: "open", publication_id: "p" });
		expect(() => accept(oldEpoch, resetRequired("p", 0, "1"))).toThrow(
			"invalid reset target",
		);

		const mixed = subscribed(target());
		accept(mixed, { type: "open", publication_id: "p" });
		accept(mixed, keyedResults("p", 0, "1", "1", []));
		expect(() => accept(mixed, resetRequired("p", 1, "2"))).toThrow(
			"invalid reset target",
		);
	});

	it("validates every target before publishing a shared batch", () => {
		const left = target();
		const right = target();
		const reconciler = new BaselineSyncPublicationReconciler();
		reconciler.add({
			liveId: "9",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: left,
		});
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 0,
			target: right,
		});
		completeEmptyBaselineSync(reconciler, "9");
		completeEmptyBaselineSync(reconciler, "10");
		left.applyBatch.mockClear();
		left.publishBatch.mockClear();
		right.applyBatch.mockClear();
		right.publishBatch.mockClear();

		accept(reconciler, { type: "open", publication_id: "p" });
		const message = keyedResults("p", 0, "1", "1", [
			upsert(ROW_A, "value"),
		]);
		message.targets = [
			{ live_id: "9", epoch: "1", sequence: "1" },
			{ live_id: "10", epoch: "1", sequence: "1" },
		];
		expect(() => accept(reconciler, message)).toThrow(
			"publication row arity",
		);
		expect(left.applyBatch).not.toHaveBeenCalled();
		expect(left.publishBatch).not.toHaveBeenCalled();
		expect(right.applyBatch).not.toHaveBeenCalled();
		expect(right.publishBatch).not.toHaveBeenCalled();
	});

	it.each([
		"before the body",
		"after the body",
	])("finishes a shared publication when one target is deactivated %s", (position) => {
		const left = target();
		const right = target();
		const reconciler = new BaselineSyncPublicationReconciler();
		reconciler.add({
			liveId: "9",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: left,
		});
		reconciler.add({
			liveId: "10",
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: right,
		});
		completeEmptyBaselineSync(reconciler, "9");
		completeEmptyBaselineSync(reconciler, "10");
		left.publishBatch.mockClear();
		right.publishBatch.mockClear();

		accept(reconciler, { type: "open", publication_id: "p" });
		if (position === "before the body") reconciler.deactivate("9");
		const message = keyedResults("p", 0, "1", "1", [
			upsert(ROW_A, "value"),
		]);
		message.targets = [
			{ live_id: "9", epoch: "1", sequence: "1" },
			{ live_id: "10", epoch: "1", sequence: "1" },
		];
		accept(reconciler, message);
		if (position === "after the body") reconciler.deactivate("9");
		accept(reconciler, commit("p", 1));

		expect(left.publishBatch).not.toHaveBeenCalled();
		expect(right.publishBatch).toHaveBeenCalledOnce();
	});

	it("rejects a baseline sync interleaved into an open publication", () => {
		const reconciler = subscribed(target());
		accept(reconciler, { type: "open", publication_id: "p" });

		expect(() => accept(reconciler, baselineSyncStart())).toThrow(
			"baseline sync interrupted a publication",
		);
	});

	it("fails closed for broken publication framing", () => {
		const reconciler = subscribed(target());

		expect(() => accept(reconciler, commit("missing", 0))).toThrow(
			"invalid publication commit",
		);
	});
});
