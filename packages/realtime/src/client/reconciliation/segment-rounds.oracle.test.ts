import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { SILENT_CLIENT_EVENTS } from "../diagnostics.js";
import { createParserRegistry } from "../postgres/parsers.js";
import { ProtocolError } from "../protocol/codec.js";
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
 * its visible sequence, which stops before the first unresolved hole among the
 * ticks it has received, and resolves exactly the transactions of the ticks
 * it shows. The model shares no code with the reconciler.
 *
 * Each scenario gives every row key a kind of segment, as a query's plan
 * does: a multi-row segment whose rows move between two tags, a one-row
 * segment selected by row key, or no segment, so the server always patches
 * the row. The server can also withhold publications and release them later,
 * so a round can end before its covered ticks arrive, retry a round, and reset
 * the epoch. Two server moves break the protocol and must be rejected: a
 * retry that changes its round's scope, covered range or snapshot, and a
 * patch that gives a shown row key another kind of segment.
 */

type Kind = "multi" | "one" | "none";
type Tag = "T1" | "T2";
interface TableRow {
	readonly value: string;
	/** The row's tag; meaningful only for keys of multi-row segments. */
	readonly tag: Tag;
}
type Table = ReadonlyMap<string, TableRow>;
interface Write {
	readonly key: number;
	readonly row: TableRow | null;
	readonly defer: boolean;
}
type Tick = {
	readonly kind: "tick";
	readonly writes: readonly Write[];
	readonly holeFirst: boolean;
};
type Operation =
	| Tick
	| {
			readonly kind: "round";
			readonly all: boolean;
			readonly parts: number;
			readonly endNow: boolean;
	  }
	| { readonly kind: "end" }
	| { readonly kind: "retry" }
	| { readonly kind: "progress" }
	| { readonly kind: "withhold" }
	| { readonly kind: "release" }
	| { readonly kind: "reset" }
	| {
			readonly kind: "badRetry";
			readonly change: "scope" | "covered" | "snapshot";
	  }
	| { readonly kind: "kindChange"; readonly key: number };
interface Scenario {
	readonly kinds: readonly Kind[];
	readonly initial: readonly {
		readonly key: number;
		readonly row: TableRow;
	}[];
	readonly beforeBaseline: readonly Tick[];
	readonly operations: readonly Operation[];
	readonly materialized: boolean;
}

const LIVE_ID = "9";
const KEYS = ["a", "b", "c", "d", "e", "f"].map((char) => char.repeat(64));
const TAGS: Record<Tag, string> = {
	T1: "1".repeat(64),
	T2: "2".repeat(64),
};
const TXID_BASE = 100n;

const keyArbitrary = fc.integer({ min: 0, max: KEYS.length - 1 });
const rowArbitrary = fc.record({
	value: fc.constantFrom("x", "y", "z"),
	tag: fc.constantFrom<Tag>("T1", "T2"),
});
const tickArbitrary: fc.Arbitrary<Tick> = fc.record({
	kind: fc.constant("tick" as const),
	writes: fc.uniqueArray(
		fc.record({
			key: keyArbitrary,
			row: fc.option(rowArbitrary, { nil: null }),
			defer: fc.boolean(),
		}),
		{ selector: (write) => write.key, maxLength: 4 },
	),
	holeFirst: fc.boolean(),
});
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
	{ arbitrary: tickArbitrary, weight: 8 },
	{
		arbitrary: fc.record({
			kind: fc.constant("round" as const),
			all: fc.integer({ min: 0, max: 3 }).map((choice) => choice === 0),
			parts: fc.integer({ min: 1, max: 3 }),
			endNow: fc.boolean(),
		}),
		weight: 4,
	},
	{ arbitrary: fc.constant({ kind: "end" as const }), weight: 2 },
	{ arbitrary: fc.constant({ kind: "retry" as const }), weight: 1 },
	{ arbitrary: fc.constant({ kind: "progress" as const }), weight: 1 },
	{ arbitrary: fc.constant({ kind: "withhold" as const }), weight: 2 },
	{ arbitrary: fc.constant({ kind: "release" as const }), weight: 2 },
	{ arbitrary: fc.constant({ kind: "reset" as const }), weight: 1 },
	{
		arbitrary: fc.record({
			kind: fc.constant("badRetry" as const),
			change: fc.constantFrom<"scope" | "covered" | "snapshot">(
				"scope",
				"covered",
				"snapshot",
			),
		}),
		weight: 1,
	},
	{
		arbitrary: fc.record({
			kind: fc.constant("kindChange" as const),
			key: keyArbitrary,
		}),
		weight: 1,
	},
);
const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
	kinds: fc.array(fc.constantFrom<Kind>("multi", "one", "none"), {
		minLength: KEYS.length,
		maxLength: KEYS.length,
	}),
	initial: fc.uniqueArray(
		fc.record({ key: keyArbitrary, row: rowArbitrary }),
		{
			selector: (row) => row.key,
			maxLength: KEYS.length,
		},
	),
	beforeBaseline: fc.array(tickArbitrary, { maxLength: 3 }),
	operations: fc.array(operationArbitrary, { maxLength: 40 }),
	materialized: fc.boolean(),
});

