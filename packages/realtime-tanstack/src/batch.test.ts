import type { LiveQueryChange } from "@neon/realtime/client";
import { describe, expect, it } from "vitest";
import { planBatch } from "./batch.js";

type Row = { id: number; title: string };
const put = (
	rowId: string,
	id: number,
	title: string,
): LiveQueryChange<Row> => ({
	type: "upsert",
	rowId,
	row: { id, title },
});
const move = (
	rowId: string,
	afterRowId: string | null,
): LiveQueryChange<Row> => ({ type: "move", rowId, afterRowId });

function apply(
	initial: readonly [string, Row][],
	changes: readonly LiveQueryChange<Row>[],
) {
	const rowIds = new Map(initial.map(([rowId, row]) => [rowId, row.id]));
	const keys = new Map(initial.map(([rowId, row]) => [row.id, rowId]));
	const before = [...rowIds];
	const batch = planBatch(rowIds, keys, changes, (row) => row.id);
	expect([...rowIds]).toEqual(before);
	const collection = new Map(initial.map(([, row]) => [row.id, row]));
	for (const write of batch.writes) {
		if (write.type === "delete") {
			expect(collection.delete(write.key)).toBe(true);
		} else {
			expect(collection.has(write.value.id)).toBe(
				write.type === "update",
			);
			collection.set(write.value.id, write.value);
		}
	}
	return {
		batch,
		rows: [...collection.values()].sort((a, b) => a.id - b.id),
	};
}

describe("final-state batch key ownership", () => {
	it("renumbers an ordered round without duplicate keys (P11)", () => {
		const { batch, rows } = apply(
			[
				["1", { id: 10, title: "first" }],
				["2", { id: 11, title: "second" }],
				["3", { id: 12, title: "third" }],
				["d", { id: 20, title: "other" }],
			],
			[
				{ type: "remove", rowId: "3" },
				put("1", 11, "second"),
				put("2", 12, "third"),
				move("1", null),
				move("2", "1"),
			],
		);
		expect(rows).toEqual([
			{ id: 11, title: "second" },
			{ id: 12, title: "third" },
			{ id: 20, title: "other" },
		]);
		expect([...batch.rowIds]).toEqual([
			["1", 11],
			["2", 12],
			["d", 20],
		]);
	});

	it("swaps two rows' content keys in an ordered update (P1)", () => {
		const { rows, batch } = apply(
			[
				["b", { id: 1, title: "x" }],
				["c", { id: 2, title: "y" }],
			],
			[
				put("b", 2, "y2"),
				put("c", 1, "x2"),
				move("b", null),
				move("c", "b"),
			],
		);
		expect(rows).toEqual([
			{ id: 1, title: "x2" },
			{ id: 2, title: "y2" },
		]);
		expect(batch.keys).toEqual(
			new Map([
				[2, "b"],
				[1, "c"],
			]),
		);
	});

	it("accepts a merged covered handoff between surviving row IDs (P12)", () => {
		const { rows } = apply(
			[
				["a", { id: 1, title: "x" }],
				["b", { id: 2, title: "b" }],
				["c", { id: 3, title: "w" }],
			],
			[
				put("a", 3, "w"),
				put("c", 1, "x"),
				put("b", 2, "b2"),
				move("b", "a"),
			],
		);
		expect(rows).toEqual([
			{ id: 1, title: "x" },
			{ id: 2, title: "b2" },
			{ id: 3, title: "w" },
		]);
	});

	it("rejects a true final duplicate without changing the input maps", () => {
		const rowIds = new Map([
			["a", 1],
			["b", 2],
		]);
		const keys = new Map([
			[1, "a"],
			[2, "b"],
		]);
		expect(() =>
			planBatch(
				rowIds,
				keys,
				[put("a", 2, "duplicate")],
				(row) => row.id,
			),
		).toThrow("Realtime upserted an existing key: 2");
		expect([...rowIds]).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect([...keys]).toEqual([
			[1, "a"],
			[2, "b"],
		]);
	});

	it("accepts a temporary duplicate removed later in the batch", () => {
		const { rows } = apply(
			[
				["a", { id: 1, title: "old" }],
				["b", { id: 2, title: "b" }],
			],
			[put("a", 2, "new"), { type: "remove", rowId: "b" }],
		);
		expect(rows).toEqual([{ id: 2, title: "new" }]);
	});

	it("still rejects removal of an unknown row ID", () => {
		expect(() =>
			planBatch(
				new Map(),
				new Map(),
				[{ type: "remove", rowId: "missing" }],
				(row: Row) => row.id,
			),
		).toThrow("Realtime deleted an unknown row ID");
	});
});
