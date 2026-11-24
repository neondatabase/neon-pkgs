import type { ParsedMvccSnapshot } from "../mvcc.js";
import { ProtocolError } from "../protocol/codec.js";
import type { WireChange, WireRow } from "../protocol/messages.js";
import type { Scope } from "../protocol/wire-types.gen.js";
import { validateChangeOrder } from "./ordered-changes.js";
import type { ReconciledBatch } from "./reconciler.js";

type SelectedScope = Extract<Scope, { kind: "selected" }>;

/** A committed tick that the live query does not show yet. */
export interface BufferedTick {
	readonly batch: ReconciledBatch;
	/** The tick committed a hole: some of its rows arrive in a round. */
	readonly hole: boolean;
	/** Progress received after this tick, held until an install shows it. */
	proof?: ParsedMvccSnapshot;
}

/** A multi-row segment: its tag and the visible row keys that carry it. */
interface Segment {
	readonly tag: string;
	readonly keys: Set<string>;
}

/**
 * The visible row keys of one live query, each with its segment.
 *
 * Rows of one multi-row segment share one {@link Segment}, so a tag is stored
 * once however many rows carry it, and a round finds a segment's rows without
 * scanning the result. A row without a tag maps to null. Raw subscriptions
 * keep this too: they retain no rows, but a round must name exactly the rows it
 * removes.
 */
export class Membership {
	private readonly members = new Map<string, Segment | null>();
	private readonly segments = new Map<string, Segment>();

	has(rowKey: string): boolean {
		return this.members.has(rowKey);
	}

	/** Show only these rows. */
	reset(rows: readonly WireRow[]): void {
		this.members.clear();
		this.segments.clear();
		for (const row of rows) this.set(row.row_key, row.segment_tag);
	}

	/** Apply one program's contents. A move keeps the row's segment. */
	apply(changes: readonly WireChange[]): void {
		for (const change of changes) {
			if (change.op === "upsert") {
				this.set(change.row_key, change.segment_tag);
			} else if (change.op === "remove") {
				this.delete(change.row_key);
			}
		}
	}

	/** The visible row keys a scope removes, before any covered tick. */
	*selected(plan: RoundPlan): Iterable<string> {
		for (const tag of plan.tags) yield* this.segments.get(tag)?.keys ?? [];
		for (const rowKey of plan.rowKeys) {
			if (this.members.get(rowKey) === null) yield rowKey;
		}
	}

	private set(rowKey: string, tag: string | undefined): void {
		const current = this.members.get(rowKey);
		if (current !== undefined && current?.tag === tag) return;
		this.delete(rowKey);
		if (tag === undefined) {
			this.members.set(rowKey, null);
			return;
		}
		let segment = this.segments.get(tag);
		if (!segment) {
			segment = { tag, keys: new Set() };
			this.segments.set(tag, segment);
		}
		segment.keys.add(rowKey);
		this.members.set(rowKey, segment);
	}

	private delete(rowKey: string): void {
		const segment = this.members.get(rowKey);
		if (segment === undefined) return;
		this.members.delete(rowKey);
		if (segment === null) return;
		segment.keys.delete(rowKey);
		if (segment.keys.size === 0) this.segments.delete(segment.tag);
	}
}

/** What a selected round replaces, the holes it resolves, and its snapshot. */
export interface RoundPlan {
	readonly tags: ReadonlySet<string>;
	readonly rowKeys: ReadonlySet<string>;
	/** The first unresolved hole the round covers. */
	readonly from: bigint;
	/** The last tick the round covers: the tick of its snapshot. */
	readonly through: bigint;
	readonly ordered: boolean;
	readonly mvcc: ParsedMvccSnapshot;
}

export function roundPlan(
	scope: SelectedScope,
	mvcc: ParsedMvccSnapshot,
): RoundPlan {
	const tags = new Set<string>();
	const rowKeys = new Set<string>();
	for (const selector of scope.selectors) {
		if ("segment_tag" in selector) tags.add(selector.segment_tag);
		else rowKeys.add(selector.row_key);
	}
	return {
		tags,
		rowKeys,
		from: BigInt(scope.covered.from_sequence),
		through: BigInt(scope.covered.through_sequence),
		ordered: scope.ordered === true,
		mvcc,
	};
}

/** A retry repeats its round's scope, covered range, ordering and snapshot. */
export function samePlan(left: RoundPlan, right: RoundPlan): boolean {
	return (
		sameSet(left.tags, right.tags) &&
		sameSet(left.rowKeys, right.rowKeys) &&
		left.from === right.from &&
		left.through === right.through &&
		left.ordered === right.ordered &&
		left.mvcc.xmin === right.mvcc.xmin &&
		left.mvcc.xmax === right.mvcc.xmax &&
		sameSet(new Set(left.mvcc.xip), new Set(right.mvcc.xip))
	);
}

/**
 * Whether a row with this key and tag belongs to the round's scope. A tagged
 * row belongs only by its tag, and an untagged row only by its row key, so a
 * row a covered patch moved into a segment the round does not name survives.
 */
