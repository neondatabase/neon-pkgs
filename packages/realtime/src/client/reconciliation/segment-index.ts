import { ProtocolError } from "../protocol/codec.js";
import type { WireChange } from "../protocol/messages.js";

/**
 * The visible row keys of one live query, each with its segment tag.
 *
 * A selected round replaces segments named by tag or by row key. The index
 * finds a tag's rows without scanning the result, and it records which keys
 * are visible, so an install removes only rows the result showed. Raw
 * subscriptions keep it too: they retain no rows, but their update must
 * still name every row it removes.
 *
 * A row key's kind of segment is fixed by the query's plan: a row of a
 * multi-row segment always carries a tag, and can move between tags; a row
 * of a one-row segment, or outside segments, never does. A change that gives
 * a shown row key the other kind is a protocol error.
 *
 * Every operation is constant time except {@link keys} and {@link keysOf},
 * which copy what they return, and {@link checkChanges}, which is linear in
 * its changes. Space is one entry per visible row plus one per row of a
 * multi-row segment.
 */
export class SegmentIndex {
	private readonly tagByKey = new Map<string, string | undefined>();
	private readonly keysByTag = new Map<string, Set<string>>();

	has(rowKey: string): boolean {
		return this.tagByKey.has(rowKey);
	}

	/** The row's tag, or undefined for a row outside multi-row segments. */
	tagOf(rowKey: string): string | undefined {
		return this.tagByKey.get(rowKey);
	}

	keys(): string[] {
		return [...this.tagByKey.keys()];
	}

	keysOf(tag: string): string[] {
		return [...(this.keysByTag.get(tag) ?? [])];
	}

	/** Reject a row that would give a shown row key the other kind of segment. */
	checkKind(rowKey: string, tag: string | undefined): void {
		if (
			this.tagByKey.has(rowKey) &&
			(this.tagByKey.get(rowKey) === undefined) !== (tag === undefined)
		) {
			throw new ProtocolError("a row changed its kind of segment");
		}
	}

	/** {@link checkKind} for one tick's changes in order, without applying them. */
	checkChanges(changes: readonly WireChange[]): void {
		const pending = new Map<string, string | undefined | null>();
		for (const change of changes) {
			if (change.op === "move") continue;
			if (change.op === "remove") {
				pending.set(change.row_key, null);
				continue;
			}
			const before = pending.get(change.row_key);
			if (before === undefined && !pending.has(change.row_key)) {
				this.checkKind(change.row_key, change.segment_tag);
			} else if (
				before !== null &&
				(before === undefined) !== (change.segment_tag === undefined)
			) {
				throw new ProtocolError("a row changed its kind of segment");
			}
			pending.set(change.row_key, change.segment_tag);
		}
	}

	/** Show the row under its tag, moving it from any earlier tag. */
	set(rowKey: string, tag: string | undefined): void {
		this.checkKind(rowKey, tag);
		this.delete(rowKey);
		this.tagByKey.set(rowKey, tag);
		if (tag === undefined) return;
		let keys = this.keysByTag.get(tag);
		if (!keys) {
			keys = new Set();
			this.keysByTag.set(tag, keys);
		}
		keys.add(rowKey);
	}

	delete(rowKey: string): void {
		if (!this.tagByKey.has(rowKey)) return;
		const tag = this.tagByKey.get(rowKey);
		this.tagByKey.delete(rowKey);
		if (tag === undefined) return;
		const keys = this.keysByTag.get(tag);
		keys?.delete(rowKey);
		if (keys?.size === 0) this.keysByTag.delete(tag);
	}

	clear(): void {
		this.tagByKey.clear();
		this.keysByTag.clear();
	}

	/** Apply one tick's changes. A move keeps the row's tag. */
	apply(changes: readonly WireChange[]): void {
		for (const change of changes) {
			if (change.op === "upsert")
				this.set(change.row_key, change.segment_tag);
			else if (change.op === "remove") this.delete(change.row_key);
		}
	}
}
