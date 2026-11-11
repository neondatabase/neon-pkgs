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
 * Every operation is constant time except {@link keys} and {@link keysOf},
 * which copy what they return. Space is one entry per visible row.
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

	/** Show the row under its tag, moving it from any earlier tag. */
	set(rowKey: string, tag: string | undefined): void {
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