describe("segment round reconciliation against a table history", () => {
	it("shows the table at the visible sequence, resolves only its transactions, and rejects broken rounds and patches", async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArbitrary, async (scenario) => {
				const run = new ModelRun(scenario.kinds, scenario.materialized);
				for (const { key, row } of scenario.initial)
					run.table.set(KEYS[key] as string, row);
				run.history.push(new Map(run.table));
				for (const tick of scenario.beforeBaseline) run.tick(tick);
				run.baseline();
				await run.check();
				for (const operation of scenario.operations) {
					run.apply(operation);
					// A rejected server move ends the session; nothing follows it.
					if (run.rejected) return;
					await run.check();
				}
				// Every hole eventually resolves, and the result is then the table.
				run.apply({ kind: "release" });
				run.apply({ kind: "end" });
				while (run.serverHole() !== undefined) {
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
			{ numRuns: 400 },
		);
	});
});

type Scope = Extract<ServerMessage, { type: "baseline_sync_start" }>["scope"];
type Mvcc = Extract<ServerMessage, { type: "progress" }>["mvcc"];

interface OpenRound {
	readonly round: number;
	attempt: number;
	readonly scope: Scope;
	readonly covered: { readonly first: number; readonly last: number };
	readonly mvcc: Mvcc;
	readonly rows: readonly WireRow[];
	readonly parts: number;
}

class ModelRun {
	readonly table = new Map<string, TableRow>();
	/** The table after each tick of every epoch; index 0 is the first baseline. */
	readonly history: Table[] = [];
	/** The last tick of the current epoch, committed by the server. */
	sequence = 0;
	/** Set once the client rejected a broken server move, as it must. */
	rejected = false;
	private epoch = 1;
	/** The global tick the current epoch's baseline shows. */
	private epochStart = 0;
	/** The last tick of the epoch delivered to the client. */
	private received = 0;
	private withholding = false;
	private readonly withheld: ServerMessage[][] = [];
	private holes: number[] = [];
	/** The covered range of every ended round of the epoch, in order. */
	private ended: { readonly first: number; readonly last: number }[] = [];
	private dirtyTags = new Set<string>();
	private dirtyKeys = new Set<string>();
	private nextRound = 2;
	private nextAttempt = 2;
	private open?: OpenRound;
	private readonly resolved = new Set<number>();
	private readonly reconciler = new BaselineSyncPublicationReconciler();
	private readonly subscription: Subscription<{ readonly value: string }>;
	private readonly rawRows = new Map<string, string>();

