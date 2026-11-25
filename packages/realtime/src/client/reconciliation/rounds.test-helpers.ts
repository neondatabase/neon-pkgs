import { vi } from "vitest";

import { SILENT_CLIENT_EVENTS } from "../diagnostics.js";
import { createParserRegistry } from "../postgres/parsers.js";
import { decodeServerFrame } from "../protocol/codec.js";
import type { WireChange, WireRow } from "../protocol/messages.js";
import { Subscription } from "../subscription.js";
import type { LiveQueryChange, RawLiveQueryUpdate } from "../types.js";
import { BaselineSyncPublicationReconciler } from "./reconciler.js";

export type Value = { readonly value: string };
export type Selector = { segment_tag: string } | { row_key: string };

export const key = (char: string) => char.repeat(64);

export function wireRow(
	rowKey: string,
	value: string,
	tag?: string,
	afterRowKey?: string,
): WireRow {
	return {
		row_key: rowKey,
		values: [value],
		...(tag === undefined ? {} : { segment_tag: tag }),
		...(afterRowKey === undefined ? {} : { after_row_key: afterRowKey }),
	};
}

export function upsert(
	rowKey: string,
	value: string,
	tag?: string,
): WireChange {
	return { op: "upsert", ...wireRow(rowKey, value, tag) };
}

export function remove(rowKey: string): WireChange {
	return { op: "remove", row_key: rowKey };
}

export function move(rowKey: string, after: string | null): WireChange {
	return { op: "move", row_key: rowKey, after_row_key: after };
}

/** MVCC evidence that every transaction up to `txid` committed. */
export function mvccThrough(txid: number) {
	return { xmin: String(txid + 1), xmax: String(txid + 1), xip: [] };
}

export interface RoundOptions {
	readonly attempt: number;
	/** Absent: an epoch's first baseline, with scope `all`. */
	readonly selectors?: readonly Selector[];
	readonly covered?: readonly [number, number];
	readonly ordered?: boolean;
	readonly mvcc?: ReturnType<typeof mvccThrough>;
	readonly batches?: readonly (readonly WireRow[])[];
	readonly end?: boolean;
}

export interface TickBody {
	readonly liveId: string;
	readonly changes?: readonly WireChange[];
	readonly hole?: boolean;
}

/**
 * One socket: a real reconciler and real subscriptions, fed every frame
 * through the real codec, as the connection coordinator does.
 */
export class Session {
	readonly reconciler = new BaselineSyncPublicationReconciler();
	private readonly subscriptions = new Map<string, Subscription<Value>>();
	private readonly sequences = new Map<string, number>();
	private readonly epochs = new Map<string, number>();
	private publication = 0;

	subscribe(liveId: string, materialized = true): Subscription<Value> {
		const subscription = new Subscription<Value>(
			{
				renew: async () => {},
				unsubscribe: () => {},
				parserFailed: vi.fn(),
			},
			{
				capability: "test",
				queryFingerprint: "11".repeat(32),
				expiresAt: 1,
			},
			materialized,
			createParserRegistry(undefined),
			undefined,
			SILENT_CLIENT_EVENTS.createSubscription(),
		);
		subscription.admit([
			{ name: "value", type_oid: 25, typmod: -1, codec: "pg_text" },
		]);
		this.reconciler.add({
			liveId,
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: subscription,
		});
		this.sequences.set(liveId, 0);
		this.epochs.set(liveId, 1);
		this.subscriptions.set(liveId, subscription);
		return subscription;
	}

	/** Deliver one server frame exactly as the coordinator does. */
	receive(frame: object): void {
		const { message, mvcc } = decodeServerFrame(JSON.stringify(frame));
		this.reconciler.accept(message as never, mvcc);
	}

	start(liveId: string, options: RoundOptions): void {
		this.receive({
			type: "baseline_sync_start",
			...this.version(liveId, options.attempt),
			scope:
				options.selectors === undefined
					? { kind: "all" }
					: {
							kind: "selected",
							selectors: options.selectors,
							covered: {
								from_sequence: String(
									options.covered?.[0] ?? 1,
								),
								through_sequence: String(
									options.covered?.[1] ?? 1,
								),
							},
							...(options.ordered ? { ordered: true } : {}),
						},
			mvcc: options.mvcc ?? mvccThrough(0),
		});
	}

	batch(
		liveId: string,
		attempt: number,
		index: number,
		rows: readonly WireRow[],
	): void {
		this.receive({
			type: "baseline_sync_batch",
			...this.version(liveId, attempt),
			index,
			rows,
		});
	}

	end(liveId: string, attempt: number, batchCount: number): void {
		this.receive({
			type: "baseline_sync_end",
			...this.version(liveId, attempt),
			batch_count: batchCount,
		});
	}

	/** A whole baseline sync or round: start, its batches, then end. */
	sync(liveId: string, options: RoundOptions): void {
		this.start(liveId, options);
		const batches = options.batches ?? [];
		batches.forEach((rows, index) => {
			this.batch(liveId, options.attempt, index, rows);
		});
		if (options.end !== false) {
			this.end(liveId, options.attempt, batches.length);
		}
	}

