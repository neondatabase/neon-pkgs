import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { SILENT_CLIENT_EVENTS } from "../diagnostics.js";
import { createParserRegistry } from "../postgres/parsers.js";
import type {
	ServerMessage,
	WireChange,
	WireRow,
} from "../protocol/messages.js";
import { Subscription } from "../subscription.js";
import type { RawLiveQueryUpdate } from "../types.js";
import { BaselineSyncPublicationReconciler } from "./reconciler.js";

/*
 * A model server keeps a table's history and delivers each tick either as
 * exact patches or as a hole whose rows a later round replaces. The oracle is
 * that history: after every frame, the live query shows exactly the table at
 * its visible sequence, which stops before the first unresolved hole, and
 * resolves exactly the transactions of the ticks it shows. The model shares
 * no code with the reconciler.
 *
 * A row key's kind of segment is fixed, as a query's segment structure is:
 * the first keys belong to multi-row segments and can move between tags, the
 * next ones are one-row segments selected by row key, and the last is outside
 * every segment, so the server always patches it.
 */

type Segment = "T1" | "T2" | "one" | "none";
interface TableRow {
	readonly value: string;
	readonly segment: Segment;
}
type Table = ReadonlyMap<string, TableRow>;
interface Write {
	readonly key: number;
	readonly row: TableRow | null;
	readonly defer: boolean;
}
type Operation =
	| {
			readonly kind: "tick";
			readonly writes: readonly Write[];
			readonly holeFirst: boolean;
	  }
	| {
			readonly kind: "round";
			readonly all: boolean;
			readonly parts: number;
			readonly endNow: boolean;
	  }
	| { readonly kind: "end" }
	| { readonly kind: "retry" }
	| { readonly kind: "progress" };
interface Scenario {
	readonly initial: readonly {
		readonly key: number;
		readonly row: TableRow;
	}[];
	readonly beforeBaseline: readonly Extract<Operation, { kind: "tick" }>[];
	readonly operations: readonly Operation[];
	readonly materialized: boolean;
}

const LIVE_ID = "9";
const KEYS = ["a", "b", "c", "d", "e", "f"].map((char) => char.repeat(64));
const ONE_ROW_KEYS = 3;
const OUTSIDE_KEY = 5;
const TAGS: Record<"T1" | "T2", string> = {
	T1: "1".repeat(64),
	T2: "2".repeat(64),
};
const TXID_BASE = 100n;

/** A row for a key, in the kind of segment that key belongs to. */
function rowFor(key: number) {
	return fc.record({
		value: fc.constantFrom("x", "y", "z"),
		segment:
			key === OUTSIDE_KEY
				? fc.constant<Segment>("none")
				: key >= ONE_ROW_KEYS
					? fc.constant<Segment>("one")
					: fc.constantFrom<Segment>("T1", "T2"),
	});
}
const keyArbitrary = fc.integer({ min: 0, max: KEYS.length - 1 });
const tickArbitrary = fc.record({
	kind: fc.constant("tick" as const),
	writes: fc.uniqueArray(
		keyArbitrary.chain((key) =>
			fc.record({
				key: fc.constant(key),
				row: fc.option(rowFor(key), { nil: null }),
				defer: fc.boolean(),
			}),
		),
		{ selector: (write) => write.key, maxLength: 4 },
	),
	holeFirst: fc.boolean(),
});
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
	{ arbitrary: tickArbitrary, weight: 6 },
	{
		arbitrary: fc.record({
			kind: fc.constant("round" as const),
			all: fc.integer({ min: 0, max: 3 }).map((choice) => choice === 0),
			parts: fc.integer({ min: 1, max: 3 }),
			endNow: fc.boolean(),
		}),
		weight: 3,
	},
	{ arbitrary: fc.constant({ kind: "end" as const }), weight: 1 },
	{ arbitrary: fc.constant({ kind: "retry" as const }), weight: 1 },
	{ arbitrary: fc.constant({ kind: "progress" as const }), weight: 1 },
);
const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
	initial: fc.uniqueArray(
		keyArbitrary.chain((key) =>
			fc.record({ key: fc.constant(key), row: rowFor(key) }),
		),
		{ selector: (row) => row.key, maxLength: KEYS.length },
	),
	beforeBaseline: fc.array(tickArbitrary, { maxLength: 3 }),
	operations: fc.array(operationArbitrary, { maxLength: 30 }),
	materialized: fc.boolean(),
});

describe("segment round reconciliation against a table history", () => {
	it("shows the table at the visible sequence and resolves only its transactions", async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArbitrary, async (scenario) => {
				const run = new ModelRun(scenario.materialized);
				for (const { key, row } of scenario.initial)
					run.table.set(KEYS[key] as string, row);
				run.history.push(new Map(run.table));
				for (const tick of scenario.beforeBaseline) run.tick(tick);
				run.baseline();
				await run.check();
				for (const operation of scenario.operations) {
					run.apply(operation);
					await run.check();
				}
				// Every hole eventually resolves, and the result is then the table.
				run.apply({ kind: "end" });
				while (run.unresolvedHole() !== undefined) {
					run.apply({
						kind: "round",
						all: false,
						parts: 1,
						endNow: true,
					});
				}
				await run.check();
				expect(run.visibleSequence()).toBe(run.sequence);
			}),
			{ numRuns: 300 },
		);
	});
});

