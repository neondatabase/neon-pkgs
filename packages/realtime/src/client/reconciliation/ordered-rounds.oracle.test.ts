/**
 * A deterministic model of an ordered server.
 * The server owns its row order and history independently of the reconciler.
 * Covered ticks close over dirty segments without moves or outside entrants;
 * rounds send anchored runs, retry, renumber keys and wait for delayed ticks.
 * Compare a literal raw consumer after every update and materialization after
 * every frame. No mistake injection, environment toggles or filesystem output.
 */
import { describe, expect, it, vi } from "vitest";

import { SILENT_CLIENT_EVENTS } from "../diagnostics.js";
import { createParserRegistry } from "../postgres/parsers.js";
import { decodeServerMessage } from "../protocol/codec.js";
import type { WireChange, WireRow } from "../protocol/messages.js";
import { Subscription } from "../subscription.js";
import type { RawLiveQueryUpdate } from "../types.js";
import { BaselineSyncPublicationReconciler } from "./reconciler.js";

type Value = { readonly value: string };

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const hexKey = (n: number) => n.toString(16).padStart(64, "0");
const hexTag = (n: number) => `e${n.toString(16)}`.padStart(64, "e");

function makeSubscription(materialized: boolean) {
	const subscription = new Subscription<Value>(
		{ renew: async () => {}, unsubscribe: () => {}, parserFailed: vi.fn() },
		{ capability: "test", queryFingerprint: "11".repeat(32), expiresAt: 1 },
		materialized,
		createParserRegistry(undefined),
		undefined,
		SILENT_CLIENT_EVENTS.createSubscription(),
	);
	subscription.admit([
		{ name: "value", type_oid: 25, typmod: -1, codec: "pg_text" },
	]);
	return subscription;
}

/** A raw consumer that applies the public contract literally. */
class RawConsumer {
	order: string[] = [];
	values = new Map<string, string>();
	apply(update: RawLiveQueryUpdate<Value>): void {
		if (update.type === "rows") {
			this.order = update.rows.map((r) => r.rowId);
			this.values = new Map(
				update.rows.map((r) => [r.rowId, r.row.value]),
			);
			return;
		}
		for (const change of update.changes) {
			if (change.type === "remove") {
				this.values.delete(change.rowId);
				this.order = this.order.filter((k) => k !== change.rowId);
			} else if (change.type === "upsert") {
				if (!this.values.has(change.rowId))
					this.order.push(change.rowId);
				this.values.set(change.rowId, change.row.value);
			} else {
				if (!this.values.has(change.rowId))
					throw new Error("raw consumer: move of a missing row");
				if (
					change.afterRowId !== null &&
					!this.values.has(change.afterRowId)
				)
					throw new Error(
						"raw consumer: move after a missing anchor",
					);
				this.order = this.order.filter((k) => k !== change.rowId);
				const at =
					change.afterRowId === null
						? 0
						: this.order.indexOf(change.afterRowId) + 1;
				this.order.splice(at, 0, change.rowId);
			}
		}
	}
	shown(): string[] {
		return this.order.map((k) => this.values.get(k) as string);
	}
}

interface SRow {
	readonly tag?: string;
	readonly value: string;
}
type Frame =
	| { kind: "tick"; seq: number; changes: WireChange[]; hole: boolean }
	| {
			kind: "start";
			round: number;
			attempt: number;
			selectors: ({ tag: string } | { row_key: string })[];
			covered: [number, number];
	  }
	| {
			kind: "batch";
			round: number;
			attempt: number;
			index: number;
			rows: WireRow[];
	  }
	| { kind: "end"; round: number; attempt: number; count: number };

