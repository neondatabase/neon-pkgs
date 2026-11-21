import type { LiveQueryChange } from "@neon/realtime/client";

/** Writes keyed by the collection's contents, after final ownership is known. */
type BatchWrite<Row, Key> =
	| { type: "insert" | "update"; value: Row }
	| { type: "delete"; key: Key };

/** Stage a complete update before checking keys or emitting collection writes. */
export function planBatch<Row, Key extends string | number>(
	rowIds: ReadonlyMap<string, Key>,
	keys: ReadonlyMap<Key, string>,
	changes: readonly LiveQueryChange<Row>[],
	getKey: (row: Row) => Key,
): {
	rowIds: Map<string, Key>;
	keys: Map<Key, string>;
	writes: BatchWrite<Row, Key>[];
} {
	const nextRowIds = new Map(rowIds);
	const changedRows = new Map<string, Row>();
	for (const change of changes) {
		// This collection ignores server order; moves retain contents and keys.
		if (change.type === "move") continue;
		if (change.type === "upsert") {
			nextRowIds.set(change.rowId, getKey(change.row));
			changedRows.set(change.rowId, change.row);
		} else {
			if (!nextRowIds.delete(change.rowId)) {
				throw new Error(
					`Realtime deleted an unknown row ID: ${change.rowId}`,
				);
			}
			changedRows.delete(change.rowId);
		}
	}

	// Row IDs can exchange content keys during a round or ordinary tick.
	// Only two owners in the final result constitute a duplicate.
	const nextKeys = new Map<Key, string>();
	for (const [rowId, key] of nextRowIds) {
		if (nextKeys.has(key)) {
			throw new Error(
				`Realtime upserted an existing key: ${String(key)}`,
			);
		}
		nextKeys.set(key, rowId);
	}
	const writes: BatchWrite<Row, Key>[] = [];
	for (const key of keys.keys()) {
		if (!nextKeys.has(key)) writes.push({ type: "delete", key });
	}
	for (const [rowId, row] of changedRows) {
		const key = nextRowIds.get(rowId) as Key;
		writes.push({ type: keys.has(key) ? "update" : "insert", value: row });
	}
	return { rowIds: nextRowIds, keys: nextKeys, writes };
}