type Scope = Extract<ServerMessage, { type: "baseline_sync_start" }>["scope"];

interface OpenRound {
	readonly round: number;
	attempt: number;
	readonly scope: Scope;
	readonly covered: { readonly first: number; readonly last: number };
	readonly rows: readonly WireRow[];
	readonly parts: number;
}

class ModelRun {
	readonly table = new Map<string, TableRow>();
	/** The table after each tick; index 0 is the baseline. */
	readonly history: Table[] = [];
	sequence = 0;
	private readonly holes: number[] = [];
	/** The last tick a round the client installed covers. */
	private resolvedThrough = 0;
	private dirtyTags = new Set<string>();
	private dirtyKeys = new Set<string>();
	private nextRound = 2;
	private nextAttempt = 2;
	private open?: OpenRound;
	private readonly resolved = new Set<number>();
	private readonly reconciler = new BaselineSyncPublicationReconciler();
	private readonly subscription: Subscription<{ readonly value: string }>;
	private readonly rawRows = new Map<string, string>();

	constructor(materialized: boolean) {
		this.subscription = new Subscription(
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
		this.subscription.admit([
			{ name: "value", type_oid: 25, typmod: -1, codec: "pg_text" },
		]);
		this.subscription.onUpdate((update) => this.observe(update));
		this.reconciler.add({
			liveId: LIVE_ID,
			epoch: "1",
			firstSequence: "1",
			columnCount: 1,
			target: this.subscription,
			segmentRounds: true,
		});
	}

	apply(operation: Operation): void {
		switch (operation.kind) {
			case "tick":
				this.tick(operation);
				return;
			case "round":
				this.round(operation.all, operation.parts, operation.endNow);
				return;
			case "end":
				this.end();
				return;
			case "retry":
				this.retry();
				return;
			case "progress":
				this.reconciler.accept({
					type: "progress",
					mvcc: snapshotThrough(this.sequence),
				});
				return;
		}
	}

	tick(tick: Extract<Operation, { kind: "tick" }>): void {
		const sequence = this.sequence + 1;
		const changes: WireChange[] = [];
		let hole = false;
		for (const write of tick.writes) {
			const key = KEYS[write.key] as string;
			const before = this.table.get(key);
			if (!before && !write.row) continue;
			if (write.row) this.table.set(key, write.row);
			else this.table.delete(key);
			// Deferral replaces the row's old and new segments in a round, so
			// neither may be outside segments.
			const deferrable =
				before?.segment !== "none" && write.row?.segment !== "none";
			if (write.defer && deferrable) {
				hole = true;
				for (const row of [before, write.row]) {
					if (!row) continue;
					if (row.segment === "one") this.dirtyKeys.add(key);
					else this.dirtyTags.add(TAGS[row.segment as "T1" | "T2"]);
				}
			} else if (write.row) {
				changes.push(upsertChange(key, write.row));
			} else {
				changes.push({ op: "remove", row_key: key });
			}
		}
		this.sequence = sequence;
		this.history.push(new Map(this.table));
		if (hole) this.holes.push(sequence);
		const publicationId = `p${sequence}`;
		const target = {
			live_id: LIVE_ID,
			epoch: "1",
			sequence: String(sequence),
		};
		const txids = [String(TXID_BASE + BigInt(sequence))];
		const keyed = {
			type: "keyed_results" as const,
			publication_id: publicationId,
			txids,
			targets: [target],
			changes,
		};
		const pending = {
			type: "segments_pending" as const,
			publication_id: publicationId,
			txids,
			targets: [target],
		};
		const bodies = !hole
			? [keyed]
			: changes.length === 0
				? [pending]
				: tick.holeFirst
					? [pending, keyed]
					: [keyed, pending];
		this.reconciler.accept({ type: "open", publication_id: publicationId });
		bodies.forEach((body, index) => {
			this.reconciler.accept({ ...body, index });
		});
		this.reconciler.accept({
			type: "commit",
			publication_id: publicationId,
			body_count: bodies.length,
			frontier: { lsn: `0/${sequence.toString(16).toUpperCase()}` },
		});
		this.subscription
			.awaitTxId(txids[0] as string)
			.then(() => this.resolved.add(sequence));
	}

	baseline(): void {
		const rows = [...(this.history[0] ?? new Map()).entries()].map(
			([key, row]) => wireRow(key, row),
		);
		const version = {
			live_id: LIVE_ID,
			epoch: "1",
			baseline_sync_attempt: "1",
			round: "1",
		};
		this.reconciler.accept({
			type: "baseline_sync_start",
			...version,
			scope: { kind: "all" },
			mvcc: snapshotThrough(0),
		});
		this.reconciler.accept({
			type: "baseline_sync_batch",
			...version,
			index: 0,
			rows,
		});
		this.reconciler.accept({
			type: "baseline_sync_end",
			...version,
			batch_count: 1,
		});
	}

	round(all: boolean, parts: number, endNow: boolean): void {
		const first = this.unresolvedHole();
		if (this.open || first === undefined) return;
		// The round pins the table now and closes the keys of the holes so far.
		const last = this.sequence;
		const tags = this.dirtyTags;
		const keys = this.dirtyKeys;
		this.dirtyTags = new Set();
		this.dirtyKeys = new Set();
		const rows = [...this.table.entries()]
			.filter(
				([key, row]) =>
					all ||
					(row.segment === "one"
						? keys.has(key)
						: row.segment !== "none" &&
							tags.has(TAGS[row.segment])),
			)
			.map(([key, row]) => wireRow(key, row));
		this.open = {
			round: this.nextRound++,
			attempt: this.nextAttempt++,
			scope: all
				? { kind: "all" }
				: ({
						kind: "selected",
						selectors: [
							...[...tags].map((tag) => ({ tag })),
							...[...keys].map((row_key) => ({ row_key })),
						],
					} as Scope),
			covered: { first, last },
			rows,
			parts,
		};
		this.sendAttempt();
		if (endNow) this.end();
	}

	retry(): void {
		if (!this.open) return;
		this.open.attempt = this.nextAttempt++;
		this.sendAttempt();
	}

	end(): void {
		const open = this.open;
		if (!open) return;
		this.reconciler.accept({
			type: "baseline_sync_end",
			...this.version(open),
			batch_count: open.parts,
		});
		this.resolvedThrough = open.covered.last;
		this.open = undefined;
	}

	unresolvedHole(): number | undefined {
		return this.holes.find((hole) => hole > this.resolvedThrough);
	}

	visibleSequence(): number {
		const hole = this.unresolvedHole();
		return hole === undefined ? this.sequence : hole - 1;
	}

	async check(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const visible = this.visibleSequence();
		const expected = [...(this.history[visible] ?? new Map()).entries()]
			.map(([key, row]) => `${key[0]}:${row.value}`)
			.sort();
		expect([...this.rawRows.values()].sort()).toEqual(expected);
		if (this.subscription.materialized) {
			const snapshot = this.subscription.getSnapshot();
			expect(
				(snapshot.data ?? []).map(({ value }) => value).sort(),
			).toEqual(expected);
			expect(snapshot.updating).toBe(this.unresolvedHole() !== undefined);
		}
		const shown = new Set<number>();
		for (let tick = 1; tick <= visible; tick += 1) shown.add(tick);
		expect(this.resolved).toEqual(shown);
	}

	private sendAttempt(): void {
		const open = this.open as OpenRound;
		this.reconciler.accept({
			type: "baseline_sync_start",
			...this.version(open),
			scope: open.scope,
			mvcc: snapshotThrough(open.covered.last),
			covered: {
				first_sequence: String(open.covered.first),
				last_sequence: String(open.covered.last),
			},
		});
		const size = Math.ceil(open.rows.length / open.parts);
		for (let index = 0; index < open.parts; index += 1) {
			this.reconciler.accept({
				type: "baseline_sync_batch",
				...this.version(open),
				index,
				rows: open.rows.slice(index * size, (index + 1) * size),
			});
		}
	}

	private version(open: OpenRound) {
		return {
			live_id: LIVE_ID,
			epoch: "1",
			baseline_sync_attempt: String(open.attempt),
			round: String(open.round),
		};
	}

	/** Apply raw updates as a strict consumer would, rejecting unknown removes. */
	private observe(update: RawLiveQueryUpdate<{ readonly value: string }>) {
		if (update.type === "rows") {
			this.rawRows.clear();
			for (const { rowId, row } of update.rows)
				this.rawRows.set(rowId, row.value);
			return;
		}
		for (const change of update.changes) {
			if (change.type === "remove") {
				expect(this.rawRows.has(change.rowId)).toBe(true);
				this.rawRows.delete(change.rowId);
			} else if (change.type === "upsert") {
				this.rawRows.set(change.rowId, change.row.value);
			}
		}
	}
}

function wireRow(key: string, row: TableRow): WireRow {
	const values = [`${key[0]}:${row.value}`];
	return row.segment === "T1" || row.segment === "T2"
		? { row_key: key, values, segment_tag: TAGS[row.segment] }
		: { row_key: key, values };
}

function upsertChange(key: string, row: TableRow): WireChange {
	const { values, segment_tag } = wireRow(key, row);
	return segment_tag === undefined
		? { op: "upsert", row_key: key, values }
		: { op: "upsert", row_key: key, values, segment_tag };
}

/** A snapshot that sees the transaction of every tick through `sequence`. */
function snapshotThrough(sequence: number) {
	const xmax = String(TXID_BASE + BigInt(sequence) + 1n);
	return { xmin: xmax, xmax, xip: [] };
}