class Model {
	rows = new Map<string, SRow>();
	order: string[] = [];
	seq = 0;
	nextKey = 1;
	nextValue = 1;
	readonly tags: string[];
	uncovered?: { first: number; tags: Set<string>; keys: Set<string> };
	history: string[][] = [];
	frames: Frame[] = [];
	roundFrames: Frame[][] = [];
	attempt = 1;
	round = 0;
	stats = {
		rounds: 0,
		emptyRounds: 0,
		retries: 0,
		rekeyed: 0,
		laterMoves: 0,
		anchorLaterPending: 0,
		waitingInRow: 0,
	};
	lastAnchors = new Set<string>();
	constructor(readonly rand: () => number) {
		this.tags = [1, 2, 3, 4].map(hexTag);
		const initial = 3 + Math.floor(rand() * 8);
		for (let i = 0; i < initial; i += 1) this.insertAt(this.order.length);
		this.history[0] = this.shown();
	}
	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.rand() * items.length)] as T;
	}
	value(): string {
		return `v${this.nextValue++}`;
	}
	shown(): string[] {
		return this.order.map((k) => (this.rows.get(k) as SRow).value);
	}
	insertAt(position: number): string {
		const key = hexKey(this.nextKey++);
		const multi = this.rand() < 0.7;
		this.rows.set(key, {
			...(multi ? { tag: this.pick(this.tags) } : {}),
			value: this.value(),
		});
		this.order.splice(position, 0, key);
		return key;
	}
	segOf(key: string, row: SRow): { tag: string } | { key: string } {
		return row.tag !== undefined ? { tag: row.tag } : { key };
	}
	pending(seg: { tag: string } | { key: string }): boolean {
		const u = this.uncovered;
		if (!u) return false;
		return "tag" in seg ? u.tags.has(seg.tag) : u.keys.has(seg.key);
	}
	pend(seg: { tag: string } | { key: string }): boolean {
		const u = this.uncovered as NonNullable<Model["uncovered"]>;
		if ("tag" in seg) {
			if (u.tags.has(seg.tag)) return false;
			u.tags.add(seg.tag);
		} else {
			if (u.keys.has(seg.key)) return false;
			u.keys.add(seg.key);
		}
		return true;
	}

	/** One tick: random edits, delivered as a patch or as a hole. */
	tick(): void {
		const oldRows = new Map(this.rows);
		const oldOrder = [...this.order];
		const moved = new Set<string>();
		const entered = new Set<string>();
		const edits = 1 + Math.floor(this.rand() * 3);
		for (let i = 0; i < edits; i += 1) {
			const r = this.rand();
			if (r < 0.25 || this.order.length < 2) {
				const key = this.insertAt(
					Math.floor(this.rand() * (this.order.length + 1)),
				);
				entered.add(key);
			} else if (r < 0.45) {
				const key = this.pick(this.order);
				this.rows.delete(key);
				this.order = this.order.filter((k) => k !== key);
				moved.delete(key);
				entered.delete(key);
			} else if (r < 0.65) {
				const key = this.pick(this.order);
				const row = this.rows.get(key) as SRow;
				this.rows.set(key, { ...row, value: this.value() });
			} else if (r < 0.85) {
				const key = this.pick(this.order);
				this.order = this.order.filter((k) => k !== key);
				this.order.splice(
					Math.floor(this.rand() * (this.order.length + 1)),
					0,
					key,
				);
				moved.add(key);
			} else {
				const key = this.pick(this.order);
				const row = this.rows.get(key) as SRow;
				if (row.tag !== undefined)
					this.rows.set(key, {
						tag: this.pick(this.tags),
						value: this.value(),
					});
			}
		}
		this.seq += 1;
		const seq = this.seq;
		let hole = false;
		if (!this.uncovered && this.rand() < 0.3) {
			this.uncovered = { first: seq, tags: new Set(), keys: new Set() };
			hole = true;
			// The tick that commits the hole dirties at least one segment.
			const key = this.pick(this.order);
			this.pend(this.segOf(key, this.rows.get(key) as SRow));
		}
		const changed = new Set<string>([
			...oldRows.keys(),
			...this.rows.keys(),
		]);
		const contentChanged = (key: string) => {
			const before = oldRows.get(key);
			const after = this.rows.get(key);
			return (
				before === undefined ||
				after === undefined ||
				before.value !== after.value ||
				before.tag !== after.tag
			);
		};
		for (const key of [...changed])
			if (!contentChanged(key) && !moved.has(key)) changed.delete(key);

		if (!this.uncovered) {
			this.frames.push({
				kind: "tick",
				seq,
				hole,
				changes: this.program(oldRows, oldOrder, moved, entered),
			});
			this.history[seq] = this.shown();
			return;
		}
		// A covered tick: rows that move or enter outside the pending segments,
		// or whose segment touches a pending one, become part of the hole.
		const touches = (key: string) => {
			const before = oldRows.get(key);
			const after = this.rows.get(key);
			return (
				(before !== undefined &&
					this.pending(this.segOf(key, before))) ||
				(after !== undefined && this.pending(this.segOf(key, after)))
			);
		};
		let grew = true;
		while (grew) {
			grew = false;
			for (const key of changed) {
				const before = oldRows.get(key);
				const after = this.rows.get(key);
				const needs =
					entered.has(key) ||
					(moved.has(key) && after !== undefined) ||
					touches(key);
				if (!needs) continue;
				if (before !== undefined)
					grew = this.pend(this.segOf(key, before)) || grew;
				if (after !== undefined)
					grew = this.pend(this.segOf(key, after)) || grew;
				if (grew) hole = true;
			}
		}
		const changes: WireChange[] = [];
		for (const key of changed) {
			if (touches(key)) {
				if (this.rand() < 0.5) continue;
				// A patch to a row of a pending segment, without a move, is allowed.
				const after = this.rows.get(key);
				if (after === undefined) {
					if (oldRows.has(key) && this.rand() < 0.5)
						changes.push({ op: "remove", row_key: key });
				} else if (this.rand() < 0.5) {
					changes.push({
						op: "upsert",
						row_key: key,
						values: [after.value],
						...(after.tag ? { segment_tag: after.tag } : {}),
					});
				}
				continue;
			}
			const after = this.rows.get(key);
			if (after === undefined)
				changes.push({ op: "remove", row_key: key });
			else if (contentChanged(key))
				changes.push({
					op: "upsert",
					row_key: key,
					values: [after.value],
					...(after.tag ? { segment_tag: after.tag } : {}),
				});
		}
		if (touchesAny(changed, touches)) hole = true;
		this.frames.push({ kind: "tick", seq, hole, changes });
		this.history[seq] = this.shown();
	}

	/** The ordered program from the old state to the current one. */
	program(
		oldRows: Map<string, SRow>,
		oldOrder: string[],
		moved: Set<string>,
		entered: Set<string>,
	): WireChange[] {
		const contents: WireChange[] = [];
		for (const key of oldOrder)
			if (!this.rows.has(key))
				contents.push({ op: "remove", row_key: key });
		for (const key of this.order) {
			const row = this.rows.get(key) as SRow;
			const before = oldRows.get(key);
			if (!before || before.value !== row.value || before.tag !== row.tag)
				contents.push({
					op: "upsert",
					row_key: key,
					values: [row.value],
					...(row.tag ? { segment_tag: row.tag } : {}),
				});
		}
		const moves: WireChange[] = [];
		this.order.forEach((key, position) => {
			if (moved.has(key) || entered.has(key)) {
				moves.push({
					op: "move",
					row_key: key,
					after_row_key:
						position === 0
							? null
							: (this.order[position - 1] as string),
				});
			}
		});
		if (moves.length > 0 && this.uncovered === undefined)
			this.stats.laterMoves += 1;
		return [...contents, ...moves];
	}

	/** Pin the uncovered hole's round at the current tick and queue its frames. */
	pin(): void {
		const u = this.uncovered;
		if (!u) return;
		this.uncovered = undefined;
		const inScope = (key: string) => {
			const row = this.rows.get(key) as SRow;
			return row.tag !== undefined
				? u.tags.has(row.tag)
				: u.keys.has(key);
		};
		if ([...this.lastAnchors].some((k) => this.rows.has(k) && inScope(k)))
			this.stats.anchorLaterPending += 1;
		// Renumber some multi-row keys of the scope, as numbered keys do.
		const scopeMulti = this.order.filter(
			(k) => inScope(k) && (this.rows.get(k) as SRow).tag !== undefined,
		);
		if (scopeMulti.length > 0 && this.rand() < 0.4) {
			this.stats.rekeyed += 1;
			const fresh = scopeMulti.map((k) =>
				this.rand() < 0.3 ? hexKey(this.nextKey++) : k,
			);
			// Permute: a reused key may now hold another row's contents.
			for (let i = fresh.length - 1; i > 0; i -= 1) {
				const j = Math.floor(this.rand() * (i + 1));
				[fresh[i], fresh[j]] = [fresh[j] as string, fresh[i] as string];
			}
			const rowsBefore = new Map(this.rows);
			for (const k of scopeMulti) this.rows.delete(k);
			scopeMulti.forEach((k, i) => {
				this.rows.set(fresh[i] as string, rowsBefore.get(k) as SRow);
			});
			let j = 0;
			this.order = this.order.map((k) =>
				scopeMulti.includes(k) ? (fresh[j++] as string) : k,
			);
		}
		// Runs of consecutive scope rows; each run hangs off its predecessor.
		const runs: { anchor: string | null; rows: string[] }[] = [];
		this.order.forEach((key, position) => {
			if (!inScope(key)) return;
			const previous =
				position === 0 ? null : (this.order[position - 1] as string);
			const last = runs.at(-1);
			if (last && previous !== null && last.rows.at(-1) === previous)
				last.rows.push(key);
			else runs.push({ anchor: previous, rows: [key] });
		});
		// Independent runs may arrive in any order.
		for (let i = runs.length - 1; i > 0; i -= 1) {
			const j = Math.floor(this.rand() * (i + 1));
			[runs[i], runs[j]] = [
				runs[j] as (typeof runs)[number],
				runs[i] as (typeof runs)[number],
			];
		}
		this.lastAnchors = new Set(
			runs.map((r) => r.anchor).filter((a): a is string => a !== null),
		);
		const wire: WireRow[] = [];
		for (const run of runs) {
			const rows = run.rows;
			const anchors: (string | null)[] = rows.map((_, i) =>
				i === 0 ? run.anchor : (rows[i - 1] as string),
			);
			rows.forEach((key, i) => {
				const row = this.rows.get(key) as SRow;
				const explicit =
					i === 0 || anchors[i] !== rows[i - 1] || this.rand() < 0.2;
				wire.push({
					row_key: key,
					values: [row.value],
					...(row.tag ? { segment_tag: row.tag } : {}),
					...(explicit
						? { after_row_key: anchors[i] as string | null }
						: {}),
				});
			});
		}
		const selectors = [
			...[...u.tags].map((tag) => ({ tag })),
			...[...u.keys].map((row_key) => ({ row_key })),
		];
		const covered: [number, number] = [u.first, this.seq];
		const round = ++this.round;
		const frames: Frame[] = [];
		const split = (rows: WireRow[]) => {
			const batches: WireRow[][] = [];
			let rest = rows;
			while (
				rest.length > 0 ||
				batches.length === 0 ||
				this.rand() < 0.2
			) {
				const n = Math.floor(this.rand() * (rest.length + 1));
				batches.push(rest.slice(0, n));
				rest = rest.slice(n);
				if (rest.length === 0 && this.rand() < 0.7) break;
			}
			return batches;
		};
		if (this.rand() < 0.25) {
			// A retry: an earlier attempt sends part of the round, then stops.
			this.stats.retries += 1;
			const attempt = ++this.attempt;
			frames.push({ kind: "start", round, attempt, selectors, covered });
			split(
				wire.slice(0, Math.floor(this.rand() * (wire.length + 1))),
			).forEach((rows, index) => {
				frames.push({ kind: "batch", round, attempt, index, rows });
			});
		}
		const attempt = ++this.attempt;
		frames.push({ kind: "start", round, attempt, selectors, covered });
		const batches = split(wire);
		batches.forEach((rows, index) => {
			frames.push({ kind: "batch", round, attempt, index, rows });
		});
		frames.push({ kind: "end", round, attempt, count: batches.length });
		this.roundFrames.push(frames);
		this.stats.rounds += 1;
		if (wire.length === 0) this.stats.emptyRounds += 1;
	}
}

