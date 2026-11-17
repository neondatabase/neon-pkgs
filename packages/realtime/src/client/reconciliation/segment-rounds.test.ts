import { describe, expect, it, vi } from "vitest";

import { SILENT_CLIENT_EVENTS } from "../diagnostics.js";
import { createParserRegistry } from "../postgres/parsers.js";
import { decodeServerMessage, ProtocolError } from "../protocol/codec.js";
import type {
	ServerMessage,
	WireChange,
	WireRow,
} from "../protocol/messages.js";
import { Subscription } from "../subscription.js";
import type { LiveQueryChange, RawLiveQueryUpdate } from "../types.js";
import { BaselineSyncPublicationReconciler } from "./reconciler.js";

type Value = { readonly value: string };
type WireScope = Extract<
	ServerMessage,
	{ type: "baseline_sync_start" }
>["scope"];
type Scope =
	| { kind: "all" }
	| Omit<Extract<WireScope, { kind: "selected" }>, "covered">;

const key = (char: string) => char.repeat(64);
const A = key("a");
const B = key("b");
const C = key("c");
const D = key("d");
const T1 = key("1");
const T2 = key("2");

function tagged(rowKey: string, value: string, tag?: string): WireRow {
	return tag === undefined
		? { row_key: rowKey, values: [value] }
		: { row_key: rowKey, values: [value], segment_tag: tag };
}

function upsert(rowKey: string, value: string, tag?: string): WireChange {
	return { op: "upsert", ...tagged(rowKey, value, tag) };
}

function mvccThrough(txid: number) {
	return { xmin: String(txid + 1), xmax: String(txid + 1), xip: [] };
}

/** A socket's reconciler with real subscriptions on one connection. */
class Session {
	readonly reconciler = new BaselineSyncPublicationReconciler();
	private readonly subscriptions = new Map<string, Subscription<Value>>();
	private sequences = new Map<string, number>();
	private publication = 0;

	subscribe(
		liveId: string,
		materialized = true,
		segmentRounds = true,
	): Subscription<Value> {
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
			segmentRounds,
		});
		this.sequences.set(liveId, 0);
		this.subscriptions.set(liveId, subscription);
		return subscription;
	}

	live(liveId: string): Subscription<Value> {
		const subscription = this.subscriptions.get(liveId);
		if (!subscription) throw new Error(`no subscription ${liveId}`);
		return subscription;
	}

	/** One baseline sync or round: start, one batch per row group, end. */
	sync(
		liveId: string,
		options: {
			readonly attempt: number;
			readonly scope?: Scope;
			readonly covered?: readonly [number, number];
			readonly mvcc?: ReturnType<typeof mvccThrough>;
			readonly batches: readonly (readonly WireRow[])[];
			readonly end?: boolean;
		},
	): void {
		const version = {
			live_id: liveId,
			epoch: "1",
			baseline_sync_attempt: String(options.attempt),
		};
		const scope = options.scope ?? { kind: "all" };
		this.reconciler.accept(
			decodeServerMessage(
				JSON.stringify({
					type: "baseline_sync_start",
					...version,
					scope:
						scope.kind === "selected" && options.covered
							? {
									...scope,
									covered: {
										from_sequence: String(
											options.covered[0],
										),
										through_sequence: String(
											options.covered[1],
										),
									},
								}
							: scope,
					mvcc: options.mvcc ?? mvccThrough(0),
				}),
				"neon.realtime.v3",
			) as Extract<ServerMessage, { type: "baseline_sync_start" }>,
		);
		options.batches.forEach((rows, index) => {
			this.reconciler.accept({
				type: "baseline_sync_batch",
				...version,
				index,
				rows: [...rows],
			});
		});
		if (options.end === false) return;
		this.reconciler.accept({
			type: "baseline_sync_end",
			...version,
			batch_count: options.batches.length,
		});
	}

	/** One tick for each live ID: its patches and, optionally, a hole. */
	tick(
		bodies: readonly {
			readonly liveId: string;
			readonly changes?: readonly WireChange[];
			readonly hole?: boolean;
		}[],
		txid: number,
	): void {
		const publicationId = `p${++this.publication}`;
		const messages: ServerMessage[] = [];
		for (const { liveId, changes, hole } of bodies) {
			const sequence = (this.sequences.get(liveId) ?? 0) + 1;
			this.sequences.set(liveId, sequence);
			const target = {
				live_id: liveId,
				epoch: "1",
				sequence: String(sequence),
			};
			if (changes !== undefined || !hole) {
				messages.push({
					type: "keyed_results",
					publication_id: publicationId,
					index: 0,
					txids: [String(txid)],
					targets: [target],
					changes: [...(changes ?? [])],
				});
			}
			if (hole) {
				messages.push({
					type: "segments_pending",
					publication_id: publicationId,
					index: 0,
					txids: [String(txid)],
					targets: [target],
				});
			}
		}
		this.reconciler.accept({ type: "open", publication_id: publicationId });
		messages.forEach((message, index) => {
			this.reconciler.accept({ ...message, index } as never);
		});
		this.reconciler.accept({
			type: "commit",
			publication_id: publicationId,
			body_count: messages.length,
			frontier: { lsn: "0/10" },
		});
	}

	progress(txid: number): void {
		this.reconciler.accept({ type: "progress", mvcc: mvccThrough(txid) });
	}
}