	constructor(
		private readonly kinds: readonly Kind[],
		materialized: boolean,
	) {
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
				if (!this.open) return;
				this.open.attempt = this.nextAttempt++;
				this.sendAttempt(this.open);
				return;
			case "progress":
				this.send({
					type: "progress",
					mvcc: snapshotThrough(this.epochStart + this.received),
				});
				return;
			case "withhold":
				this.withholding = true;
				return;
			case "release":
				this.release();
				return;
			case "reset":
				this.reset();
				return;
			case "badRetry":
				this.badRetry(operation.change);
				return;
			case "kindChange":
				this.kindChange(operation.key);
				return;
		}
	}

	tick(tick: Tick): void {
		const sequence = this.sequence + 1;
		const changes: WireChange[] = [];
		let hole = false;
		for (const write of tick.writes) {
			const key = KEYS[write.key] as string;
			const kind = this.kinds[write.key] as Kind;
			const before = this.table.get(key);
			if (!before && !write.row) continue;
			if (write.row) this.table.set(key, write.row);
			else this.table.delete(key);
			// Deferral replaces the row's old and new segments in a round, so a
			// row outside segments is always patched.
			if (write.defer && kind !== "none") {
				hole = true;
				if (kind === "one") this.dirtyKeys.add(key);
				else
					for (const row of [before, write.row])
						if (row) this.dirtyTags.add(TAGS[row.tag]);
			} else if (write.row) {
				changes.push(upsertChange(key, kind, write.row));
			} else {
				changes.push({ op: "remove", row_key: key });
			}
		}
		this.sequence = sequence;
		this.history.push(new Map(this.table));
		const global = this.history.length - 1;
		if (hole) this.holes.push(sequence);
		const publicationId = `p${global}`;
		const target = {
			live_id: LIVE_ID,
			epoch: String(this.epoch),
			sequence: String(sequence),
		};
		const txids = [String(TXID_BASE + BigInt(global))];
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
		const publication: ServerMessage[] = [
			{ type: "open", publication_id: publicationId },
			...bodies.map((body, index) => ({ ...body, index })),
			{
				type: "commit",
				publication_id: publicationId,
				body_count: bodies.length,
				frontier: { lsn: `0/${global.toString(16).toUpperCase()}` },
			},
		];
		if (this.withholding) this.withheld.push(publication);
		else this.deliver(publication);
		this.subscription
			.awaitTxId(txids[0] as string)
			.then(() => this.resolved.add(global));
	}

	baseline(): void {
		const rows = [
			...(this.history[this.epochStart] ?? new Map()).entries(),
		].map(([key, row]) => this.wireRow(key, row));
		const round = this.epoch === 1 ? 1 : this.nextRound++;
		const attempt = this.epoch === 1 ? 1 : this.nextAttempt++;
		const version = {
			live_id: LIVE_ID,
			epoch: String(this.epoch),
			baseline_sync_attempt: String(attempt),
			round: String(round),
		};
		this.send({
			type: "baseline_sync_start",
			...version,
			scope: { kind: "all" },
			mvcc: snapshotThrough(this.epochStart),
		});
		this.send({ type: "baseline_sync_batch", ...version, index: 0, rows });
		this.send({ type: "baseline_sync_end", ...version, batch_count: 1 });
	}

	round(all: boolean, parts: number, endNow: boolean): void {
		const first = this.serverHole();
		if (this.open || first === undefined) return;
		// The client checks the first covered hole against what it received,
		// unless an earlier round still waits for its ticks.
		if (first > this.received && !this.waiting()) return;
		// The round pins the table now and closes the keys of the holes so far.
		const last = this.sequence;
		const tags = this.dirtyTags;
		const keys = this.dirtyKeys;
		this.dirtyTags = new Set();
		this.dirtyKeys = new Set();
		const rows = [...this.table.entries()]
			.filter(([key, row]) => {
				if (all) return true;
				const kind = this.kind(key);
				return kind === "one"
					? keys.has(key)
					: kind === "multi" && tags.has(TAGS[row.tag]);
			})
			.map(([key, row]) => this.wireRow(key, row));
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
			mvcc: snapshotThrough(this.epochStart + last),
			rows,
			parts,
		};
		this.sendAttempt(this.open);
		if (endNow) this.end();
	}

	end(): void {
		const open = this.open;
		if (!open) return;
		this.send({
			type: "baseline_sync_end",
			...this.version(open),
			batch_count: open.parts,
		});
		this.ended.push(open.covered);
		this.open = undefined;
	}

	/** The first hole the server has not yet put in a round. */
	serverHole(): number | undefined {
		const pinned = this.ended.at(-1)?.last ?? 0;
		return this.holes.find((hole) => hole > pinned);
	}

	visibleSequence(): number {
		// An ended round installs once every covered tick has arrived.
		const installed = this.ended
			.filter(({ last }) => last <= this.received)
			.reduce((through, { last }) => Math.max(through, last), 0);
		const hole = this.holes.find(
			(hole) => hole > installed && hole <= this.received,
		);
		return hole === undefined ? this.received : hole - 1;
	}

	async check(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const visible = this.epochStart + this.visibleSequence();
		const expected = [...(this.history[visible] ?? new Map()).entries()]
			.map(([key, row]) => `${key[0]}:${row.value}`)
			.sort();
		expect([...this.rawRows.values()].sort()).toEqual(expected);
		if (this.subscription.materialized) {
			const snapshot = this.subscription.getSnapshot();
			expect(
				(snapshot.data ?? []).map(({ value }) => value).sort(),
			).toEqual(expected);
			expect(snapshot.updating).toBe(
				this.visibleSequence() < this.received,
			);
		}
		const shown = new Set<number>();
		for (let tick = 1; tick <= visible; tick += 1) shown.add(tick);
		expect(this.resolved).toEqual(shown);
	}

	private waiting(): boolean {
		return this.ended.some(({ last }) => last > this.received);
	}

	private release(): void {
		this.withholding = false;
		for (const publication of this.withheld.splice(0))
			this.deliver(publication);
	}

	private reset(): void {
		this.release();
		const epoch = this.epoch + 1;
		const publicationId = `reset${epoch}`;
		this.deliver([
			{ type: "open", publication_id: publicationId },
			{
				type: "reset_required",
				publication_id: publicationId,
				index: 0,
				targets: [
					{
						live_id: LIVE_ID,
						epoch: String(epoch),
						first_sequence: "1",
					},
				],
			},
			{
				type: "commit",
				publication_id: publicationId,
				body_count: 1,
				frontier: { lsn: "0/10" },
			},
		]);
		this.epoch = epoch;
		this.epochStart = this.history.length - 1;
		this.sequence = 0;
		this.received = 0;
		this.holes = [];
		this.ended = [];
		this.open = undefined;
		this.dirtyTags = new Set();
		this.dirtyKeys = new Set();
		this.baseline();
	}

	/** A retry that changes its round's plan, which the client must reject. */
	private badRetry(change: "scope" | "covered" | "snapshot"): void {
		const open = this.open;
		if (!open) return;
		const scope: Scope =
			change !== "scope"
				? open.scope
				: open.scope.kind === "all"
					? ({
							kind: "selected",
							selectors: [{ tag: TAGS.T1 }],
						} as Scope)
					: open.scope.selectors.length > 1
						? ({
								kind: "selected",
								selectors: open.scope.selectors.slice(1),
							} as Scope)
						: { kind: "all" };
		const covered =
			change === "covered"
				? { ...open.covered, last: open.covered.last + 1 }
				: open.covered;
		const mvcc =
			change === "snapshot"
				? snapshotThrough(this.epochStart + open.covered.last + 1)
				: open.mvcc;
		this.expectRejected(() =>
			this.sendAttempt({
				...open,
				attempt: this.nextAttempt++,
				scope,
				covered,
				mvcc,
			}),
		);
	}

	/** A patch that gives a shown row key another kind of segment. */
	private kindChange(keyIndex: number): void {
		const key = KEYS[keyIndex] as string;
		const shown = this.history[this.epochStart + this.visibleSequence()];
		const row = shown?.get(key);
		// Only a live tick applies at once; a row in a waiting segment does not.
		if (
			!row ||
			this.withholding ||
			this.open ||
			this.visibleSequence() !== this.sequence ||
			!isDeepStrictEqualRow(this.table.get(key), row)
		)
			return;
		const kind = this.kind(key);
		const values = [`${key[0]}:${row.value}`];
		const change: WireChange =
			kind === "multi"
				? { op: "upsert", row_key: key, values }
				: { op: "upsert", row_key: key, values, segment_tag: TAGS.T1 };
		const sequence = String(this.sequence + 1);
		const publicationId = "kind-change";
		this.expectRejected(() =>
			this.deliver([
				{ type: "open", publication_id: publicationId },
				{
					type: "keyed_results",
					publication_id: publicationId,
					index: 0,
					txids: ["1"],
					targets: [
						{
							live_id: LIVE_ID,
							epoch: String(this.epoch),
							sequence,
						},
					],
					changes: [change],
				},
				{
					type: "commit",
					publication_id: publicationId,
					body_count: 1,
					frontier: { lsn: "0/10" },
				},
			]),
		);
	}

	private expectRejected(move: () => void): void {
		expect(move).toThrow(ProtocolError);
		this.rejected = true;
	}

	private deliver(publication: readonly ServerMessage[]): void {
		for (const message of publication) this.send(message);
		const commit = publication.at(-1);
		if (
			commit?.type === "commit" &&
			!commit.publication_id.startsWith("reset")
		)
			this.received += 1;
	}

	private send(message: ServerMessage): void {
		this.reconciler.accept(
			message as Parameters<
				BaselineSyncPublicationReconciler["accept"]
			>[0],
		);
	}

	private sendAttempt(open: OpenRound): void {
		this.send({
			type: "baseline_sync_start",
			...this.version(open),
			scope: open.scope,
			mvcc: open.mvcc,
			covered: {
				first_sequence: String(open.covered.first),
				last_sequence: String(open.covered.last),
			},
		});
		const size = Math.ceil(open.rows.length / open.parts);
		for (let index = 0; index < open.parts; index += 1) {
			this.send({
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
			epoch: String(this.epoch),
			baseline_sync_attempt: String(open.attempt),
			round: String(open.round),
		};
	}

	private kind(key: string): Kind {
		return this.kinds[KEYS.indexOf(key)] as Kind;
	}

	private wireRow(key: string, row: TableRow): WireRow {
		const values = [`${key[0]}:${row.value}`];
		return this.kind(key) === "multi"
			? { row_key: key, values, segment_tag: TAGS[row.tag] }
			: { row_key: key, values };
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

function upsertChange(key: string, kind: Kind, row: TableRow): WireChange {
	const values = [`${key[0]}:${row.value}`];
	return kind === "multi"
		? { op: "upsert", row_key: key, values, segment_tag: TAGS[row.tag] }
		: { op: "upsert", row_key: key, values };
}

function isDeepStrictEqualRow(
	left: TableRow | undefined,
	right: TableRow,
): boolean {
	return left?.value === right.value && left.tag === right.tag;
}

/** A snapshot that sees the transaction of every global tick through `tick`. */
function snapshotThrough(tick: number) {
	const xmax = String(TXID_BASE + BigInt(tick) + 1n);
	return { xmin: xmax, xmax, xip: [] };
}
