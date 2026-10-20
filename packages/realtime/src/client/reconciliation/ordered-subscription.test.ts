import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { SILENT_CLIENT_EVENTS } from "../diagnostics.js";
import { createParserRegistry } from "../postgres/parsers.js";
import { decodeServerMessage, ProtocolError } from "../protocol/codec.js";
import type { WireChange } from "../protocol/messages.js";
import { Subscription } from "../subscription.js";
import { BaselineSyncPublicationReconciler } from "./reconciler.js";
import {
	baselineSyncBatch,
	baselineSyncEnd,
	baselineSyncStart,
	commit,
	keyedPublication,
	keyedResults,
	resetPublication,
	row,
	upsert,
} from "./reconciler.test-helpers.js";

type Value = { readonly value: string };
const key = (value: string) => value.padStart(64, "0");
const A = key("a");
const B = key("b");
const C = key("c");
const D = key("d");
const X = key("e");
const Y = key("f");
const MISSING = key("0");
const move = (rowKey: string, after: string | null): WireChange => ({
	op: "move",
	row_key: rowKey,
	after_row_key: after,
});

function subscription(materialized = true, initialData?: readonly Value[]) {
	const target = new Subscription<Value>(
		{ renew: async () => {}, unsubscribe: () => {}, parserFailed: vi.fn() },
		{ capability: "test", queryFingerprint: "11".repeat(32), expiresAt: 1 },
		materialized,
		createParserRegistry(undefined),
		initialData,
		SILENT_CLIENT_EVENTS.createSubscription(),
	);
	target.admit([
		{ name: "value", type_oid: 25, typmod: -1, codec: "pg_text" },
	]);
	return target;
}

function add(
	reconciler: BaselineSyncPublicationReconciler,
	target: Subscription<Value>,
	liveId = "9",
) {
	reconciler.add({
		liveId,
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		target,
	});
}

function baseline(
	reconciler: BaselineSyncPublicationReconciler,
	keys: readonly string[],
	liveId = "9",
	epoch = "1",
) {
	reconciler.accept({ ...baselineSyncStart(epoch), live_id: liveId });
	reconciler.accept({
		...baselineSyncBatch(
			0,
			keys.map((id) => row(id, id.slice(-1))),
			epoch,
		),
		live_id: liveId,
	});
	reconciler.accept({ ...baselineSyncEnd(1, epoch), live_id: liveId });
}

function values(target: Subscription<Value>) {
	return target.getSnapshot().data?.map((value) => value.value);
}

function setup(keys = [A, B, C, D], materialized = true) {
	const reconciler = new BaselineSyncPublicationReconciler();
	const target = subscription(materialized);
	add(reconciler, target);
	baseline(reconciler, keys);
	return { reconciler, target };
}

