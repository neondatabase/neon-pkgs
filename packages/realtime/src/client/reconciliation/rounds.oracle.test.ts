import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { WireChange, WireRow } from "../protocol/messages.js";
import type { Subscription } from "../subscription.js";
import {
	flush,
	mvccThrough,
	RawConsumer,
	Session,
	TxidWatch,
	type Value,
	values,
} from "./rounds.test-helpers.js";

/*
 * A model server keeps one table's history and serves it to two live IDs on
 * one socket, one materialized and one raw. Per live ID it delivers each
 * change as exact patches or as a hole whose segments a later round replaces,
 * runs rounds whose batches interleave with ticks, retries them, resets the
 * epoch and sends a new baseline while ticks keep arriving, and shares
 * progress proofs between both. Rows can switch between a multi-row segment
 * and a one-row segment, which the strict scope predicate must survive.
 *
 * The oracle is that history. After every frame each live query must show
 * the table at its visible position, which stops before its first unresolved
 * hole, in order when the result is ordered; its raw consumer, which rejects
 * removes of rows it never saw and applies moves, must agree; and after each
 * server action exactly the transactions of the shown ticks have resolved.
 * An unordered install must also never let two rows hold one value mid-update.
 * The model shares no code with the reconciler.
 */

interface Row {
	readonly v: number;
	readonly tag: string | undefined;
}
type Table = ReadonlyMap<string, Row>;
type Kind = "multi" | "flex" | "one" | "none";

/** How often each interesting case occurred, so the generator can't drift. */
function newCoverage() {
	return {
		installs: 0,
		emptyInstalls: 0,
		retries: 0,
		resets: 0,
		baselinesBehindHoles: 0,
		heldProofs: 0,
		kindFlips: 0,
		ticksDuringRounds: 0,
		coveredPatches: 0,
		coveredRetags: 0,
	};
}
type Coverage = ReturnType<typeof newCoverage>;

const TAGS = ["a", "b", "c"].map((char) => char.repeat(64));
const rowKey = (index: number) => index.toString(16).padStart(64, "0");
const txidOf = (tick: number) => 100 + tick;

interface Feed {
	readonly liveId: string;
	readonly subscription: Subscription<Value>;
	readonly raw: RawConsumer;
	readonly txids: TxidWatch;
	epoch: number;
	attempt: number;
	/** The table position (global tick) each sequence of this epoch shows. */
	positions: number[];
	live: boolean;
	baseline?: {
		attempt: number;
		rows: WireRow[];
		started: boolean;
		batches: number;
	};
	/** Unresolved holes, by sequence. */
	holes: number[];
	/** Segments dirtied by holes no round has pinned yet. */
	dirty: { tags: Set<string>; keys: Set<string> };
	round?: {
		attempt: number;
		readonly from: number;
		readonly through: number;
		readonly rows: WireRow[];
		readonly selectors: object[];
		sent: number;
	};
	/** The table position the live query must show. */
	visible: number;
	/** Whether a baseline has been shown yet. */
	shown: boolean;
}