	/** One publication: one tick for each listed live ID. */
	tick(bodies: readonly TickBody[], txid: number): void {
		const publicationId = `p${++this.publication}`;
		const frames: object[] = [];
		for (const { liveId, changes, hole } of bodies) {
			const sequence = (this.sequences.get(liveId) ?? 0) + 1;
			this.sequences.set(liveId, sequence);
			const target = {
				live_id: liveId,
				epoch: String(this.epochs.get(liveId) ?? 1),
				sequence: String(sequence),
			};
			if (changes !== undefined || !hole) {
				frames.push({
					type: "keyed_results",
					txids: [String(txid)],
					targets: [target],
					changes: changes ?? [],
				});
			}
			if (hole) {
				frames.push({
					type: "segments_pending",
					txids: [String(txid)],
					targets: [target],
				});
			}
		}
		this.receive({ type: "open", publication_id: publicationId });
		frames.forEach((frame, index) => {
			this.receive({ ...frame, publication_id: publicationId, index });
		});
		this.receive({
			type: "commit",
			publication_id: publicationId,
			body_count: frames.length,
			frontier: { lsn: "0/10" },
		});
	}

	reset(liveId: string): void {
		const epoch = (this.epochs.get(liveId) ?? 1) + 1;
		const publicationId = `p${++this.publication}`;
		this.receive({ type: "open", publication_id: publicationId });
		this.receive({
			type: "reset_required",
			publication_id: publicationId,
			index: 0,
			targets: [
				{ live_id: liveId, epoch: String(epoch), first_sequence: "1" },
			],
		});
		this.receive({
			type: "commit",
			publication_id: publicationId,
			body_count: 1,
			frontier: { lsn: "0/10" },
		});
		this.epochs.set(liveId, epoch);
		this.sequences.set(liveId, 0);
	}

	progress(txid: number): void {
		this.receive({ type: "progress", mvcc: mvccThrough(txid) });
	}

	private version(liveId: string, attempt: number) {
		return {
			live_id: liveId,
			epoch: String(this.epochs.get(liveId) ?? 1),
			baseline_sync_attempt: String(attempt),
		};
	}
}

/**
 * A literal raw consumer: it keeps its own rows and order from `rows` and
 * `changes` updates only, rejects a remove of a row it never saw, and splices
 * moves in sequence. With `strictKeysOnce`, it also rejects a change in the
 * next `changes` update after which two rows hold one value, as a collection
 * keyed by row contents would. Subscriptions isolate listener errors, so the
 * consumer records them in `failures`.
 */
export class RawConsumer {
	rows = new Map<string, string>();
	readonly updates: RawLiveQueryUpdate<Value>[] = [];
	readonly failures: unknown[] = [];
	strictKeysOnce = false;

	constructor(subscription: Subscription<Value>) {
		subscription.onUpdate((update) => {
			this.updates.push(update);
			try {
				if (update.type === "rows") {
					this.rows = new Map(
						update.rows.map(({ rowId, row }) => [rowId, row.value]),
					);
				} else {
					const strict = this.strictKeysOnce;
					this.strictKeysOnce = false;
					this.apply(update.changes, strict);
				}
			} catch (error) {
				this.failures.push(error);
			}
		});
	}

	values(): string[] {
		return [...this.rows.values()];
	}

	private apply(
		changes: readonly LiveQueryChange<Value>[],
		strictKeys: boolean,
	): void {
		const order = [...this.rows.keys()];
		const next = new Map(this.rows);
		for (const change of changes) {
			if (change.type === "remove") {
				if (!next.delete(change.rowId)) {
					throw new Error(
						`raw remove of an unknown row ${change.rowId}`,
					);
				}
				order.splice(order.indexOf(change.rowId), 1);
			} else if (change.type === "upsert") {
				if (!next.has(change.rowId)) order.push(change.rowId);
				next.set(change.rowId, change.row.value);
			} else {
				const from = order.indexOf(change.rowId);
				if (from === -1) throw new Error("raw move of an unknown row");
				order.splice(from, 1);
				const at =
					change.afterRowId === null
						? 0
						: order.indexOf(change.afterRowId) + 1;
				if (at === 0 && change.afterRowId !== null) {
					throw new Error("raw move after an unknown row");
				}
				order.splice(at, 0, change.rowId);
			}
			if (strictKeys && change.type !== "move") {
				const values = [...next.values()];
				if (new Set(values).size !== values.length) {
					throw new Error("two rows hold one value mid-update");
				}
			}
		}
		this.rows = new Map(
			order.map((rowId) => [rowId, next.get(rowId) ?? ""]),
		);
	}
}

/** The materialized rows' values, in result order. */
export function values(subscription: Subscription<Value>): string[] {
	return (subscription.getSnapshot().data ?? []).map(({ value }) => value);
}

/** Track whether each transaction a test waits for has resolved. */
export class TxidWatch {
	readonly resolved = new Set<number>();

	constructor(private readonly subscription: Subscription<Value>) {}

	watch(txid: number): void {
		void this.subscription.awaitTxId(String(txid)).then(
			() => this.resolved.add(txid),
			() => undefined,
		);
	}
}

/** Let promise reactions from synchronous delivery run. */
export async function flush(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}
