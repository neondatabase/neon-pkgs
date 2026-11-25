import type { LiveQueryChange } from "@neon/realtime/client";

/** One TanStack DB write, keyed by the collection's own key. */
export type BatchWrite<Row, Key> =
	| { readonly type: "insert" | "update"; readonly value: Row }
	| { readonly type: "delete"; readonly key: Key };

/** The collection writes of one Realtime update, and how to record them. */
export interface BatchPlan<Row, Key> {
	readonly writes: readonly BatchWrite<Row, Key>[];
	/** Record the update's key ownership. It cannot fail. */
	commit(): void;
}

const REMOVED = Symbol("removed");

/**
 * Plan one Realtime `changes` update against the collection's key ownership.
 *
 * An update is atomic: only its final state is visible. Rows can exchange
 * collection keys within one update, as when two row IDs swap the values
 * `getKey` reads, so a key is a duplicate only if two rows still own it after
 * the whole update. Work and allocation are proportional to the update's
 * changes; `rowIds` and `keys` change only in {@link BatchPlan.commit}.
 */
export function planBatch<Row, Key extends string | number>(
	rowIds: Map<string, Key>,
	keys: Map<Key, string>,
	changes: readonly LiveQueryChange<Row>[],
	getKey: (row: Row) => Key,
): BatchPlan<Row, Key> {
	// Each touched row ID's final row, in the order of its last change.
	const final = new Map<string, Row | typeof REMOVED>();
	for (const change of changes) {
		// The collection ignores server order; moves keep contents and keys.
		if (change.type === "move") continue;
		if (change.type === "remove") {
			const shown = final.has(change.rowId)
				? final.get(change.rowId) !== REMOVED
				: rowIds.has(change.rowId);
			if (!shown) {
				throw new Error(
					`Realtime deleted an unknown row ID: ${change.rowId}`,
				);
			}
		}
		final.delete(change.rowId);
		final.set(
			change.rowId,
			change.type === "upsert" ? change.row : REMOVED,
		);
	}

	// Touched rows give up their old keys, then claim their final ones.
	const released = new Set<Key>();
	for (const rowId of final.keys()) {
		const key = rowIds.get(rowId);
		if (key !== undefined) released.add(key);
	}
	const claimed = new Map<Key, string>();
	const upserts: Array<{ readonly rowId: string; readonly key: Key }> = [];
	const writes: BatchWrite<Row, Key>[] = [];
	for (const [rowId, row] of final) {
		if (row === REMOVED) continue;
		const key = getKey(row);
		const owner =
			claimed.get(key) ?? (released.has(key) ? undefined : keys.get(key));
		if (owner !== undefined) {
			throw new Error(
				`Realtime upserted an existing key: ${String(key)}`,
			);
		}
		claimed.set(key, rowId);
		upserts.push({ rowId, key });
	}
	for (const key of released) {
		if (!claimed.has(key)) writes.push({ type: "delete", key });
	}
	for (const { rowId, key } of upserts) {
		const row = final.get(rowId) as Row;
		writes.push({ type: keys.has(key) ? "update" : "insert", value: row });
	}

	return {
		writes,
		commit: () => {
			for (const key of released) keys.delete(key);
			for (const [rowId, row] of final) {
				if (row === REMOVED) rowIds.delete(rowId);
			}
			for (const [key, rowId] of claimed) {
				rowIds.set(rowId, key);
				keys.set(key, rowId);
			}
		},
	};
}