describe("ordered production subscriptions", () => {
	it("preserves an upsert's position, splices rotations sequentially, and replays immediately", () => {
		const { reconciler, target } = setup();
		const changes = [upsert(A, "updated"), move(C, null), move(D, C)];
		const onChange = vi.fn();
		target.onChange(onChange);
		keyedPublication(reconciler, "p1", "1", "1", changes);
		expect(values(target)).toEqual(["c", "d", "updated", "b"]);
		expect(onChange).toHaveBeenCalledOnce();
		keyedPublication(reconciler, "p2", "1", "2", changes);
		expect(values(target)).toEqual(["c", "d", "updated", "b"]);
	});

	it("places entrants after new and moved anchors and supports head, tail, and empty results", () => {
		const { reconciler, target } = setup([A, B, C]);
		keyedPublication(reconciler, "p1", "1", "1", [
			{ op: "remove", row_key: C },
			upsert(X, "x"),
			upsert(Y, "y"),
			move(B, null),
			move(X, B),
			move(Y, X),
		]);
		expect(values(target)).toEqual(["b", "x", "y", "a"]);
		keyedPublication(reconciler, "p2", "1", "2", [move(B, A)]);
		expect(values(target)).toEqual(["x", "y", "a", "b"]);
		keyedPublication(
			reconciler,
			"p3",
			"1",
			"3",
			[A, B, X, Y].map((row_key) => ({ op: "remove", row_key })),
		);
		expect(values(target)).toEqual([]);
		keyedPublication(reconciler, "p4", "1", "4", [
			upsert(C, "c"),
			move(C, null),
		]);
		expect(values(target)).toEqual(["c"]);
	});

	it("matches an independent array oracle for random placement sets and immediate replay", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 1, max: 15 }), {
					maxLength: 15,
				}),
				fc.array(fc.nat(), { maxLength: 15 }),
				(ids, choices) => {
					const keys = ids.map((id) => key(id.toString(16)));
					const { reconciler, target } = setup(keys);
					const expected = [...keys];
					const placements = new Map<string, string | null>();
					for (let index = 0; index < keys.length; index += 1) {
						if ((choices[index] ?? 0) % 2 === 0) continue;
						const id = keys[index];
						expected.splice(expected.indexOf(id), 1);
						expected.splice(
							(choices[index] ?? 0) % (expected.length + 1),
							0,
							id,
						);
						placements.set(id, null);
					}
					const changes = expected.flatMap((id, index) =>
						placements.has(id)
							? [
									move(
										id,
										index === 0
											? null
											: expected[index - 1],
									),
								]
							: [],
					);
					keyedPublication(reconciler, "p1", "1", "1", changes);
					expect(values(target)).toEqual(
						expected.map((id) => id.slice(-1)),
					);
					keyedPublication(reconciler, "p2", "1", "2", changes);
					expect(values(target)).toEqual(
						expected.map((id) => id.slice(-1)),
					);
				},
			),
			{ numRuns: 500 },
		);
	});

	it("joins actual decoded wire fragments before applying or notifying", () => {
		const changes = [upsert(A, "updated"), move(C, null), move(D, C)];
		for (let split = 0; split <= changes.length; split += 1) {
			const { reconciler, target } = setup();
			const before = target.getSnapshot();
			const onChange = vi.fn();
			target.onChange(onChange);
			const messages = [
				{ type: "open", publication_id: "p" } as const,
				keyedResults("p", 0, "1", "1", changes.slice(0, split)),
				keyedResults("p", 1, "1", "1", changes.slice(split)),
			];
			for (const message of messages) {
				reconciler.accept(
					decodeServerMessage(JSON.stringify(message)) as Parameters<
						typeof reconciler.accept
					>[0],
				);
				expect(target.getSnapshot()).toBe(before);
			}
			expect(onChange).not.toHaveBeenCalled();
			reconciler.accept(commit("p", 2));
			expect(values(target)).toEqual(["c", "d", "updated", "b"]);
			expect(onChange).toHaveBeenCalledOnce();
		}
	});

	it.each([
		[move(A, A)],
		[move(A, null), move(A, B)],
		[move(B, A), move(C, A)],
		[move(B, null), move(C, null)],
		[move(B, C), move(C, null)],
		[move(A, null), upsert(B, "late")],
		[upsert(A, "one"), upsert(A, "two"), move(A, null)],
		[{ op: "remove", row_key: B } as WireChange, move(A, B)],
		[{ op: "remove", row_key: B } as WireChange, move(B, A)],
		[move(MISSING, null)],
		[upsert(A, "updated"), move(C, null), move(D, MISSING)],
	])("rejects malformed programs without changing the prior snapshot: %j", (...changes) => {
		const { reconciler, target } = setup();
		const before = target.getSnapshot();
		const onChange = vi.fn();
		const onUpdate = vi.fn();
		target.onChange(onChange);
		target.onUpdate(onUpdate);
		expect(() =>
			keyedPublication(reconciler, "bad", "1", "1", changes),
		).toThrow(ProtocolError);
		expect(target.getSnapshot()).toBe(before);
		expect(onChange).not.toHaveBeenCalled();
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("prepares all targets before installing any materialized target or emitting raw updates", () => {
		const { reconciler, target: left } = setup();
		const raw = subscription(false);
		const right = subscription();
		add(reconciler, raw, "10");
		add(reconciler, right, "11");
		baseline(reconciler, [], "10");
		baseline(reconciler, [A, B, C], "11");
		const leftBefore = left.getSnapshot();
		const rightBefore = right.getSnapshot();
		const leftChange = vi.fn();
		const rawUpdate = vi.fn();
		left.onChange(leftChange);
		raw.onUpdate(rawUpdate);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept({
			...keyedResults("p", 0, "1", "1", [
				upsert(A, "updated"),
				move(D, null),
			]),
			targets: ["9", "10", "11"].map((live_id) => ({
				live_id,
				epoch: "1",
				sequence: "1",
			})),
		});
		expect(() => reconciler.accept(commit("p", 1))).toThrow("missing row");
		expect(left.getSnapshot()).toBe(leftBefore);
		expect(right.getSnapshot()).toBe(rightBefore);
		expect(leftChange).not.toHaveBeenCalled();
		expect(rawUpdate).not.toHaveBeenCalled();
	});

	it("rejects an unplaced entrant in a later target before installing any target", () => {
		const { reconciler, target: left } = setup([A, B, C, D, X]);
		const raw = subscription(false);
		const right = subscription();
		add(reconciler, raw, "10");
		add(reconciler, right, "11");
		baseline(reconciler, [], "10");
		baseline(reconciler, [A, B, C, D], "11");
		const leftBefore = left.getSnapshot();
		const rightBefore = right.getSnapshot();
		const leftChange = vi.fn();
		const rawUpdate = vi.fn();
		left.onChange(leftChange);
		raw.onUpdate(rawUpdate);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept({
			...keyedResults("p", 0, "1", "1", [
				upsert(X, "updated"),
				move(D, null),
			]),
			targets: ["9", "10", "11"].map((live_id) => ({
				live_id,
				epoch: "1",
				sequence: "1",
			})),
		});
		expect(() => reconciler.accept(commit("p", 1))).toThrow(
			"entrant has no move",
		);
		expect(left.getSnapshot()).toBe(leftBefore);
		expect(right.getSnapshot()).toBe(rightBefore);
		expect(leftChange).not.toHaveBeenCalled();
		expect(rawUpdate).not.toHaveBeenCalled();
	});

	it.each([
		true,
		false,
	])("rejects malformed move order while awaiting a baseline: materialized=%s", (materialized) => {
		const reconciler = new BaselineSyncPublicationReconciler();
		const target = subscription(materialized);
		add(reconciler, target);
		const before = target.getSnapshot();
		const onUpdate = vi.fn();
		const onChange = vi.fn();
		target.onUpdate(onUpdate);
		if (materialized) target.onChange(onChange);
		reconciler.accept(baselineSyncStart());
		reconciler.accept(baselineSyncBatch(0, [row(A, "a"), row(B, "b")]));
		expect(() =>
			keyedPublication(reconciler, "bad", "1", "1", [
				move(A, null),
				upsert(B, "late"),
			]),
		).toThrow("contents follow moves");
		expect(target.getSnapshot()).toBe(before);
		expect(onUpdate).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps content-only updates private when a later target's move fails", () => {
		const { reconciler, target: left } = setup();
		const right = subscription();
		add(reconciler, right, "10");
		baseline(reconciler, [A, B, C], "10");
		const before = left.getSnapshot();
		const onChange = vi.fn();
		left.onChange(onChange);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept(
			keyedResults("p", 0, "1", "1", [
				upsert(A, "updated"),
				{ op: "remove", row_key: B },
				upsert(X, "new"),
			]),
		);
		reconciler.accept({
			...keyedResults("p", 1, "1", "1", [move(D, null)]),
			targets: [{ live_id: "10", epoch: "1", sequence: "1" }],
		});
		expect(() => reconciler.accept(commit("p", 2))).toThrow("missing row");
		expect(left.getSnapshot()).toBe(before);
		expect(onChange).not.toHaveBeenCalled();
		// Enumerate the underlying Map again to detect any hidden partial edits.
		left.prepare(undefined, [])();
		expect(values(left)).toEqual(["a", "b", "c", "d"]);
	});

	it.each([
		{ changes: [move(D, null)], expected: ["d", "a", "b", "c"] },
		{
			changes: [
				upsert(A, "updated"),
				{ op: "remove" as const, row_key: B },
			],
			expected: ["updated", "c", "d"],
		},
	])("installs every target before the first application callback: $changes", ({
		changes,
		expected,
	}) => {
		const { reconciler, target: left } = setup();
		const right = subscription();
		add(reconciler, right, "10");
		baseline(reconciler, [A, B, C, D], "10");
		const observed: unknown[] = [];
		left.onChange(() => observed.push(values(right)));
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept({
			...keyedResults("p", 0, "1", "1", changes),
			targets: ["9", "10"].map((live_id) => ({
				live_id,
				epoch: "1",
				sequence: "1",
			})),
		});
		reconciler.accept(commit("p", 1));
		expect(observed).toEqual([expected]);
	});

	it("replays the complete baseline backlog privately and exposes one caught-up snapshot", () => {
		const reconciler = new BaselineSyncPublicationReconciler();
		const target = subscription(true, [{ value: "preloaded" }]);
		add(reconciler, target);
		const onChange = vi.fn();
		target.onChange(onChange);
		reconciler.accept(baselineSyncStart());
		reconciler.accept(
			baselineSyncBatch(
				0,
				[A, B, C, D].map((id) => row(id, id.slice(-1))),
			),
		);
		keyedPublication(reconciler, "p1", "1", "1", [
			move(C, null),
			move(D, C),
		]);
		keyedPublication(reconciler, "p2", "1", "2", [
			upsert(A, "updated"),
			move(B, D),
		]);
		expect(values(target)).toEqual(["preloaded"]);
		expect(onChange).not.toHaveBeenCalled();
		reconciler.accept(baselineSyncEnd(1));
		expect(values(target)).toEqual(["c", "d", "b", "updated"]);
		expect(onChange).toHaveBeenCalledOnce();
	});

	it("rolls back the baseline and earlier replay batches on a late missing anchor", () => {
		const reconciler = new BaselineSyncPublicationReconciler();
		const target = subscription(true, [{ value: "retained" }]);
		add(reconciler, target);
		const before = target.getSnapshot();
		const onUpdate = vi.fn();
		target.onUpdate(onUpdate);
		reconciler.accept(baselineSyncStart());
		reconciler.accept(
			baselineSyncBatch(
				0,
				[A, B, C, D].map((id) => row(id, id.slice(-1))),
			),
		);
		keyedPublication(reconciler, "p1", "1", "1", [move(D, null)]);
		keyedPublication(reconciler, "p2", "1", "2", [
			upsert(A, "updated"),
			move(B, MISSING),
		]);
		expect(() => reconciler.accept(baselineSyncEnd(1))).toThrow(
			"missing anchor",
		);
		expect(target.getSnapshot()).toBe(before);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("rejects an unplaced entrant in replay without exposing the baseline or earlier batches", () => {
		const reconciler = new BaselineSyncPublicationReconciler();
		const target = subscription(true, [{ value: "retained" }]);
		add(reconciler, target);
		const before = target.getSnapshot();
		const onUpdate = vi.fn();
		target.onUpdate(onUpdate);
		reconciler.accept(baselineSyncStart());
		reconciler.accept(baselineSyncBatch(0, [row(A, "a"), row(B, "b")]));
		keyedPublication(reconciler, "p1", "1", "1", [upsert(A, "updated")]);
		keyedPublication(reconciler, "p2", "1", "2", [
			upsert(X, "unplaced"),
			move(B, null),
		]);
		expect(() => reconciler.accept(baselineSyncEnd(1))).toThrow(
			"entrant has no move",
		);
		expect(target.getSnapshot()).toBe(before);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it.each([
		true,
		false,
	])("ignores a prepared update after closing: closeBeforePrepare=%s", (closeBeforePrepare) => {
		const { target } = setup();
		if (closeBeforePrepare) target.markClosed();
		const install = target.prepare(undefined, [
			{ changes: [upsert(A, "discarded")], txids: [] },
		]);
		if (!closeBeforePrepare) target.markClosed();
		const before = target.getSnapshot();
		install();
		expect(target.getSnapshot()).toBe(before);
		expect(values(target)).toEqual(["a", "b", "c", "d"]);
	});

	it("discards an old epoch's buffered moves when reset requires a new baseline", () => {
		const reconciler = new BaselineSyncPublicationReconciler();
		const target = subscription();
		add(reconciler, target);
		reconciler.accept(baselineSyncStart());
		reconciler.accept(baselineSyncBatch(0, [row(A, "old")]));
		keyedPublication(reconciler, "old", "1", "1", [move(A, null)]);
		resetPublication(reconciler, "reset", "2");
		reconciler.accept(baselineSyncEnd(1));
		baseline(reconciler, [C, D], "9", "2");
		keyedPublication(reconciler, "new", "2", "1", [move(D, null)]);
		expect(values(target)).toEqual(["d", "c"]);
	});

	it("discards an incomplete publication on EOF and reconnects from a fresh baseline", () => {
		const { reconciler, target } = setup();
		const before = target.getSnapshot();
		const onUpdate = vi.fn();
		target.onUpdate(onUpdate);
		reconciler.accept({ type: "open", publication_id: "aborted" });
		reconciler.accept(
			keyedResults("aborted", 0, "1", "1", [move(D, null)]),
		);
		reconciler.clear();
		expect(target.getSnapshot()).toBe(before);
		expect(onUpdate).not.toHaveBeenCalled();
		add(reconciler, target);
		baseline(reconciler, [B, C]);
		expect(values(target)).toEqual(["b", "c"]);
	});

	it("delivers raw moves only in committed order without storing a materialized result", () => {
		const { reconciler, target } = setup([A, B, C], false);
		const onUpdate = vi.fn();
		target.onUpdate(onUpdate);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept(keyedResults("p", 0, "1", "1", [upsert(X, "x")]));
		reconciler.accept(
			keyedResults("p", 1, "1", "1", [move(X, null), move(B, X)]),
		);
		expect(onUpdate).not.toHaveBeenCalled();
		reconciler.accept(commit("p", 2));
		expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
			type: "changes",
			changes: [
				{ type: "upsert", rowId: X, row: { value: "x" } },
				{ type: "move", rowId: X, afterRowId: null },
				{ type: "move", rowId: B, afterRowId: X },
			],
			batch: { txids: ["7"] },
		});
		expect(target.getSnapshot().data).toBeUndefined();
	});

	it("raw validation rejects malformed move order split across fragments", () => {
		const { reconciler, target } = setup([A, B], false);
		const onUpdate = vi.fn();
		target.onUpdate(onUpdate);
		reconciler.accept({ type: "open", publication_id: "p" });
		reconciler.accept(keyedResults("p", 0, "1", "1", [move(B, null)]));
		reconciler.accept(keyedResults("p", 1, "1", "1", [upsert(A, "late")]));
		expect(() => reconciler.accept(commit("p", 2))).toThrow(
			"contents follow moves",
		);
		expect(onUpdate).not.toHaveBeenCalled();
	});
});