export function inScope(
	plan: RoundPlan,
	rowKey: string,
	tag: string | undefined,
): boolean {
	return tag === undefined ? plan.rowKeys.has(rowKey) : plan.tags.has(tag);
}

export interface RoundInstall {
	/** One ordinary update: the covered ticks and the round, merged. */
	readonly batch: ReconciledBatch;
	/** Later buffered ticks up to the next hole, each its own update. */
	readonly later: readonly BufferedTick[];
	/** How many buffered ticks, from the first, the install shows. */
	readonly shown: number;
}

type Upsert = Extract<WireChange, { op: "upsert" }>;

interface Touched {
	/** The row's final contents, or null when the install removes it. */
	readonly upsert: Upsert | null;
	/**
	 * The row keeps a position: it was shown before the install and never
	 * left, or it is a row of the round, which places it.
	 */
	readonly placed: boolean;
}

/**
 * Compile a selected round into ordinary programs, without changing anything.
 *
 * Starting from the visible result, it applies the `covered` buffered ticks,
 * removes the scope's rows, and inserts the round's rows. The round's update
 * removes every touched visible row before upserting, so a consumer that keys
 * rows by their contents never sees one key held twice. An ordered round
 * instead removes only rows that leave and places each of its rows with a
 * `move`, because v2's move rules allow one content change per row key. Work
 * is proportional to the covered changes, the scope's rows and the round's
 * rows.
 */
export function planInstall(
	members: Membership,
	backlog: readonly BufferedTick[],
	covered: number,
	plan: RoundPlan,
	rows: readonly WireRow[],
): RoundInstall {
	const touched = new Map<string, Touched>();
	const shown = (rowKey: string) => {
		const entry = touched.get(rowKey);
		return entry === undefined
			? members.has(rowKey)
			: entry.upsert !== null;
	};
	const txids: string[] = [];
	for (const tick of backlog.slice(0, covered)) {
		for (const change of tick.batch.changes) {
			if (change.op === "move") {
				throw new ProtocolError("a covered tick carries a move");
			}
			const entry = touched.get(change.row_key);
			touched.set(change.row_key, {
				upsert: change.op === "upsert" ? change : null,
				placed:
					change.op === "upsert" &&
					(entry === undefined
						? members.has(change.row_key)
						: entry.upsert !== null && entry.placed),
			});
		}
		// A tick's txids are wire-sized; spreading them as arguments can exceed
		// the engine's argument limit.
		for (const txid of tick.batch.txids) txids.push(txid);
	}

	// Remove the scope's rows, judged by their segment after the covered ticks.
	for (const rowKey of members.selected(plan)) {
		if (!touched.has(rowKey)) {
			touched.set(rowKey, { upsert: null, placed: false });
		}
	}
	for (const [rowKey, entry] of touched) {
		if (
			entry.upsert !== null &&
			inScope(plan, rowKey, entry.upsert.segment_tag)
		) {
			touched.set(rowKey, { upsert: null, placed: false });
		}
	}

	const moves: WireChange[] = [];
	let previous: string | null = null;
	for (const row of rows) {
		if (shown(row.row_key)) {
			throw new ProtocolError("a round row is shown outside its scope");
		}
		if (plan.ordered) {
			const anchor = row.after_row_key ?? previous;
			if (anchor !== null && !shown(anchor)) {
				throw new ProtocolError(
					"round placement references a missing anchor",
				);
			}
			moves.push(
				Object.freeze({
					op: "move",
					row_key: row.row_key,
					after_row_key: anchor,
				}),
			);
			previous = row.row_key;
		}
		touched.set(row.row_key, {
			upsert: Object.freeze({
				op: "upsert",
				row_key: row.row_key,
				values: row.values,
				...(row.segment_tag === undefined
					? {}
					: { segment_tag: row.segment_tag }),
			}),
			placed: true,
		});
	}

	const removes: WireChange[] = [];
	const upserts: WireChange[] = [];
	for (const [rowKey, entry] of touched) {
		if (plan.ordered && entry.upsert !== null && !entry.placed) {
			throw new ProtocolError(
				"an ordered round shows a row it does not place",
			);
		}
		if (members.has(rowKey) && (entry.upsert === null || !plan.ordered)) {
			removes.push(Object.freeze({ op: "remove", row_key: rowKey }));
		}
		if (entry.upsert !== null) upserts.push(entry.upsert);
	}
	const changes = Object.freeze([...removes, ...upserts, ...moves]);
	if (plan.ordered) validateChangeOrder(changes);

	let end = covered;
	while (end < backlog.length && !backlog[end]?.hole) end += 1;
	return {
		batch: Object.freeze({ changes, txids: Object.freeze(txids) }),
		later: backlog.slice(covered, end),
		shown: end,
	};
}

function sameSet<Value>(
	left: ReadonlySet<Value>,
	right: ReadonlySet<Value>,
): boolean {
	return (
		left.size === right.size && [...left].every((item) => right.has(item))
	);
}
