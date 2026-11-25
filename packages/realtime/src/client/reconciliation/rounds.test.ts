import { describe, expect, it } from "vitest";

import { ProtocolError } from "../protocol/codec.js";
import type { LiveQueryChange } from "../types.js";
import {
	flush,
	key,
	move,
	mvccThrough,
	RawConsumer,
	remove,
	Session,
	TxidWatch,
	upsert,
	type Value,
	values,
	wireRow,
} from "./rounds.test-helpers.js";

const A = key("a");
const B = key("b");
const C = key("c");
const D = key("d");
const E = key("e");
const T1 = key("1");
const T2 = key("2");

/** A live query showing `rows`, with a raw consumer beside it. */
function live(
	rows: readonly ReturnType<typeof wireRow>[],
	materialized = true,
) {
	const session = new Session();
	const subscription = session.subscribe("1", materialized);
	const raw = new RawConsumer(subscription);
	session.sync("1", { attempt: 1, batches: [rows] });
	return { session, subscription, raw };
}

function describeChanges(changes: readonly LiveQueryChange<Value>[]): string[] {
	return changes.map((change) =>
		change.type === "upsert"
			? `upsert ${change.rowId[0]}=${change.row.value}`
			: change.type === "remove"
				? `remove ${change.rowId[0]}`
				: `move ${change.rowId[0]} after ${change.afterRowId?.[0] ?? "head"}`,
	);
}

function lastChanges(raw: RawConsumer): string[] {
	const update = raw.updates.at(-1);
	if (update?.type !== "changes") throw new Error("no changes update");
	return describeChanges(update.changes);
}