function values(subscription: Subscription<Value>): string[] {
	return (subscription.getSnapshot().data ?? [])
		.map(({ value }) => value)
		.sort();
}

function describeChanges(changes: readonly LiveQueryChange<Value>[]): string[] {
	return changes.map((change) =>
		change.type === "upsert"
			? `upsert ${change.rowId[0]}=${change.row.value}`
			: `${change.type} ${change.rowId[0]}`,
	);
}

async function settled(promise: Promise<void>): Promise<boolean> {
	let done = false;
	void promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return done;
}

const selected = (...selectors: ({ tag: string } | { row_key: string })[]) =>
	({ kind: "selected", selectors }) as Scope;

describe("segment rounds", () => {
	it("delivers a round to raw listeners as one update, removes first, never as a reset", () => {
		const session = new Session();
		const raw = session.subscribe("9", false);
		const updates: RawLiveQueryUpdate<Value>[] = [];
		raw.onUpdate((update) => updates.push(update));
		session.sync("9", {
			attempt: 1,
			batches: [
				[tagged(A, "a1", T1), tagged(B, "b1", T1), tagged(C, "c1", T2)],
			],
		});
		expect(updates.map(({ type }) => type)).toEqual(["rows"]);

		// A hole for T1, then an exact patch to T2 behind it.
		session.tick([{ liveId: "9", hole: true }], 11);
		session.tick([{ liveId: "9", changes: [upsert(C, "c2", T2)] }], 12);
		expect(updates).toHaveLength(1);

		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [[tagged(B, "b2", T1), tagged(D, "d2", T1)]],
		});
		expect(updates.map(({ type }) => type)).toEqual(["rows", "changes"]);
		const round = updates[1] as Extract<
			RawLiveQueryUpdate<Value>,
			{ type: "changes" }
		>;
		// Every shown row the install touches is removed before any upsert.
		expect(describeChanges(round.changes)).toEqual([
			"remove a",
			"remove b",
			"remove c",
			"upsert b=b2",
			"upsert d=d2",
			"upsert c=c2",
		]);
		expect(round.batch.txids).toEqual(["11", "12"]);
	});

	it("resolves awaitTxId only when the covering round lands", async () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		session.tick([{ liveId: "9", hole: true }], 11);
		session.tick([{ liveId: "9", changes: [upsert(B, "b2")] }], 12);
		const hole = live.awaitTxId("11");
		const later = live.awaitTxId("12");
		// A proof that sees both transactions arrives while the hole is open.
		session.progress(12);
		expect(await settled(hole)).toBe(false);
		expect(await settled(later)).toBe(false);
		expect(values(live)).toEqual(["a1"]);

		session.tick([{ liveId: "9", hole: true }], 13);
		const behindNextHole = live.awaitTxId("13");
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [[tagged(A, "a2", T1)]],
		});
		expect(await settled(hole)).toBe(true);
		expect(await settled(later)).toBe(true);
		expect(await settled(behindNextHole)).toBe(false);
		expect(values(live)).toEqual(["a2", "b2"]);
	});

	it("reports updating on the snapshot while a hole is unresolved", () => {
		const session = new Session();
		const live = session.subscribe("9");
		const updating: (boolean | undefined)[] = [];
		live.onChange((snapshot) => updating.push(snapshot.updating));
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		expect(live.getSnapshot()).toMatchObject({
			status: "live",
			updating: false,
		});

		session.tick([{ liveId: "9", hole: true }], 11);
		expect(live.getSnapshot()).toMatchObject({
			status: "live",
			updating: true,
			data: [{ value: "a1" }],
		});
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 1],
			batches: [[tagged(A, "a2", T1)]],
		});
		expect(live.getSnapshot()).toMatchObject({
			status: "live",
			updating: false,
			data: [{ value: "a2" }],
		});
		expect(updating).toEqual([false, true, false]);
	});

	it("holds progress only for the live query with a hole", async () => {
		const session = new Session();
		const holed = session.subscribe("9");
		const exact = session.subscribe("10");
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		session.sync("10", { attempt: 1, batches: [[tagged(A, "a1")]] });
		session.tick(
			[
				{ liveId: "9", hole: true },
				{ liveId: "10", changes: [] },
			],
			11,
		);
		const holedWait = holed.awaitTxId("15");
		const exactWait = exact.awaitTxId("15");
		session.progress(15);
		expect(await settled(exactWait)).toBe(true);
		expect(await settled(holedWait)).toBe(false);
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 1],
			mvcc: mvccThrough(11),
			batches: [[]],
		});
		expect(await settled(holedWait)).toBe(true);
		expect(values(holed)).toEqual([]);
	});

	it("keeps a row a covered patch moved out of the scope and replaces one it moved in", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", {
			attempt: 1,
			batches: [[tagged(A, "a1", T1), tagged(B, "b1", T2)]],
		});
		session.tick(
			[
				{
					liveId: "9",
					hole: true,
					changes: [upsert(A, "a2", T2), upsert(B, "b-patched", T1)],
				},
			],
			11,
		);
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 1],
			batches: [[tagged(B, "b-round", T1)]],
		});
		expect(values(live)).toEqual(["a2", "b-round"]);
	});

	it("rejects a same-epoch all start after the baseline ended", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", {
			attempt: 1,
			batches: [[tagged(A, "a1", T1), tagged(B, "b1")]],
		});
		session.tick([{ liveId: "9", hole: true }], 11);
		expect(() =>
			session.sync("9", {
				attempt: 2,
				scope: { kind: "all" },
				batches: [[tagged(C, "c1")]],
			}),
		).toThrow(ProtocolError);
		expect(values(live)).toEqual(["a1", "b1"]);
	});

	it("installs a first baseline up to a hole that arrived during it", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.tick([{ liveId: "9", changes: [upsert(B, "b1")] }], 11);
		session.tick([{ liveId: "9", hole: true }], 12);
		session.tick([{ liveId: "9", changes: [upsert(C, "c1")] }], 13);
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		expect(live.getSnapshot()).toMatchObject({
			status: "live",
			updating: true,
		});
		expect(values(live)).toEqual(["a1", "b1"]);
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [2, 2],
			batches: [[tagged(A, "a2", T1)]],
		});
		expect(live.getSnapshot().updating).toBe(false);
		expect(values(live)).toEqual(["a2", "b1", "c1"]);
	});

	it("drops an earlier attempt's rows when a retry supersedes it", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		session.tick([{ liveId: "9", hole: true }], 11);
		const round = {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 1] as const,
		};
		session.sync("9", {
			...round,
			attempt: 2,
			batches: [[tagged(A, "stale", T1)]],
			end: false,
		});
		session.sync("9", {
			...round,
			attempt: 3,
			batches: [[tagged(B, "b2", T1)]],
		});
		expect(values(live)).toEqual(["b2"]);
	});

	it.each([
		false,
		true,
	])("rejects non-increasing attempts after a selected start (ended: %s)", (end) => {
		for (const attempt of [1, 2]) {
			const session = new Session();
			session.subscribe("9");
			session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
			session.tick([{ liveId: "9", hole: true }], 11);
			const plan = {
				scope: selected({ tag: T1 }),
				covered: [1, 1] as const,
				batches: [],
			};
			session.sync("9", { ...plan, attempt: 2, end });
			expect(() => session.sync("9", { ...plan, attempt })).toThrow(
				"invalid baseline sync start",
			);
		}
	});

	it("waits for every covered tick before installing", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		session.tick([{ liveId: "9", hole: true }], 11);
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 2],
			batches: [[tagged(A, "a2", T1)]],
		});
		expect(values(live)).toEqual(["a1"]);
		session.tick([{ liveId: "9", changes: [upsert(B, "b2")] }], 12);
		expect(values(live)).toEqual(["a2", "b2"]);
		expect(live.getSnapshot().updating).toBe(false);
	});

	it("lets the next round start while an ended round waits for its covered ticks", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", {
			attempt: 1,
			batches: [[tagged(A, "a1", T1), tagged(B, "b1", T2)]],
		});
		session.tick([{ liveId: "9", hole: true }], 11);
		// Round 2 ends before tick 2 arrives, and round 3 starts behind it.
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 2],
			batches: [[tagged(A, "a2", T1)]],
		});
		session.sync("9", {
			attempt: 3,
			scope: selected({ tag: T2 }),
			covered: [3, 3],
			batches: [[tagged(B, "b3", T2)]],
		});
		expect(values(live)).toEqual(["a1", "b1"]);
		expect(live.getSnapshot().updating).toBe(true);
		session.tick([{ liveId: "9", changes: [upsert(C, "c2")] }], 12);
		expect(values(live)).toEqual(["a2", "b1", "c2"]);
		session.tick([{ liveId: "9", hole: true }], 13);
		expect(values(live)).toEqual(["a2", "b3", "c2"]);
		expect(live.getSnapshot().updating).toBe(false);
	});

	it("rejects a round behind a waiting one that covers its ticks again", () => {
		const session = new Session();
		session.subscribe("9");
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		session.tick([{ liveId: "9", hole: true }], 11);
		session.sync("9", {
			attempt: 2,
			scope: selected({ tag: T1 }),
			covered: [1, 2],
			batches: [[]],
		});
		expect(() =>
			session.sync("9", {
				attempt: 3,
				scope: selected({ tag: T1 }),
				covered: [2, 3],
				batches: [[]],
			}),
		).toThrow("a covered range must start at the first unresolved hole");
	});

	it("discards holes and the staged round at a reset", () => {
		const session = new Session();
		const live = session.subscribe("9");
		session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
		session.tick([{ liveId: "9", hole: true }], 11);
		session.reconciler.accept({ type: "open", publication_id: "reset" });
		session.reconciler.accept({
			type: "reset_required",
			publication_id: "reset",
			index: 0,
			targets: [{ live_id: "9", epoch: "2", first_sequence: "1" }],
		});
		session.reconciler.accept({
			type: "commit",
			publication_id: "reset",
			body_count: 1,
			frontier: { lsn: "0/10" },
		});
		expect(live.getSnapshot()).toMatchObject({
			updating: false,
			data: [{ value: "a1" }],
		});
	});

	it("ignores a hole for a live query awaiting its unsubscribe", () => {
		for (const segmentRounds of [true, false]) {
			const session = new Session();
			const live = session.subscribe("9", true, segmentRounds);
			session.reconciler.deactivate("9");
			expect(() =>
				session.tick([{ liveId: "9", hole: true }], 11),
			).not.toThrow();
			expect(live.getSnapshot().updating).toBe(false);
		}
	});

	describe("rejects a round or hole the client cannot check", () => {
		const start = (
			session: Session,
			scope: Scope,
			covered?: [number, number],
		) =>
			session.sync("9", {
				attempt: 2,
				scope,
				covered,
				batches: [],
				end: false,
			});

		function holed(): Session {
			const session = new Session();
			session.subscribe("9");
			session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T1)]] });
			session.tick([{ liveId: "9", hole: true }], 11);
			return session;
		}

		it("without an unresolved hole", () => {
			const session = new Session();
			session.subscribe("9");
			session.sync("9", { attempt: 1, batches: [[]] });
			expect(() => start(session, selected({ tag: T1 }), [1, 1])).toThrow(
				ProtocolError,
			);
		});

		it("whose covered range starts elsewhere or has no covered range", () => {
			expect(() => start(holed(), selected({ tag: T1 }), [2, 2])).toThrow(
				ProtocolError,
			);
			expect(() => start(holed(), selected({ tag: T1 }))).toThrow(
				ProtocolError,
			);
		});

		it("with a row outside its scope", () => {
			expect(() =>
				holed().sync("9", {
					attempt: 2,
					scope: selected({ tag: T1 }),
					covered: [1, 1],
					batches: [[tagged(B, "b", T2)]],
				}),
			).toThrow("outside its scope");
		});

		it("returning a row the result shows under a tag outside its scope", () => {
			const session = new Session();
			session.subscribe("9");
			session.sync("9", { attempt: 1, batches: [[tagged(A, "a1", T2)]] });
			session.tick([{ liveId: "9", hole: true }], 11);
			expect(() =>
				session.sync("9", {
					attempt: 2,
					scope: selected({ tag: T1 }),
					covered: [1, 1],
					batches: [[tagged(A, "a2", T1)]],
				}),
			).toThrow("outside its scope");
		});

		it("accepts a greater attempt before end as a retry", () => {
			const session = holed();
			start(session, selected({ tag: T1 }), [1, 1]);
			expect(() =>
				session.sync("9", {
					attempt: 3,
					scope: selected({ tag: T1 }),
					covered: [1, 1],
					batches: [],
				}),
			).not.toThrow();
		});

		describe("from a retry that changes its round's plan", () => {
			// Baseline {A@T1, B@T2}; one hole dirties both segments; attempt 4 of
			// round 2 is staged and not ended when attempt 5 starts.
			function staged(): Session {
				const session = new Session();
				session.subscribe("9");
				session.sync("9", {
					attempt: 1,
					batches: [[tagged(A, "a1", T1), tagged(B, "b1", T2)]],
				});
				session.tick([{ liveId: "9", hole: true }], 11);
				session.tick([{ liveId: "9", changes: [] }], 12);
				session.sync("9", {
					attempt: 4,
					scope: selected({ tag: T1 }, { tag: T2 }),
					covered: [1, 1],
					mvcc: mvccThrough(11),
					batches: [[tagged(A, "a2", T1)]],
					end: false,
				});
				return session;
			}
			const retry = (overrides: object) => ({
				attempt: 5,
				scope: selected({ tag: T1 }, { tag: T2 }),
				covered: [1, 1] as const,
				mvcc: mvccThrough(11),
				batches: [[tagged(A, "a2", T1)]],
				...overrides,
			});

			it("keeps an identical retry", () => {
				const session = staged();
				session.sync(
					"9",
					retry({ scope: selected({ tag: T2 }, { tag: T1 }) }),
				);
				expect(values(session.live("9"))).toEqual(["a2"]);
			});

			it("rejects a narrower scope", () => {
				expect(() =>
					staged().sync("9", retry({ scope: selected({ tag: T1 }) })),
				).toThrow("a retry changed its round's scope");
			});

			it("rejects another covered range", () => {
				expect(() =>
					staged().sync("9", retry({ covered: [1, 2] as const })),
				).toThrow("a retry changed its round's covered range");
			});

			it("rejects another snapshot", () => {
				expect(() =>
					staged().sync("9", retry({ mvcc: mvccThrough(12) })),
				).toThrow("a retry changed its round's snapshot");
			});

			it("accepts a selected round after end with a greater attempt", () => {
				const session = staged();
				session.sync("9", retry({}));
				session.tick([{ liveId: "9", hole: true }], 13);
				session.sync(
					"9",
					retry({
						attempt: 6,
						covered: [3, 3],
						mvcc: mvccThrough(13),
						batches: [[tagged(B, "b3", T2)]],
					}),
				);
				expect(values(session.live("9"))).toEqual(["b3"]);
			});
		});

		describe("that gives a row key another kind of segment", () => {
			it("from a covered patch, before a one-row selector removes it", () => {
				const session = new Session();
				session.subscribe("9");
				session.sync("9", { attempt: 1, batches: [[tagged(A, "a1")]] });
				session.tick(
					[
						{
							liveId: "9",
							hole: true,
							changes: [upsert(A, "a2", T2)],
						},
					],
					11,
				);
				expect(() =>
					session.sync("9", {
						attempt: 2,
						scope: selected({ row_key: A }),
						covered: [1, 1],
						batches: [[]],
					}),
				).toThrow("a row changed its kind of segment");
			});

			it("from a live patch, before any target installs it", () => {
				const session = new Session();
				const live = session.subscribe("9");
				session.sync("9", {
					attempt: 1,
					batches: [[tagged(A, "a1", T1)]],
				});
				expect(() =>
					session.tick(
						[{ liveId: "9", changes: [upsert(A, "a2")] }],
						11,
					),
				).toThrow("a row changed its kind of segment");
				expect(values(live)).toEqual(["a1"]);
			});

			it("from a round row", () => {
				const session = new Session();
				session.subscribe("9");
				session.sync("9", { attempt: 1, batches: [[tagged(A, "a1")]] });
				session.tick([{ liveId: "9", hole: true }], 11);
				expect(() =>
					session.sync("9", {
						attempt: 2,
						scope: selected({ tag: T1 }),
						covered: [1, 1],
						batches: [[tagged(A, "a2", T1)]],
					}),
				).toThrow("a row changed its kind of segment");
			});
		});

		it("with two holes for one target in one tick, or a hole on a v2 target", () => {
			const session = new Session();
			session.subscribe("9");
			session.reconciler.accept({ type: "open", publication_id: "p" });
			const hole = {
				type: "segments_pending" as const,
				publication_id: "p",
				txids: ["11"],
				targets: [{ live_id: "9", epoch: "1", sequence: "1" }],
			};
			session.reconciler.accept({ ...hole, index: 0 });
			expect(() =>
				session.reconciler.accept({ ...hole, index: 1 }),
			).toThrow(ProtocolError);

			const v2 = new Session();
			v2.subscribe("9", true, false);
			expect(() => v2.tick([{ liveId: "9", hole: true }], 11)).toThrow(
				ProtocolError,
			);
		});
	});
});