function run(
	draws: readonly number[],
	ordered: boolean,
	coverage: Coverage,
): Promise<void> {
	let cursor = 0;
	const random = () => {
		const draw = draws[cursor % draws.length] ?? 0;
		cursor += 1;
		return ((draw + cursor * 7919) % 10_000) / 10_000;
	};
	const pick = <Item>(items: readonly Item[]) =>
		items[Math.floor(random() * items.length)] as Item;

	const keyCount = 3 + Math.floor(random() * 6);
	const kinds: Kind[] = Array.from({ length: keyCount }, () =>
		pick<Kind>(
			ordered
				? ["multi", "flex", "one"]
				: ["multi", "flex", "one", "none"],
		),
	);
	const tagFor = (index: number) =>
		kinds[index] === "multi" || (kinds[index] === "flex" && random() < 0.5)
			? pick(TAGS)
			: undefined;
	const history: Table[] = [];
	let table = new Map<string, Row>();
	const freshValue = () => {
		const used = new Set([...table.values()].map(({ v }) => v));
		let v = 0;
		do v = Math.floor(random() * 50);
		while (used.has(v));
		return v;
	};
	for (let index = 0; index < keyCount; index += 1) {
		if (random() < 0.6)
			table.set(rowKey(index), { v: freshValue(), tag: tagFor(index) });
	}
	history.push(table);

	const keysInOrder = (rows: Table) =>
		ordered
			? [...rows.entries()]
					.sort(
						([leftKey, left], [rightKey, right]) =>
							left.v - right.v || (leftKey < rightKey ? -1 : 1),
					)
					.map(([key]) => key)
			: [...rows.keys()];
	const wireRow = (key: string, row: Row): WireRow => ({
		row_key: key,
		values: [String(row.v)],
		...(row.tag === undefined ? {} : { segment_tag: row.tag }),
	});
	const upsert = (key: string, row: Row): WireChange => ({
		op: "upsert",
		...wireRow(key, row),
	});
	const moves = (rows: Table): WireChange[] =>
		keysInOrder(rows).map((key, index, order) => ({
			op: "move",
			row_key: key,
			after_row_key: index === 0 ? null : (order[index - 1] as string),
		}));

	const session = new Session();
	const feeds: Feed[] = [true, false].map((materialized, index) => {
		const liveId = String(index + 1);
		const subscription = session.subscribe(liveId, materialized);
		return {
			liveId,
			subscription,
			raw: new RawConsumer(subscription),
			txids: new TxidWatch(subscription),
			epoch: 1,
			attempt: 0,
			positions: [0],
			live: false,
			holes: [],
			dirty: { tags: new Set(), keys: new Set() },
			visible: 0,
			shown: false,
		};
	});

	const version = (feed: Feed, attempt: number) => ({
		live_id: feed.liveId,
		epoch: String(feed.epoch),
		baseline_sync_attempt: String(attempt),
	});
	const shownPosition = (feed: Feed) =>
		feed.positions[(feed.holes[0] ?? feed.positions.length) - 1] as number;

	const check = (feed: Feed, position: number, where: string) => {
		if (!feed.shown) return;
		const rows = history[position] as Table;
		const want = keysInOrder(rows).map((key) => String(rows.get(key)?.v));
		const sorted = (items: readonly string[]) => [...items].sort();
		const shown = feed.raw.values();
		if (feed.subscription.materialized) {
			const got = values(feed.subscription);
			expect(
				ordered ? got : sorted(got),
				`${where}: materialized`,
			).toEqual(ordered ? want : sorted(want));
		}
		expect(ordered ? shown : sorted(shown), `${where}: raw`).toEqual(
			ordered ? want : sorted(want),
		);
		expect(feed.raw.failures, `${where}: raw consumer`).toEqual([]);
		expect(sorted([...feed.raw.rows.keys()]), `${where}: row keys`).toEqual(
			sorted([...rows.keys()]),
		);
	};
	/** What each live query showed before the current server action. */
	let before: number[] = [];
	/** Deliver one action's frames; only the last may change what is shown. */
	const send = (frames: readonly object[], where: string) => {
		frames.forEach((frame, index) => {
			session.receive(frame);
			const last = index === frames.length - 1;
			feeds.forEach((feed, at) => {
				check(
					feed,
					last ? feed.visible : (before[at] as number),
					where,
				);
			});
		});
	};

	const baselineStep = (feed: Feed) => {
		const baseline = feed.baseline as NonNullable<Feed["baseline"]>;
		const at = version(feed, baseline.attempt);
		const frames: object[] = [];
		if (!baseline.started) {
			baseline.started = true;
			frames.push({
				type: "baseline_sync_start",
				...at,
				scope: { kind: "all" },
				mvcc: mvccThrough(txidOf(feed.positions[0] as number)),
			});
		}
		const finish = random() < 0.5;
		const take = finish
			? baseline.rows.length
			: Math.min(2, baseline.rows.length);
		if (take > 0) {
			frames.push({
				type: "baseline_sync_batch",
				...at,
				index: baseline.batches,
				rows: baseline.rows.slice(0, take),
			});
			baseline.batches += 1;
			baseline.rows = baseline.rows.slice(take);
		}
		if (finish) {
			frames.push({
				type: "baseline_sync_end",
				...at,
				batch_count: baseline.batches,
			});
			feed.baseline = undefined;
			feed.live = true;
			feed.visible = shownPosition(feed);
			if (feed.holes.length > 0) coverage.baselinesBehindHoles += 1;
		}
		if (frames.length > 0) send(frames, "baseline");
		if (finish) feed.shown = true;
	};

	const startBaseline = (feed: Feed, position: number) => {
		feed.attempt += 1;
		feed.baseline = {
			attempt: feed.attempt,
			rows: keysInOrder(history[position] as Table).map((key) =>
				wireRow(key, (history[position] as Table).get(key) as Row),
			),
			started: false,
			batches: 0,
		};
	};

	const tick = () => {
		const previous = table;
		table = new Map(table);
		const written = new Set<string>();
		for (let count = 1 + Math.floor(random() * 3); count > 0; count -= 1) {
			const index = Math.floor(random() * keyCount);
			const old = table.get(rowKey(index));
			if (random() < 0.25) table.delete(rowKey(index));
			else
				table.set(rowKey(index), {
					v: freshValue(),
					tag: tagFor(index),
				});
			const next = table.get(rowKey(index));
			if (
				old &&
				next &&
				(old.tag === undefined) !== (next.tag === undefined)
			) {
				coverage.kindFlips += 1;
			}
			written.add(rowKey(index));
		}
		history.push(table);
		const position = history.length - 1;
		const exact = (keys: Iterable<string>): WireChange[] => {
			const changes: WireChange[] = [];
			for (const key of keys) {
				const row = table.get(key);
				if (row) changes.push(upsert(key, row));
				else if (previous.has(key))
					changes.push({ op: "remove", row_key: key });
			}
			return changes;
		};
		const publicationId = `t${position}`;
		const frames: object[] = [
			{ type: "open", publication_id: publicationId },
		];
		for (const feed of feeds) {
			if (feed.round) coverage.ticksDuringRounds += 1;
			feed.txids.watch(txidOf(position));
			feed.positions.push(position);
			const sequence = feed.positions.length - 1;
			const target = {
				live_id: feed.liveId,
				epoch: String(feed.epoch),
				sequence: String(sequence),
			};
			const clean = feed.dirty.tags.size + feed.dirty.keys.size === 0;
			const hole = (ordered && !clean) || random() < 0.4;
			let changes: WireChange[];
			if (!hole) {
				changes = exact(written);
				if (ordered) changes.push(...moves(table));
			} else {
				const before = feed.dirty.tags.size + feed.dirty.keys.size;
				const patched: string[] = [];
				for (const key of written) {
					const index = Number.parseInt(key, 16);
					if (kinds[index] === "none") {
						patched.push(key);
						continue;
					}
					// A hole may also patch a row of a segment it dirties: the
					// round replaces that segment, so the patch is valid even for
					// an ordered result, whose covered ticks carry no move.
					if (random() < 0.3) {
						patched.push(key);
						coverage.coveredPatches += 1;
						const old = previous.get(key);
						const next = table.get(key);
						if (old && next && old.tag !== next.tag) {
							coverage.coveredRetags += 1;
						}
					}
					for (const row of [previous.get(key), table.get(key)]) {
						if (!row) continue;
						if (row.tag === undefined) feed.dirty.keys.add(key);
						else feed.dirty.tags.add(row.tag);
					}
				}
				if (feed.dirty.tags.size + feed.dirty.keys.size === before) {
					feed.dirty.tags.add(TAGS[0] as string);
				}
				changes = exact(patched);
				feed.holes.push(sequence);
			}
			if (changes.length > 0 || !hole) {
				frames.push({
					type: "keyed_results",
					publication_id: publicationId,
					txids: [String(txidOf(position))],
					targets: [target],
					changes,
				});
			}
			if (hole) {
				frames.push({
					type: "segments_pending",
					publication_id: publicationId,
					txids: [String(txidOf(position))],
					targets: [target],
				});
			}
			if (feed.live && feed.holes.length === 0) feed.visible = position;
		}
		frames.forEach((frame, index) => {
			if (index > 0) Object.assign(frame, { index: index - 1 });
		});
		frames.push({
			type: "commit",
			publication_id: publicationId,
			body_count: frames.length - 1,
			frontier: { lsn: "0/10" },
		});
		send(frames, `tick ${position}`);
	};

	const startRound = (feed: Feed) => {
		const scope = feed.dirty;
		feed.dirty = { tags: new Set(), keys: new Set() };
		const through = feed.positions.length - 1;
		const rows = history[feed.positions[through] as number] as Table;
		const inScope = (key: string, row: Row) =>
			row.tag === undefined
				? scope.keys.has(key)
				: scope.tags.has(row.tag);
		const order = keysInOrder(rows);
		const selected = order.filter((key) =>
			inScope(key, rows.get(key) as Row),
		);
		feed.attempt += 1;
		feed.round = {
			attempt: feed.attempt,
			from: feed.holes[0] as number,
			through,
			selectors: [
				...[...scope.tags].map((tag) => ({ segment_tag: tag })),
				...[...scope.keys].map((key) => ({ row_key: key })),
			],
			rows: selected.map((key, index) => {
				const row = wireRow(key, rows.get(key) as Row);
				if (!ordered) return row;
				const at = order.indexOf(key);
				const anchor = at === 0 ? null : (order[at - 1] as string);
				const implicit =
					index === 0 ? null : (selected[index - 1] as string);
				// Only a round's first row can follow the head, and it does so
				// implicitly, so an explicit anchor is never null.
				return anchor === implicit
					? row
					: { ...row, after_row_key: anchor as string };
			}),
			sent: 0,
		};
		sendStart(feed);
	};
	const sendStart = (feed: Feed) => {
		const round = feed.round as NonNullable<Feed["round"]>;
		round.sent = 0;
		send(
			[
				{
					type: "baseline_sync_start",
					...version(feed, round.attempt),
					scope: {
						kind: "selected",
						selectors: round.selectors,
						covered: {
							from_sequence: String(round.from),
							through_sequence: String(round.through),
						},
						...(ordered ? { ordered: true } : {}),
					},
					mvcc: mvccThrough(
						txidOf(feed.positions[round.through] as number),
					),
				},
			],
			"round start",
		);
	};
	const roundStep = (feed: Feed) => {
		const round = feed.round as NonNullable<Feed["round"]>;
		const choice = random();
		if (choice < 0.15) {
			coverage.retries += 1;
			feed.attempt += 1;
			round.attempt = feed.attempt;
			sendStart(feed);
			return;
		}
		const batch = Math.ceil(round.sent / 2);
		if (choice < 0.6 && round.sent < round.rows.length) {
			send(
				[
					{
						type: "baseline_sync_batch",
						...version(feed, round.attempt),
						index: batch,
						rows: round.rows.slice(round.sent, round.sent + 2),
					},
				],
				"round batch",
			);
			round.sent += 2;
			return;
		}
		const frames: object[] = [];
		let count = batch;
		if (round.sent < round.rows.length) {
			frames.push({
				type: "baseline_sync_batch",
				...version(feed, round.attempt),
				index: count,
				rows: round.rows.slice(round.sent),
			});
			count += 1;
		}
		frames.push({
			type: "baseline_sync_end",
			...version(feed, round.attempt),
			batch_count: count,
		});
		feed.holes = feed.holes.filter((sequence) => sequence > round.through);
		feed.round = undefined;
		feed.visible = shownPosition(feed);
		coverage.installs += 1;
		if (round.rows.length === 0) coverage.emptyInstalls += 1;
		// The install is the first update; later ticks are ordinary ticks.
		feed.raw.strictKeysOnce = !ordered;
		send(frames, "round end");
	};

	const reset = (feed: Feed) => {
		coverage.resets += 1;
		feed.epoch += 1;
		feed.attempt = 0;
		feed.live = false;
		feed.holes = [];
		feed.dirty = { tags: new Set(), keys: new Set() };
		feed.round = undefined;
		const position = history.length - 1;
		feed.positions = [position];
		startBaseline(feed, position);
		send(
			[
				{
					type: "open",
					publication_id: `r${feed.liveId}-${feed.epoch}`,
				},
				{
					type: "reset_required",
					publication_id: `r${feed.liveId}-${feed.epoch}`,
					index: 0,
					targets: [
						{
							live_id: feed.liveId,
							epoch: String(feed.epoch),
							first_sequence: "1",
						},
					],
				},
				{
					type: "commit",
					publication_id: `r${feed.liveId}-${feed.epoch}`,
					body_count: 1,
					frontier: { lsn: "0/10" },
				},
			],
			"reset",
		);
	};

	for (const feed of feeds) startBaseline(feed, 0);
	for (const feed of feeds) {
		while (feed.baseline) {
			before = feeds.map(({ visible }) => visible);
			baselineStep(feed);
		}
	}

	return (async () => {
		for (let step = 0; step < 60; step += 1) {
			const choice = random();
			const feed = pick(feeds);
			before = feeds.map(({ visible }) => visible);
			if (choice < 0.45) tick();
			else if (feed.baseline) baselineStep(feed);
			else if (choice < 0.5) reset(feed);
			else if (choice < 0.58) {
				if (feeds.some((each) => each.live && each.holes.length > 0)) {
					coverage.heldProofs += 1;
				}
				session.progress(txidOf(history.length - 1));
			} else if (feed.round) roundStep(feed);
			else if (
				feed.live &&
				feed.dirty.tags.size + feed.dirty.keys.size > 0
			)
				startRound(feed);
			else tick();
			await flush();
			for (const each of feeds) {
				const want = new Set<number>();
				for (let position = 1; position <= each.visible; position += 1)
					want.add(txidOf(position));
				expect(
					[...each.txids.resolved].sort(),
					`step ${step}: txids of ${each.liveId}`,
				).toEqual([...want].sort());
			}
		}
	})();
}

describe("segment rounds against a history oracle", () => {
	it.each([
		false,
		true,
	])("shows the table at its visible position after every frame (ordered: %s)", async (ordered) => {
		const coverage = newCoverage();
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 0, max: 9_999 }), {
					minLength: 1,
					maxLength: 200,
				}),
				(draws) => run(draws, ordered, coverage),
			),
			{ numRuns: 150 },
		);
		for (const [name, count] of Object.entries(coverage)) {
			expect(count, name).toBeGreaterThan(0);
		}
	}, 60_000);
});