describe("segment rounds", () => {
	it("replaces only the scope's rows, keeping rows covered patches move out", () => {
		const { session, subscription, raw } = live([
			wireRow(A, "a", T1),
			wireRow(B, "b", T1),
			wireRow(C, "c", T2),
		]);
		// Tick 1 dirties T1 and moves B out of it; tick 2 moves C into T1.
		session.tick(
			[{ liveId: "1", changes: [upsert(B, "b2", T2)], hole: true }],
			11,
		);
		session.tick([{ liveId: "1", changes: [upsert(C, "c2", T1)] }], 12);
		expect(values(subscription).sort()).toEqual(["a", "b", "c"]);
		session.sync("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [1, 2],
			mvcc: mvccThrough(12),
			batches: [[wireRow(A, "a3", T1), wireRow(C, "c3", T1)]],
		});
		expect(values(subscription).sort()).toEqual(["a3", "b2", "c3"]);
		expect(raw.values().sort()).toEqual(["a3", "b2", "c3"]);
		// Unordered: every touched visible row is removed, then upserted.
		expect(lastChanges(raw)).toEqual([
			"remove b",
			"remove c",
			"remove a",
			"upsert b=b2",
			"upsert c=c3",
			"upsert a=a3",
		]);
	});

	it("keeps a row a covered patch moves from a one-row segment into an unselected tag", () => {
		const { session, subscription } = live([
			wireRow(A, "a"),
			wireRow(B, "b", T1),
		]);
		session.tick([{ liveId: "1", hole: true }], 11);
		session.tick([{ liveId: "1", changes: [upsert(A, "a2", T2)] }], 12);
		// A row_key selector names only an untagged row; A is now tagged.
		session.sync("1", {
			attempt: 2,
			selectors: [{ row_key: A }],
			covered: [1, 2],
			mvcc: mvccThrough(12),
			batches: [],
		});
		expect(values(subscription).sort()).toEqual(["a2", "b"]);
	});

	it("lets a row_key selector name only an untagged row", () => {
		const { session, subscription } = live([
			wireRow(A, "a", T1),
			wireRow(B, "b"),
		]);
		session.tick([{ liveId: "1", hole: true }], 11);
		// A carries a tag, so a row_key selector for it names no row.
		session.sync("1", {
			attempt: 2,
			selectors: [{ row_key: A }, { row_key: B }],
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [],
		});
		expect(values(subscription)).toEqual(["a"]);
	});

	it("never removes a row the raw consumer was not shown", () => {
		const { session, raw } = live([wireRow(A, "a")], false);
		session.tick([{ liveId: "1", hole: true }], 11);
		session.tick(
			[{ liveId: "1", changes: [upsert(B, "b", T1), remove(B)] }],
			12,
		);
		session.sync("1", {
			attempt: 2,
			selectors: [{ row_key: C }, { segment_tag: T1 }],
			covered: [1, 2],
			mvcc: mvccThrough(12),
			batches: [],
		});
		expect(lastChanges(raw)).toEqual([]);
		expect(raw.values()).toEqual(["a"]);
	});

	it.each([
		true,
		false,
	])("installs a first baseline up to a hole that arrived during it (materialized: %s)", (materialized) => {
		const session = new Session();
		const subscription = session.subscribe("1", materialized);
		const raw = new RawConsumer(subscription);
		session.start("1", { attempt: 1 });
		session.tick([{ liveId: "1", changes: [upsert(B, "b")] }], 11);
		session.tick([{ liveId: "1", hole: true }], 12);
		session.tick([{ liveId: "1", changes: [upsert(C, "c")] }], 13);
		session.batch("1", 1, 0, [wireRow(A, "a", T1)]);
		session.end("1", 1, 1);
		expect(raw.values().sort()).toEqual(["a", "b"]);
		session.sync("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [2, 3],
			mvcc: mvccThrough(13),
			batches: [[wireRow(A, "a2", T1)]],
		});
		expect(raw.values().sort()).toEqual(["a2", "b", "c"]);
		if (materialized) {
			expect(values(subscription).sort()).toEqual(["a2", "b", "c"]);
		}
	});

	it("resolves awaitTxId for held ticks only when the round installs", async () => {
		const { session, subscription } = live([wireRow(A, "a", T1)]);
		const txids = new TxidWatch(subscription);
		for (const txid of [11, 12, 13]) txids.watch(txid);
		session.tick([{ liveId: "1", hole: true }], 11);
		session.tick([{ liveId: "1", changes: [upsert(B, "b")] }], 12);
		session.progress(12);
		await flush();
		expect([...txids.resolved]).toEqual([]);
		session.sync("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [],
		});
		await flush();
		// Tick 2 is a later tick; the held proof is released with it.
		expect([...txids.resolved].sort()).toEqual([11, 12]);
	});

	it("releases a held proof that covers a transaction no tick carries", async () => {
		const { session, subscription } = live([wireRow(A, "a", T1)]);
		const txids = new TxidWatch(subscription);
		txids.watch(13);
		session.tick([{ liveId: "1", hole: true }], 11);
		session.tick([{ liveId: "1", changes: [upsert(B, "b")] }], 12);
		// Transaction 13 committed without changing this query's rows.
		session.progress(13);
		await flush();
		expect(txids.resolved.has(13)).toBe(false);
		session.sync("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [],
		});
		await flush();
		expect(txids.resolved.has(13)).toBe(true);
	});

	it("publishes later ticks as their own updates and stops at the next hole", async () => {
		const { session, subscription, raw } = live([wireRow(A, "a", T1)]);
		const txids = new TxidWatch(subscription);
		for (const txid of [11, 12, 13, 14]) txids.watch(txid);
		const snapshots: unknown[] = [];
		subscription.onChange((snapshot) => snapshots.push(snapshot));
		session.tick([{ liveId: "1", hole: true }], 11);
		session.tick([{ liveId: "1", changes: [upsert(B, "b")] }], 12);
		session.tick([{ liveId: "1", hole: true }], 13);
		session.progress(13);
		session.tick([{ liveId: "1", changes: [upsert(C, "c")] }], 14);
		const before = raw.updates.length;
		session.sync("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [[wireRow(A, "a2", T1)]],
		});
		await flush();
		expect(raw.updates.length - before).toBe(2);
		expect(raw.values().sort()).toEqual(["a2", "b"]);
		expect([...txids.resolved].sort()).toEqual([11, 12]);
		// One install, so every notification carries the same snapshot.
		expect(new Set(snapshots).size).toBe(1);
		session.sync("1", {
			attempt: 3,
			selectors: [{ segment_tag: T1 }],
			covered: [3, 4],
			mvcc: mvccThrough(14),
			batches: [],
		});
		await flush();
		expect(raw.values().sort()).toEqual(["b", "c"]);
		expect([...txids.resolved].sort()).toEqual([11, 12, 13, 14]);
	});

	it("holds progress only for the live query with an unresolved hole", async () => {
		const session = new Session();
		const held = session.subscribe("1");
		const shown = session.subscribe("2");
		session.sync("1", { attempt: 1, batches: [[wireRow(A, "a", T1)]] });
		session.sync("2", { attempt: 1, batches: [[wireRow(A, "a")]] });
		const heldTxids = new TxidWatch(held);
		const shownTxids = new TxidWatch(shown);
		heldTxids.watch(11);
		shownTxids.watch(11);
		session.tick(
			[
				{ liveId: "1", hole: true },
				{ liveId: "2", changes: [upsert(A, "a2")] },
			],
			11,
		);
		session.progress(11);
		await flush();
		expect([...shownTxids.resolved]).toEqual([11]);
		expect([...heldTxids.resolved]).toEqual([]);
		expect(values(held)).toEqual(["a"]);
	});

	it("drops an earlier attempt's rows when a retry supersedes it", () => {
		const { session, subscription } = live([wireRow(A, "a", T1)]);
		session.tick([{ liveId: "1", hole: true }], 11);
		const round = {
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1] as const,
			mvcc: mvccThrough(11),
		};
		session.sync("1", {
			...round,
			attempt: 2,
			batches: [[wireRow(B, "stale", T1)]],
			end: false,
		});
		session.sync("1", {
			...round,
			attempt: 3,
			batches: [[wireRow(A, "a2", T1)]],
		});
		expect(values(subscription)).toEqual(["a2"]);
	});

	it("ignores frames of an older attempt, as v2 does", () => {
		const { session, subscription } = live([wireRow(A, "a", T1)]);
		session.tick([{ liveId: "1", hole: true }], 11);
		const round = {
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1] as const,
			mvcc: mvccThrough(11),
		};
		session.start("1", { ...round, attempt: 3 });
		session.sync("1", {
			...round,
			attempt: 2,
			batches: [[wireRow(B, "stale", T1)]],
		});
		session.batch("1", 3, 0, [wireRow(A, "a2", T1)]);
		session.end("1", 3, 1);
		expect(values(subscription)).toEqual(["a2"]);
	});

	it("discards held ticks and the staged round at a reset, keeping old rows until the new baseline", () => {
		const { session, subscription } = live([wireRow(A, "a", T1)]);
		session.tick([{ liveId: "1", hole: true }], 11);
		session.start("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1],
			mvcc: mvccThrough(11),
		});
		session.reset("1");
		expect(values(subscription)).toEqual(["a"]);
		session.sync("1", { attempt: 1, batches: [[wireRow(B, "b")]] });
		expect(values(subscription)).toEqual(["b"]);
	});

	it("installs a hole whose txid list is longer than the engine allows as call arguments", () => {
		const count = argumentSpreadLimit();
		const { session, raw } = live([wireRow(A, "a", T1)], false);
		const txids = Array.from({ length: count }, (_, index) =>
			String(index + 1),
		);
		session.receive({ type: "open", publication_id: "big" });
		session.receive({
			type: "segments_pending",
			publication_id: "big",
			index: 0,
			txids,
			targets: [{ live_id: "1", epoch: "1", sequence: "1" }],
		});
		session.receive({
			type: "commit",
			publication_id: "big",
			body_count: 1,
			frontier: { lsn: "0/10" },
		});
		session.sync("1", {
			attempt: 2,
			selectors: [{ segment_tag: T1 }],
			covered: [1, 1],
			mvcc: mvccThrough(count),
			batches: [[wireRow(A, "a2", T1)]],
		});
		const update = raw.updates.at(-1);
		expect(update?.type === "changes" && update.batch.txids.length).toBe(
			count,
		);
		expect(raw.values()).toEqual(["a2"]);
	});

	describe("ordered rounds", () => {
		it.each([
			true,
			false,
		])("places rows by their anchors, keeping kept keys' upserts (materialized: %s)", (materialized) => {
			const { session, subscription, raw } = live(
				[
					wireRow(A, "a"),
					wireRow(B, "b", T1),
					wireRow(C, "c", T1),
					wireRow(D, "d"),
				],
				materialized,
			);
			session.tick([{ liveId: "1", hole: true }], 11);
			// The new result is A, E, C, D: B leaves, E enters after A, C stays.
			session.sync("1", {
				attempt: 2,
				selectors: [{ segment_tag: T1 }],
				covered: [1, 1],
				ordered: true,
				mvcc: mvccThrough(11),
				batches: [[wireRow(E, "e", T1, A)], [wireRow(C, "c2", T1)]],
			});
			expect(lastChanges(raw)).toEqual([
				"remove b",
				"upsert c=c2",
				"upsert e=e",
				"move e after a",
				"move c after e",
			]);
			expect(raw.values()).toEqual(["a", "e", "c2", "d"]);
			if (materialized) {
				expect(values(subscription)).toEqual(["a", "e", "c2", "d"]);
			}
		});

		it("publishes a later tick with a move after an empty round", () => {
			const { session, raw } = live(
				[wireRow(A, "a"), wireRow(B, "b", T1), wireRow(C, "c")],
				false,
			);
			session.tick([{ liveId: "1", hole: true }], 11);
			session.tick(
				[{ liveId: "1", changes: [upsert(D, "d"), move(D, null)] }],
				12,
			);
			session.sync("1", {
				attempt: 2,
				selectors: [{ segment_tag: T1 }],
				covered: [1, 1],
				ordered: true,
				mvcc: mvccThrough(11),
				batches: [],
			});
			expect(raw.values()).toEqual(["d", "a", "c"]);
		});
	});

	describe("rejects", () => {
		const reject = (run: () => void, message: string) =>
			expect(run).toThrow(new ProtocolError(message));

		it("a selected start without an unresolved hole, or before the first baseline", () => {
			const { session } = live([wireRow(A, "a", T1)]);
			reject(
				() =>
					session.start("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 1],
					}),
				"invalid covered range",
			);
			const fresh = new Session();
			fresh.subscribe("1");
			reject(
				() =>
					fresh.start("1", {
						attempt: 1,
						selectors: [{ segment_tag: T1 }],
					}),
				"invalid baseline sync start",
			);
		});

		it.each([
			["starting after the first hole", [3, 3]],
			["through a tick not yet received", [2, 4]],
			["ending before it starts", [2, 1]],
		] as const)("a covered range %s", (_name, covered) => {
			const { session } = live([wireRow(A, "a", T1)]);
			session.tick([{ liveId: "1", changes: [upsert(B, "b")] }], 11);
			session.tick([{ liveId: "1", hole: true }], 12);
			session.tick([{ liveId: "1", hole: true }], 13);
			reject(
				() =>
					session.start("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered,
					}),
				"invalid covered range",
			);
		});

		it("an all start while live", () => {
			const { session } = live([wireRow(A, "a")]);
			reject(
				() => session.start("1", { attempt: 2 }),
				"invalid baseline sync start",
			);
		});

		it("a round row outside the scope, including a tagged row named by row key", () => {
			const { session } = live([wireRow(A, "a", T1)]);
			session.tick([{ liveId: "1", hole: true }], 11);
			session.start("1", {
				attempt: 2,
				selectors: [{ segment_tag: T1 }, { row_key: B }],
				covered: [1, 1],
			});
			reject(
				() => session.batch("1", 2, 0, [wireRow(B, "b", T2)]),
				"a round row is outside its scope",
			);
		});

		it("a round row shown under an unselected tag after the covered ticks", () => {
			const { session } = live([wireRow(A, "a", T2)]);
			session.tick([{ liveId: "1", hole: true }], 11);
			reject(
				() =>
					session.sync("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 1],
						batches: [[wireRow(A, "a2", T1)]],
					}),
				"a round row is shown outside its scope",
			);
		});

		it("a move in a covered tick", () => {
			const { session } = live([wireRow(A, "a"), wireRow(B, "b")]);
			session.tick([{ liveId: "1", hole: true }], 11);
			session.tick([{ liveId: "1", changes: [move(B, null)] }], 12);
			reject(
				() =>
					session.sync("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 2],
						ordered: true,
						batches: [],
					}),
				"a covered tick carries a move",
			);
		});

		it.each([
			["scope", { selectors: [{ segment_tag: T2 }] }],
			["covered range", { covered: [1, 2] as const }],
			["ordering", { ordered: true }],
			["snapshot", { mvcc: mvccThrough(20) }],
		])("a retry that changes its plan's %s", (_name, change) => {
			const { session } = live([wireRow(A, "a", T1)]);
			session.tick([{ liveId: "1", hole: true }], 11);
			session.tick([{ liveId: "1", hole: true }], 12);
			const round = {
				selectors: [{ segment_tag: T1 }],
				covered: [1, 1] as const,
				mvcc: mvccThrough(11),
			};
			session.start("1", { ...round, attempt: 2 });
			reject(
				() => session.start("1", { ...round, ...change, attempt: 3 }),
				"a retry changed its round's plan",
			);
		});

		it("a selected round that changes the live ID's ordering after a reset", () => {
			const { session } = live([wireRow(A, "a", T1)]);
			session.tick([{ liveId: "1", hole: true }], 11);
			session.sync("1", {
				attempt: 2,
				selectors: [{ segment_tag: T1 }],
				covered: [1, 1],
				ordered: true,
				batches: [],
			});
			session.reset("1");
			session.sync("1", { attempt: 1, batches: [[wireRow(A, "a", T1)]] });
			session.tick([{ liveId: "1", hole: true }], 12);
			reject(
				() =>
					session.start("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 1],
					}),
				"a selected round changed its ordering",
			);
		});

		it.each([
			[true, false],
			[true, true],
			[false, false],
			[false, true],
		])("an ordered round that does not place a row its covered ticks removed, re-added and retagged out of scope (materialized: %s, returns rows: %s)", (materialized, returnsRows) => {
			const { session } = live(
				[wireRow(B, "b"), wireRow(A, "a", T1)],
				materialized,
			);
			// A was shown, so only its history says it needs a placement.
			session.tick(
				[{ liveId: "1", changes: [remove(A)], hole: true }],
				11,
			);
			session.tick([{ liveId: "1", changes: [upsert(A, "a2", T1)] }], 12);
			session.tick([{ liveId: "1", changes: [upsert(A, "a3", T2)] }], 13);
			reject(
				() =>
					session.sync("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 3],
						ordered: true,
						batches: returnsRows ? [[wireRow(C, "c", T1, B)]] : [],
					}),
				"an ordered round shows a row it does not place",
			);
		});

		it("an empty ordered round whose covered tick adds a row outside its scope", () => {
			const { session } = live([wireRow(A, "a")]);
			session.tick(
				[{ liveId: "1", changes: [upsert(B, "b", T2)], hole: true }],
				11,
			);
			reject(
				() =>
					session.sync("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 1],
						ordered: true,
						batches: [],
					}),
				"an ordered round shows a row it does not place",
			);
		});

		it("an anchor missing after the scope removal, on a raw subscription", () => {
			const { session } = live(
				[wireRow(A, "a", T1), wireRow(B, "b", T1)],
				false,
			);
			session.tick([{ liveId: "1", hole: true }], 11);
			// A is in the scope and the round does not return it.
			reject(
				() =>
					session.sync("1", {
						attempt: 2,
						selectors: [{ segment_tag: T1 }],
						covered: [1, 1],
						ordered: true,
						batches: [[wireRow(B, "b2", T1, A)]],
					}),
				"round placement references a missing anchor",
			);
		});
	});
});

/** The smallest power-of-two array size this engine can't spread as arguments. */
function argumentSpreadLimit(): number {
	for (let size = 1; ; size *= 2) {
		try {
			Array.prototype.push.apply([], new Array(size));
		} catch (error) {
			if (error instanceof RangeError) return size;
			throw error;
		}
	}
}
