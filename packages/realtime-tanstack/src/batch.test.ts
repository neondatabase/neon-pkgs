import type { LiveQueryChange } from "@neon/realtime/client";
import { describe, expect, it } from "vitest";
import { planBatch } from "./batch.js";

interface Row {
	readonly id: number;
	readonly title: string;
}

const put = (rowId: string, id: number, title = `${id}`) =>
	({ type: "upsert", rowId, row: { id, title } }) as const;
const remove = (rowId: string) => ({ type: "remove", rowId }) as const;
const move = (rowId: string, afterRowId: string | null) =>
	({ type: "move", rowId, afterRowId }) as const;

/** Apply one update to a model collection the way the adapter does. */
function apply(
	initial: readonly (readonly [string, number])[],
	changes: readonly LiveQueryChange<Row>[],
) {
	const rowIds = new Map(initial);
	const keys = new Map(initial.map(([rowId, id]) => [id, rowId]));
	const collection = new Map(
		initial.map(([, id]) => [id, { id, title: `${id}` }]),
	);
	const plan = planBatch(rowIds, keys, changes, (row) => row.id);
	// Planning changes nothing; only commit records the new ownership.
	expect([...rowIds]).toEqual(initial);
	for (const write of plan.writes) {
		if (write.type === "delete") {
			expect(collection.delete(write.key)).toBe(true);
		} else {
			expect(collection.has(write.value.id)).toBe(
				write.type === "update",
			);
			collection.set(write.value.id, write.value);
		}
	}
	plan.commit();
	expect([...keys].sort()).toEqual(
		[...rowIds].map(([rowId, id]) => [id, rowId]).sort(),
	);
	return {
		rowIds: Object.fromEntries(rowIds),
		collection: [...collection.values()].sort((a, b) => a.id - b.id),
	};
}

describe("planBatch", () => {
	it("lets two row IDs swap their content keys in one update", () => {
		// A v2 tick: A and B exchange the values getKey reads.
		const { rowIds, collection } = apply(
			[
				["a", 1],
				["b", 2],
			],
			[put("a", 2, "a now"), put("b", 1, "b now")],
		);
		expect(rowIds).toEqual({ a: 2, b: 1 });
		expect(collection).toEqual([
			{ id: 1, title: "b now" },
			{ id: 2, title: "a now" },
		]);
	});

	it("rotates keys around a three-row cycle", () => {
		const { rowIds } = apply(
			[
				["a", 1],
				["b", 2],
				["c", 3],
			],
			[put("a", 2), put("b", 3), put("c", 1)],
		);
		expect(rowIds).toEqual({ a: 2, b: 3, c: 1 });
	});

	it("lets a row claim the key of a row the update removes", () => {
		const { rowIds, collection } = apply(
			[
				["a", 1],
				["b", 2],
			],
			[remove("a"), put("b", 1, "moved")],
		);
		expect(rowIds).toEqual({ b: 1 });
		expect(collection).toEqual([{ id: 1, title: "moved" }]);
	});

	it("renumbers a segment's rows in one update", () => {
		// Row keys keep their positions; the IDs they hold shift by one.
		const { rowIds, collection } = apply(
			[
				["k1", 11],
				["k2", 12],
				["k3", 13],
				["other", 20],
			],
			[remove("k3"), put("k1", 12), put("k2", 13), move("k1", null)],
		);
		expect(rowIds).toEqual({ k1: 12, k2: 13, other: 20 });
		expect(collection.map(({ id }) => id)).toEqual([12, 13, 20]);
	});

	it("treats a remove then an upsert of one row ID as its final upsert", () => {
		const { rowIds, collection } = apply(
			[["a", 1]],
			[remove("a"), put("a", 2)],
		);
		expect(rowIds).toEqual({ a: 2 });
		expect(collection.map(({ id }) => id)).toEqual([2]);
	});

	it("rejects a key two rows still own after the update, without changes", () => {
		const rowIds = new Map([
			["a", 1],
			["b", 2],
		]);
		const keys = new Map([
			[1, "a"],
			[2, "b"],
		]);
		expect(() =>
			planBatch(rowIds, keys, [put("a", 2)], (row) => row.id),
		).toThrow("Realtime upserted an existing key: 2");
		expect(() =>
			planBatch(
				rowIds,
				keys,
				[put("c", 3), put("d", 3)],
				(row) => row.id,
			),
		).toThrow("Realtime upserted an existing key: 3");
		expect([...rowIds]).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect([...keys]).toEqual([
			[1, "a"],
			[2, "b"],
		]);
	});

	it("rejects a remove of a row ID that is not shown at that point", () => {
		const rowIds = new Map([["a", 1]]);
		const keys = new Map([[1, "a"]]);
		const plan = (changes: readonly LiveQueryChange<Row>[]) =>
			planBatch(rowIds, keys, changes, (row) => row.id);
		expect(() => plan([remove("x")])).toThrow(
			"Realtime deleted an unknown row ID: x",
		);
		expect(() => plan([remove("a"), remove("a")])).toThrow(
			"Realtime deleted an unknown row ID: a",
		);
		expect(plan([put("x", 2), remove("x")]).writes).toEqual([]);
	});

	it("ignores moves", () => {
		expect(
			apply(
				[
					["a", 1],
					["b", 2],
				],
				[move("b", null)],
			).rowIds,
		).toEqual({ a: 1, b: 2 });
	});
});