function touchesAny(
	keys: Set<string>,
	touches: (key: string) => boolean,
): boolean {
	for (const key of keys) if (touches(key)) return true;
	return false;
}

interface Outcome {
	readonly error?: string;
	readonly mismatch?: string;
}

/** Run one scenario on one subscription and compare after every frame. */
function run(
	seed: number,
	materialized: boolean,
	steps = 40,
): Outcome & { model: Model } {
	const rand = mulberry32(seed);
	const model = new Model(rand);
	const reconciler = new BaselineSyncPublicationReconciler();
	const live = makeSubscription(materialized);
	const raw = new RawConsumer();
	let shownSeq = 0;
	let mismatch: string | undefined;
	live.onUpdate((update) => {
		raw.apply(update);
		if (update.type === "changes") {
			const last = Math.max(
				...update.batch.txids.map((t) => Number(t) - 1000),
				shownSeq,
			);
			shownSeq = last;
			// A raw consumer's order after each update equals the server's order
			// at the last tick that update shows.
			const expected = model.history[shownSeq] as string[];
			if (
				!mismatch &&
				JSON.stringify(raw.shown()) !== JSON.stringify(expected)
			)
				mismatch = `raw after seq ${shownSeq}: ${JSON.stringify(raw.shown())} != ${JSON.stringify(expected)}`;
		}
	});
	reconciler.add({
		liveId: "9",
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		target: live,
		segmentRounds: true,
	});
	const version = (attempt: number) => ({
		live_id: "9",
		epoch: "1",
		baseline_sync_attempt: String(attempt),
	});
	const accept = (message: unknown): void => {
		reconciler.accept(message as never);
	};
	// The first baseline.
	accept(
		decodeServerMessage(
			JSON.stringify({
				type: "baseline_sync_start",
				...version(1),
				scope: { kind: "all" },
				mvcc: { xmin: "1", xmax: "1", xip: [] },
			}),
			"neon.realtime.v3",
		),
	);
	accept({
		type: "baseline_sync_batch",
		...version(1),
		index: 0,
		rows: model.order.map((k) => ({
			row_key: k,
			values: [(model.rows.get(k) as SRow).value],
			...((model.rows.get(k) as SRow).tag
				? { segment_tag: (model.rows.get(k) as SRow).tag }
				: {}),
		})),
	});
	accept({ type: "baseline_sync_end", ...version(1), batch_count: 1 });

	for (let i = 0; i < steps; i += 1) {
		if (model.uncovered && rand() < 0.3) model.pin();
		else model.tick();
	}
	model.pin();
	// Deliver ticks and round frames with lag, each stream in order.
	const ticks = model.frames;
	const rounds = model.roundFrames.flat();
	let t = 0;
	let r = 0;
	let delivered = 0;
	const roundOf = new Map<number, [number, number]>();
	for (const f of rounds)
		if (f.kind === "start") roundOf.set(f.round, f.covered);
	let lastEnded: number | undefined;
	const endedThrough: number[] = [];
	try {
		while (t < ticks.length || r < rounds.length) {
			const head = rounds[r];
			let roundReady = head !== undefined;
			if (head?.kind === "start") {
				const [first] = head.covered;
				const previous =
					lastEnded === undefined
						? undefined
						: roundOf.get(lastEnded);
				const previousWaits =
					previous !== undefined &&
					delivered < previous[1] &&
					head.round !== lastEnded;
				roundReady = delivered >= first || previousWaits;
			}
			const takeRound = roundReady && (t >= ticks.length || rand() < 0.5);

			if (takeRound && head) {
				r += 1;
				if (head.kind === "start") {
					accept(
						decodeServerMessage(
							JSON.stringify({
								type: "baseline_sync_start",
								...version(head.attempt),
								scope: {
									kind: "selected",
									ordered: true,
									selectors: head.selectors,
									covered: {
										from_sequence: String(head.covered[0]),
										through_sequence: String(
											head.covered[1],
										),
									},
								},
								mvcc: { xmin: "1", xmax: "1", xip: [] },
							}),
							"neon.realtime.v3",
						),
					);
				} else if (head.kind === "batch") {
					accept(
						decodeServerMessage(
							JSON.stringify({
								type: "baseline_sync_batch",
								...version(head.attempt),
								index: head.index,
								rows: head.rows,
							}),
							"neon.realtime.v3",
						),
					);
				} else if (head.kind === "end") {
					accept({
						type: "baseline_sync_end",
						...version(head.attempt),
						batch_count: head.count,
					});
					lastEnded = head.round;
					endedThrough.push(
						(roundOf.get(head.round) as [number, number])[1],
					);
					const waiting = endedThrough.filter(
						(through) => through > delivered,
					).length;
					if (waiting >= 2) model.stats.waitingInRow += 1;
				}
			} else {
				const tick = ticks[t++] as Extract<Frame, { kind: "tick" }>;
				const pub = `p${tick.seq}`;
				const target = {
					live_id: "9",
					epoch: "1",
					sequence: String(tick.seq),
				};
				const txids = [String(1000 + tick.seq)];
				const bodies: unknown[] = [];
				if (tick.changes.length > 0 || !tick.hole)
					bodies.push({
						type: "keyed_results",
						publication_id: pub,
						txids,
						targets: [target],
						changes: tick.changes,
					});
				if (tick.hole)
					bodies.push({
						type: "segments_pending",
						publication_id: pub,
						txids,
						targets: [target],
					});
				accept({ type: "open", publication_id: pub });
				bodies.forEach((body, index) => {
					accept(
						decodeServerMessage(
							JSON.stringify({ ...(body as object), index }),
							"neon.realtime.v3",
						),
					);
				});
				accept({
					type: "commit",
					publication_id: pub,
					body_count: bodies.length,
					frontier: { lsn: "0/10" },
				});
				delivered = tick.seq;
			}
			if (materialized && !mismatch) {
				const data = (live.getSnapshot().data ?? []).map(
					(v) => v.value,
				);
				const expected = model.history[shownSeq] as string[];
				if (JSON.stringify(data) !== JSON.stringify(expected))
					mismatch = `materialized after seq ${shownSeq}: ${JSON.stringify(data)} != ${JSON.stringify(expected)}`;
			}
		}
	} catch (error) {
		return {
			model,
			error:
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error),
			mismatch,
		};
	}
	if (!mismatch && shownSeq !== model.seq)
		mismatch = `shown ${shownSeq} of ${model.seq}`;
	if (!mismatch && live.getSnapshot().updating) mismatch = "still updating";
	return { model, mismatch };
}

describe("ordered segment rounds against a server history", () => {
	it.each([
		true,
		false,
	])("preserves contents and order (materialized: %s)", (materialized) => {
		const totals = {
			rounds: 0,
			emptyRounds: 0,
			retries: 0,
			rekeyed: 0,
			laterMoves: 0,
			anchorLaterPending: 0,
			waitingInRow: 0,
		};
		for (let seed = 1; seed <= 400; seed += 1) {
			const outcome = run(seed, materialized);
			expect(outcome.error, `seed ${seed}`).toBeUndefined();
			expect(outcome.mismatch, `seed ${seed}`).toBeUndefined();
			for (const key of Object.keys(totals) as (keyof typeof totals)[])
				totals[key] += outcome.model.stats[key];
		}
		// Keep the chosen deterministic seeds exercising the hard cases.
		for (const count of Object.values(totals))
			expect(count).toBeGreaterThan(0);
	});
});
