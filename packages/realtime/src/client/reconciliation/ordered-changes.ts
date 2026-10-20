import { ProtocolError } from "../protocol/codec.js";
import type { WireChange } from "../protocol/messages.js";
import type { LiveQueryChange } from "../types.js";

/** Validate one complete program, after public-body fragments are joined. */
export function validateChangeOrder(changes: readonly WireChange[]): void {
	const moved = new Set<string>();
	const predecessors = new Set<string | null>();
	const removed = new Set<string>();
	let placements = false;
	for (const change of changes) {
		if (change.op !== "move") {
			if (placements) throw new ProtocolError("contents follow moves");
			if (change.op === "remove") removed.add(change.row_key);
			continue;
		}
		placements = true;
		if (change.row_key === change.after_row_key) {
			throw new ProtocolError("move anchors itself");
		}
		if (moved.has(change.row_key)) {
			throw new ProtocolError("duplicate moved row key");
		}
		if (predecessors.has(change.after_row_key)) {
			throw new ProtocolError("conflicting move predecessors");
		}
		moved.add(change.row_key);
		predecessors.add(change.after_row_key);
	}
	if (!placements) return;
	// Ordinary unordered programs retain their existing content semantics. A
	// program with placements must be normalized before applying any of them.
	const placed = new Set<string>();
	const seenContents = new Set<string>();
	for (const change of changes) {
		if (change.op !== "move") {
			if (seenContents.has(change.row_key)) {
				throw new ProtocolError("duplicate content row key");
			}
			seenContents.add(change.row_key);
			continue;
		}
		const anchor = change.after_row_key;
		if (
			removed.has(change.row_key) ||
			(anchor !== null && removed.has(anchor))
		) {
			throw new ProtocolError("move references a removed row");
		}
		if (anchor !== null && moved.has(anchor) && !placed.has(anchor)) {
			throw new ProtocolError("moved anchor is placed later");
		}
		placed.add(change.row_key);
	}
}

interface Link<Row> {
	readonly rowId: string;
	readonly row: Row;
	previous: Link<Row> | null;
	next: Link<Row> | null;
}

/** Reduce a private candidate; Map iteration is the materialized result order. */
export function applyMaterializedChanges<Row>(
	rows: Map<string, Row>,
	changes: readonly LiveQueryChange<Row>[],
): Map<string, Row> {
	for (const change of changes) {
		if (change.type === "remove") rows.delete(change.rowId);
		else if (change.type === "upsert") rows.set(change.rowId, change.row);
	}
	if (!changes.some((change) => change.type === "move")) return rows;

	// A temporary linked order makes each splice constant-time. Build the
	// resulting Map once, rather than searching and splicing an array per move.
	const links = new Map<string, Link<Row>>();
	let head: Link<Row> | null = null;
	let tail: Link<Row> | null = null;
	for (const [rowId, row] of rows) {
		const link: Link<Row> = { rowId, row, previous: tail, next: null };
		links.set(rowId, link);
		if (tail === null) head = link;
		else tail.next = link;
		tail = link;
	}
	for (const change of changes) {
		if (change.type !== "move") continue;
		const link = links.get(change.rowId);
		const anchor =
			change.afterRowId === null ? null : links.get(change.afterRowId);
		if (!link) throw new ProtocolError("move references a missing row");
		if (anchor === undefined)
			throw new ProtocolError("move references a missing anchor");
		if (link.previous === anchor) continue;
		if (link.previous === null) head = link.next;
		else link.previous.next = link.next;
		if (link.next !== null) link.next.previous = link.previous;

		const successor = anchor === null ? head : anchor.next;
		link.previous = anchor;
		link.next = successor;
		if (anchor === null) head = link;
		else anchor.next = link;
		if (successor !== null) successor.previous = link;
	}
	const ordered = new Map<string, Row>();
	for (let link = head; link !== null; link = link.next)
		ordered.set(link.rowId, link.row);
	return ordered;
}