describe("ordered segment rounds", () => {
	const E = key("e");
	const F = key("f");
	const placed = (row: WireRow, after: string | null): WireRow => ({
		...row,
		after_row_key: after,
	});
	const move = (rowId: string, afterRowId: string | null) => ({
		type: "move",
		rowId,
		afterRowId,
	});
	const remove = (rowId: string) => ({ type: "remove", rowId });
	const put = (rowId: string, value: string) => ({
		type: "upsert",
		rowId,
		row: { value },
	});
	const initial = [
		tagged(A, "a"),
		tagged(B, "b", T1),
		tagged(C, "c", T1),
		tagged(D, "d"),
	];
	const cases = [
		{
			name: "replaces a block in the middle across batches",
			initial,
			scope: selected({ tag: T1 }),
			batches: [
				[],
				[placed(tagged(E, "e", T1), A)],
				[],
				[tagged(F, "f", T1)],
			],
			order: ["a", "e", "f", "d"],
			changes: [
				remove(B),
				remove(C),
				put(E, "e"),
				put(F, "f"),
				move(E, A),
				move(F, E),
			],
		},
		{
			name: "inserts a new block at the head",
			initial: [tagged(A, "a"), tagged(D, "d")],
			scope: selected({ tag: T1 }),
			batches: [[placed(tagged(E, "e", T1), null), tagged(F, "f", T1)]],
			order: ["e", "f", "a", "d"],
			changes: [put(E, "e"), put(F, "f"), move(E, null), move(F, E)],
		},
		{
			name: "places two blocks with an implicit anchor between them",
			initial: [
				tagged(A, "a"),
				tagged(B, "b", T1),
				tagged(C, "c", T2),
				tagged(D, "d"),
			],
			scope: selected({ tag: T1 }, { tag: T2 }),
			batches: [[placed(tagged(E, "e", T1), A)], [tagged(F, "f", T2)]],
			order: ["a", "e", "f", "d"],
			changes: [
				remove(B),
				remove(C),
				put(E, "e"),
				put(F, "f"),
				move(E, A),
				move(F, E),
			],
		},
		{
			name: "accepts an explicit anchor equal to the implicit one",
			initial,
			scope: selected({ tag: T1 }),
			batches: [
				[placed(tagged(E, "e", T1), A), placed(tagged(F, "f", T1), E)],
			],
			order: ["a", "e", "f", "d"],
			changes: [
				remove(B),
				remove(C),
				put(E, "e"),
				put(F, "f"),
				move(E, A),
				move(F, E),
			],
		},
		{
			name: "removes an empty block beside a placed block",
			initial: [
				tagged(A, "a"),
				tagged(B, "b", T1),
				tagged(C, "c", T2),
				tagged(D, "d"),
			],
			scope: selected({ tag: T1 }, { tag: T2 }),
			batches: [[placed(tagged(E, "e", T1), A)]],
			order: ["a", "e", "d"],
			changes: [remove(B), remove(C), put(E, "e"), move(E, A)],
		},
		{
			name: "places disjoint blocks after different surviving anchors",
			initial: [
				tagged(A, "a"),
				tagged(B, "b", T1),
				tagged(C, "c", T2),
				tagged(D, "d"),
			],
			scope: selected({ tag: T1 }, { tag: T2 }),
			batches: [
				[placed(tagged(E, "e", T1), A)],
				[placed(tagged(F, "f", T2), D)],
			],
			order: ["a", "e", "d", "f"],
			changes: [
				remove(B),
				remove(C),
				put(E, "e"),
				put(F, "f"),
				move(E, A),
				move(F, D),
			],
		},
		{
			name: "places a one-row segment selected by row key",
			initial: [tagged(D, "d"), tagged(A, "a")],
			scope: selected({ row_key: A }),
			batches: [[placed(tagged(A, "a2"), null)]],
			order: ["a2", "d"],
			changes: [put(A, "a2"), move(A, null)],
		},
		{
			name: "upserts and moves a retained row key without removing it",
			initial,
			scope: selected({ tag: T1 }),
			batches: [[placed(tagged(B, "b2", T1), A)]],
			order: ["a", "b2", "d"],
			changes: [remove(C), put(B, "b2"), move(B, A)],
		},
	];

	for (const materialized of [true, false]) {
		describe(`materialized: ${materialized}`, () => {
			it.each(cases)("$name", ({
				initial,
				scope,
				batches,
				order,
				changes,
			}) => {
				const session = new Session();
				const live = session.subscribe("9", materialized);
				const updates: RawLiveQueryUpdate<Value>[] = [];
				live.onUpdate((update) => updates.push(update));
				session.sync("9", { attempt: 1, batches: [initial] });
				session.tick([{ liveId: "9", hole: true }], 11);
				session.sync("9", {
					attempt: 2,
					scope,
					covered: [1, 1],
					batches,
				});
				expect(updates).toHaveLength(2);
				expect(updates[1]).toEqual({
					type: "changes",
					changes,
					batch: { txids: ["11"] },
				});
				if (materialized)
					expect(live.getSnapshot().data).toEqual(
						order.map((value) => ({ value })),
					);
			});

			it("publishes a later tick with a move separately and indexes its entrant", () => {
				const session = new Session();
				const live = session.subscribe("9", materialized);
				const updates: RawLiveQueryUpdate<Value>[] = [];
				const observed: (readonly Value[] | undefined)[] = [];
				live.onUpdate((update) => {
					updates.push(update);
					observed.push(live.getSnapshot().data);
				});
				session.sync("9", { attempt: 1, batches: [initial] });
				session.tick([{ liveId: "9", hole: true }], 11);
				session.tick(
					[
						{
							liveId: "9",
							changes: [
								upsert(F, "f", T2),
								{ op: "move", row_key: F, after_row_key: null },
							],
						},
					],
					12,
				);
				session.sync("9", {
					attempt: 2,
					scope: selected({ tag: T1 }),
					covered: [1, 1],
					batches: [[placed(tagged(E, "e", T1), A)]],
				});
				expect(updates.slice(1)).toEqual([
					{
						type: "changes",
						changes: [
							remove(B),
							remove(C),
							put(E, "e"),
							move(E, A),
						],
						batch: { txids: ["11"] },
					},
					{
						type: "changes",
						changes: [put(F, "f"), move(F, null)],
						batch: { txids: ["12"] },
					},
				]);
				if (materialized) {
					const final = ["f", "a", "e", "d"].map((value) => ({
						value,
					}));
					expect(observed.slice(1)).toEqual([final, final]);
				}
				session.tick([{ liveId: "9", hole: true }], 13);
				session.sync("9", {
					attempt: 3,
					scope: selected({ tag: T2 }),
					covered: [3, 3],
					batches: [[]],
				});
				expect(updates[3]).toEqual({
					type: "changes",
					changes: [remove(F)],
					batch: { txids: ["13"] },
				});
				if (materialized)
					expect(live.getSnapshot().data).toEqual(
						["a", "e", "d"].map((value) => ({ value })),
					);
			});

			it("stops later replay at the next hole and holds its progress", async () => {
				const session = new Session();
				const live = session.subscribe("9", materialized);
				const updates: RawLiveQueryUpdate<Value>[] = [];
				live.onUpdate((update) => updates.push(update));
				session.sync("9", { attempt: 1, batches: [initial] });
				session.tick([{ liveId: "9", hole: true }], 11);
				session.tick(
					[
						{
							liveId: "9",
							changes: [
								{ op: "move", row_key: D, after_row_key: null },
							],
						},
					],
					12,
				);
				session.tick([{ liveId: "9", hole: true }], 13);
				session.tick(
					[
						{
							liveId: "9",
							changes: [
								{ op: "move", row_key: D, after_row_key: A },
							],
						},
					],
					14,
				);
				const shown = live.awaitTxId("12");
				const held = live.awaitTxId("14");
				session.progress(14);
				session.sync("9", {
					attempt: 2,
					scope: selected({ tag: T1 }),
					covered: [1, 1],
					mvcc: mvccThrough(11),
					batches: [[placed(tagged(E, "e", T1), A)]],
				});
				expect(updates).toHaveLength(3);
				expect(updates[2]).toEqual({
					type: "changes",
					changes: [move(D, null)],
					batch: { txids: ["12"] },
				});
				expect(await settled(shown)).toBe(true);
				expect(await settled(held)).toBe(false);
				expect(live.getSnapshot().updating).toBe(true);
				if (materialized)
					expect(live.getSnapshot().data).toEqual(
						["d", "a", "e"].map((value) => ({ value })),
					);
				session.sync("9", {
					attempt: 3,
					scope: selected({ tag: T1 }),
					covered: [3, 3],
					mvcc: mvccThrough(13),
					batches: [[placed(tagged(E, "e2", T1), A)]],
				});
				expect(updates.slice(3)).toEqual([
					{
						type: "changes",
						changes: [put(E, "e2"), move(E, A)],
						batch: { txids: ["13"] },
					},
					{
						type: "changes",
						changes: [move(D, A)],
						batch: { txids: ["14"] },
					},
				]);
				expect(await settled(held)).toBe(true);
				expect(live.getSnapshot().updating).toBe(false);
				if (materialized)
					expect(live.getSnapshot().data).toEqual(
						["a", "d", "e2"].map((value) => ({ value })),
					);
			});

			it.each([
				true,
				false,
			])("installs an empty round with later moves: %s", (hasMove) => {
				const session = new Session();
				const live = session.subscribe("9", materialized);
				const updates: RawLiveQueryUpdate<Value>[] = [];
				live.onUpdate((update) => updates.push(update));
				session.sync("9", { attempt: 1, batches: [initial] });
				session.tick([{ liveId: "9", hole: true }], 11);
				// The scan must look past the first later tick to find the move.
				session.tick([{ liveId: "9", changes: [] }], 12);
				const changes: WireChange[] = [upsert(F, "f", T2)];
				if (hasMove)
					changes.push({
						op: "move",
						row_key: F,
						after_row_key: null,
					});
				session.tick([{ liveId: "9", changes }], 13);
				expect(() =>
					session.sync("9", {
						attempt: 2,
						scope: selected({ tag: T1 }),
						covered: [1, 1],
						batches: [],
					}),
				).not.toThrow();
				expect(updates.slice(1)).toEqual(
					hasMove
						? [
								{
									type: "changes",
									changes: [remove(B), remove(C)],
									batch: { txids: ["11"] },
								},
								{
									type: "changes",
									changes: [],
									batch: { txids: ["12"] },
								},
								{
									type: "changes",
									changes: [put(F, "f"), move(F, null)],
									batch: { txids: ["13"] },
								},
							]
						: [
								{
									type: "changes",
									changes: [
										remove(B),
										remove(C),
										put(F, "f"),
									],
									batch: { txids: ["11", "12", "13"] },
								},
							],
				);
				if (materialized)
					expect(live.getSnapshot().data).toEqual(
						(hasMove ? ["f", "a", "d"] : ["a", "d", "f"]).map(
							(value) => ({ value }),
						),
					);
				expect(live.getSnapshot().updating).toBe(false);
			});

			const invalid = [
				{
					name: "a covered tick with a move",
					changes: [
						{ op: "move", row_key: A, after_row_key: D },
					] as WireChange[],
					batches: [[placed(tagged(E, "e", T1), A)]],
				},
				{
					name: "a covered entrant outside the scope",
					changes: [upsert(F, "f", T2)],
					batches: [[placed(tagged(E, "e", T1), A)]],
				},
				{
					name: "a later batch introducing placement into an unordered round",
					batches: [
						[tagged(E, "e", T1)],
						[placed(tagged(F, "f", T1), E)],
					],
				},
				{
					name: "an anchor removed by the scope",
					batches: [[placed(tagged(E, "e", T1), B)]],
				},
				{
					name: "two explicit anchors that conflict",
					batches: [
						[
							placed(tagged(E, "e", T1), A),
							placed(tagged(F, "f", T1), A),
						],
					],
				},
				{
					name: "an explicit anchor conflicting with an implicit one",
					batches: [
						[
							placed(tagged(E, "e", T1), A),
							tagged(F, "f", T1),
							placed(tagged(B, "b2", T1), E),
						],
					],
				},
				{
					name: "a self anchor",
					batches: [[placed(tagged(E, "e", T1), E)]],
				},
				{
					name: "a missing anchor",
					batches: [[placed(tagged(E, "e", T1), F)]],
				},
				{
					name: "a future round row as anchor",
					batches: [
						[placed(tagged(E, "e", T1), F), tagged(F, "f", T1)],
					],
				},
			];
			it.each(invalid)("rejects $name before publishing", ({
				batches,
				...test
			}) => {
				const session = new Session();
				const live = session.subscribe("9", materialized);
				const updates: RawLiveQueryUpdate<Value>[] = [];
				live.onUpdate((update) => updates.push(update));
				session.sync("9", { attempt: 1, batches: [initial] });
				const before = live.getSnapshot();
				session.tick(
					[
						{
							liveId: "9",
							hole: true,
							changes:
								"changes" in test ? test.changes : undefined,
						},
					],
					11,
				);
				expect(() =>
					session.sync("9", {
						attempt: 2,
						scope: selected({ tag: T1 }),
						covered: [1, 1],
						batches,
					}),
				).toThrow(ProtocolError);
				expect(updates).toHaveLength(1);
				expect(live.getSnapshot().data).toEqual(before.data);
			});

			it("rejects placement on an all baseline row", () => {
				const session = new Session();
				const live = session.subscribe("9", materialized);
				const update = vi.fn();
				live.onUpdate(update);
				expect(() =>
					session.sync("9", {
						attempt: 1,
						batches: [[placed(tagged(A, "a"), null)]],
					}),
				).toThrow("an all baseline row carries placement");
				expect(update).not.toHaveBeenCalled();
			});
		});
	}
});
