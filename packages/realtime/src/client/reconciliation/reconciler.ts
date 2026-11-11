import {
	mergeMvccSnapshots,
	type ParsedMvccSnapshot,
	parseMvccSnapshot,
} from "../mvcc.js";
import { ProtocolError } from "../protocol/codec.js";
import type {
	MvccSnapshot,
	ServerMessage,
	WireChange,
	WireRow,
} from "../protocol/messages.js";

import { validateChangeOrder } from "./ordered-changes.js";
import { SegmentIndex } from "./segment-index.js";

export interface ReconciledBatch {
	readonly changes: readonly WireChange[];
	readonly txids: readonly string[];
}

export interface ReconciliationTarget {
	/** Observe a baseline-sync attempt after reconciliation accepts it. */
	baselineSyncStarted(): void;
	/** Prepare all candidate state without mutating visible rows or snapshots.
	 * The returned installer must not fail or invoke application callbacks.
	 */
	prepare(
		rows: readonly WireRow[] | undefined,
		batches: readonly ReconciledBatch[],
	): () => void;
	/** Notify raw listeners after all state for this publication is installed. */
	publishReset(rows: readonly WireRow[], mvcc: MvccSnapshot): void;
	/** Notify listeners after all state for this publication is installed. */
	publishBatch(batch: ReconciledBatch): void;
	/**
	 * Notify listeners of an installed round as one update, then apply the
	 * round's snapshot. `updating` tells whether a hole remains unresolved.
	 */
	publishRound(
		batch: ReconciledBatch,
		mvcc: MvccSnapshot,
		updating: boolean,
	): void;
	/** Observe a hole becoming pending, or every hole being discarded. */
	updatingChanged(updating: boolean): void;
	/** Confirm installed progress without notifying row listeners. */
	applyProgress(mvcc: ParsedMvccSnapshot): void;
	/** Publish the one fully caught-up materialized view and enter `live`. */
	caughtUp(): void;
	/** Observe a baseline sync after installation and before application callbacks. */
	baselineSyncCompleted(batchCount: number): void;
	/** Leave `live` while the proxy obtains a replacement baseline. */
	resetRequired(): void;
	/** Fail only this subscription when decoding its values fails. */
	decodeFailed(error: unknown): void;
}

export interface AddReconciliationTarget {
	readonly liveId: string;
	readonly epoch: string;
	readonly firstSequence: string;
	readonly columnCount: number;
	readonly target: ReconciliationTarget;
	readonly lifecycle?: ReconciliationLifecycle;
	/**
	 * Whether the session can deliver holes and segment rounds, so the target
	 * keeps a segment index. Protocol v2 cannot.
	 */
	readonly segmentRounds?: boolean;
}

/** Observe reconciliation milestones without wrapping the delivery target. */
export interface ReconciliationLifecycle {
	baselineCompleted(): void;
	interrupted(): void;
}

export interface ReconciliationEventSink {
	publicationCommitted(bodyCount: number): void;
}

const SILENT_RECONCILIATION_EVENTS: ReconciliationEventSink = Object.freeze({
	publicationCommitted: () => undefined,
});

interface BaselineSyncVersion {
	readonly epoch: bigint;
	readonly round: bigint;
	readonly attempt: bigint;
}

/** What a round that resolves holes replaces. */
interface RoundScope {
	readonly all: boolean;
	readonly tags: ReadonlySet<string>;
	readonly rowKeys: ReadonlySet<string>;
}

interface CoveredRange {
	readonly first: bigint;
	readonly last: bigint;
}

interface PendingBaselineSync {
	readonly version: BaselineSyncVersion;
	readonly mvcc: MvccSnapshot;
	/** Present for a round that resolves holes; absent when it starts an epoch. */
	readonly resolves?: {
		readonly scope: RoundScope;
		readonly covered: CoveredRange;
	};
	nextBatch: number;
	rows: WireRow[];
	rowKeys: Set<string>;
	/** The final batch count, once `baseline_sync_end` has arrived. */
	batchCount?: number;
}

/** A committed tick the visible result does not show yet. */
interface BufferedTick {
	readonly batch: ReconciledBatch;
	readonly sequence: bigint;
	/** The tick committed a hole: some of its rows arrive in a round. */
	readonly hole: boolean;
}

/** A progress proof held behind a hole, with the last tick received before it. */
interface HeldProgress {
	readonly arrived: bigint;
	mvcc: ParsedMvccSnapshot;
}

interface TargetState {
	readonly target: ReconciliationTarget;
	readonly lifecycle?: ReconciliationLifecycle;
	readonly columnCount: number;
	readonly index?: SegmentIndex;
	active: boolean;
	epoch: bigint;
	nextSequence: bigint;
	latestBaselineSync?: BaselineSyncVersion;
	/** The attempt being received, if any. */
	baselineSync?: PendingBaselineSync;
	/**
	 * Ended rounds that resolve holes, oldest first, waiting until every tick
	 * of their covered range has arrived. At most one per unresolved hole.
	 */
	waiting: PendingBaselineSync[];
	/**
	 * Before the first baseline, every committed tick. Once live, the ticks
	 * from the first unresolved hole on, so the first one, if any, is a hole.
	 */
	backlog: BufferedTick[];
	/** The number of holes in the backlog. */
	holes: number;
	heldProgress: HeldProgress[];
	live: boolean;
}

interface StagedTarget {
	readonly changes: WireChange[];
	readonly txids: readonly string[];
	readonly nextSequence: bigint;
	hole: boolean;
}

interface StagedReset {
	readonly epoch: bigint;
	readonly firstSequence: bigint;
}

interface PendingPublication {
	readonly id: string;
	nextBody: number;
	readonly batches: Map<string, StagedTarget>;
	readonly resets: Map<string, StagedReset>;
}

type ReconciliationMessage = Extract<
	ServerMessage,
	{
		type:
			| "baseline_sync_start"
			| "baseline_sync_batch"
			| "baseline_sync_end"
			| "open"
			| "keyed_results"
			| "segments_pending"
			| "reset_required"
			| "commit"
			| "progress";
	}
>;

/**
 * Reassembles independent baseline syncs and atomic publications for one socket.
 *
 * This class owns ordering and visibility only. Connection admission, row
 * decoding, materialization, and application callbacks stay outside it.
 *
 * Each live query shows one snapshot. A tick with no unresolved hole at or
 * before it applies at once. From the first unresolved hole on, ticks are
 * buffered until a round that covers the hole lands; its install replays the
 * covered ticks, replaces the round's scope with the round's rows, replays
 * the later ticks up to the next hole, and publishes the result as one update.
 */
export class BaselineSyncPublicationReconciler {
	private readonly targets = new Map<string, TargetState>();
	private publication?: PendingPublication;

	constructor(
		private readonly events: ReconciliationEventSink = SILENT_RECONCILIATION_EVENTS,
	) {}

	add(input: AddReconciliationTarget): void {
		if (this.targets.has(input.liveId)) {
			throw new ProtocolError("duplicate live ID");
		}
		this.targets.set(input.liveId, {
			target: input.target,
			lifecycle: input.lifecycle,
			columnCount: input.columnCount,
			index: input.segmentRounds ? new SegmentIndex() : undefined,
			active: true,
			epoch: BigInt(input.epoch),
			nextSequence: BigInt(input.firstSequence),
			backlog: [],
			holes: 0,
			heldProgress: [],
			waiting: [],
			live: false,
		});
	}

	/**
	 * Stop local delivery while retaining protocol state until unsubscribe is
	 * acknowledged.
	 */
	deactivate(liveId: string): void {
		const state = this.target(liveId);
		if (!state.active) return;
		state.active = false;
		state.baselineSync = undefined;
		this.releaseBacklog(state);
		state.live = false;
		this.publication?.batches.delete(liveId);
		this.publication?.resets.delete(liveId);
	}

	remove(liveId: string): void {
		const state = this.targets.get(liveId);
		if (!state) return;
		this.releaseBacklog(state);
		this.publication?.batches.delete(liveId);
		this.publication?.resets.delete(liveId);
		this.targets.delete(liveId);
	}

	clear(): void {
		this.targets.clear();
		this.publication = undefined;
	}

	accept(message: ReconciliationMessage, mvcc?: ParsedMvccSnapshot): void {
		if (
			this.publication &&
			(message.type === "baseline_sync_start" ||
				message.type === "baseline_sync_batch" ||
				message.type === "baseline_sync_end")
		) {
			throw new ProtocolError("baseline sync interrupted a publication");
		}
		switch (message.type) {
			case "progress":
				this.progress(mvcc ?? parseMvccSnapshot(message.mvcc));
				return;
			case "baseline_sync_start":
				this.baselineSyncStart(message);
				return;
			case "baseline_sync_batch":
				this.baselineSyncBatch(message);
				return;
			case "baseline_sync_end":
				this.baselineSyncEnd(message);
				return;
			case "open":
				this.publicationOpen(message.publication_id);
				return;
			case "keyed_results":
				this.keyedResults(message);
				return;
			case "segments_pending":
				this.segmentsPending(message);
				return;
			case "reset_required":
				this.stageReset(message);
				return;
			case "commit":
				this.publicationCommit(
					message.publication_id,
					message.body_count,
				);
				return;
		}
	}

	private progress(mvcc: ParsedMvccSnapshot): void {
		if (this.publication) {
			throw new ProtocolError("progress interrupted a publication");
		}
		// Only ready targets have installed all preceding changes. The server
		// replays an ordered proof after each baseline finishes, even when idle.
		// Never cache a connection proof for a later admission or reset epoch.
		for (const state of this.targets.values()) {
			if (!state.active || !state.live) continue;
			if (state.backlog.length === 0) {
				state.target.applyProgress(mvcc);
				continue;
			}
			// A live query with a hole holds the proof until it shows the ticks
			// received before it. Proofs held at one tick merge, so at most one is
			// kept per buffered tick.
			const arrived = state.nextSequence - 1n;
			const last = state.heldProgress.at(-1);
			if (last?.arrived === arrived) {
				last.mvcc = mergeMvccSnapshots(last.mvcc, mvcc);
			} else {
				state.heldProgress.push({ arrived, mvcc });
			}
		}
	}

	private baselineSyncStart(
		message: Extract<
			ReconciliationMessage,
			{ type: "baseline_sync_start" }
		>,
	): void {
		const state = this.target(message.live_id);
		if (!state.active) return;
		const version = baselineSyncVersion(
			message.epoch,
			message.round,
			message.baseline_sync_attempt,
		);
		if (
			version.epoch < state.epoch ||
			isOlder(version, state.latestBaselineSync)
		)
			return;
		if (
			version.epoch !== state.epoch ||
			sameVersion(version, state.latestBaselineSync)
		) {
			throw new ProtocolError("invalid baseline sync start");
		}
		// A higher attempt of the same round supersedes the staged attempt. A
		// different round starts only after the previous round's end, and a
		// round that has ended does not start again.
		const staged = state.baselineSync;
		if (staged && staged.version.round !== version.round) {
			throw new ProtocolError(
				"a round started before the previous round ended",
			);
		}
		const resolving =
			message.scope.kind === "selected" || message.covered !== undefined;
		if (!resolving && state.live) {
			throw new ProtocolError("invalid baseline sync start");
		}
		if (
			!staged &&
			state.latestBaselineSync?.epoch === version.epoch &&
			state.latestBaselineSync.round === version.round
		) {
			throw new ProtocolError("a round started again after its end");
		}
		const resolves = resolving
			? this.resolvedHoles(state, message)
			: undefined;
		// A retry keeps its round's plan: the same scope, covered range and
		// snapshot. The install combines the staged rows with the buffered
		// ticks through the covered range, so a retry that changed any of them
		// could resolve a hole without replacing the segments it dirtied.
		if (staged && (staged.resolves || resolves)) {
			assertSameRoundPlan(staged, resolves, message.mvcc);
		}
		state.latestBaselineSync = version;
		state.baselineSync = {
			version,
			mvcc: message.mvcc,
			resolves,
			nextBatch: 0,
			rows: [],
			rowKeys: new Set(),
		};
		state.target.baselineSyncStarted();
	}

	/** Validate a round that resolves holes against the live query's state. */
	private resolvedHoles(
		state: TargetState,
		message: Extract<
			ReconciliationMessage,
			{ type: "baseline_sync_start" }
		>,
	): NonNullable<PendingBaselineSync["resolves"]> {
		if (!state.live || !state.index) {
			throw new ProtocolError(
				"a round arrived without an installed result",
			);
		}
		if (message.covered === undefined) {
			throw new ProtocolError("a selected round has no covered range");
		}
		const covered = {
			first: BigInt(message.covered.first_sequence),
			last: BigInt(message.covered.last_sequence),
		};
		// Behind a round that still waits for its covered ticks, the first
		// unresolved hole is known only once that round installs, and the
		// install checks it. Until then the range must follow the waiting one.
		const hole = state.backlog[0];
		const waiting = state.waiting.at(-1)?.resolves?.covered;
		if (
			covered.first > covered.last ||
			(waiting
				? covered.first <= waiting.last
				: !hole?.hole || covered.first !== hole.sequence)
		) {
			throw new ProtocolError(
				"a covered range must start at the first unresolved hole",
			);
		}
		if (message.scope.kind === "all") {
			return {
				scope: { all: true, tags: new Set(), rowKeys: new Set() },
				covered,
			};
		}
		const tags = new Set<string>();
		const rowKeys = new Set<string>();
		for (const selector of message.scope.selectors) {
			if ("tag" in selector) tags.add(selector.tag);
			else rowKeys.add(selector.row_key);
		}
		return { scope: { all: false, tags, rowKeys }, covered };
	}

	private baselineSyncBatch(
		message: Extract<
			ReconciliationMessage,
			{ type: "baseline_sync_batch" }
		>,
	): void {
		const state = this.target(message.live_id);
		if (!state.active) return;
		const version = baselineSyncVersion(
			message.epoch,
			message.round,
			message.baseline_sync_attempt,
		);
		if (
			version.epoch < state.epoch ||
			isOlder(version, state.latestBaselineSync)
		)
			return;
		const baselineSync = state.baselineSync;
		if (
			version.epoch !== state.epoch ||
			!baselineSync ||
			!sameVersion(version, baselineSync.version) ||
			baselineSync.batchCount !== undefined ||
			message.index !== baselineSync.nextBatch
		) {
			throw new ProtocolError("invalid baseline sync batch");
		}
		const scope = baselineSync.resolves?.scope;
		for (const row of message.rows) {
			if (row.values.length !== state.columnCount) {
				throw new ProtocolError(
					"baseline sync row arity does not match columns",
				);
			}
			if (baselineSync.rowKeys.has(row.row_key)) {
				throw new ProtocolError(
					"baseline sync contains a duplicate row key",
				);
			}
			// A selected round's row belongs by its own tag or its own row key.
			if (
				scope &&
				!scope.all &&
				!(
					(row.segment_tag !== undefined &&
						scope.tags.has(row.segment_tag)) ||
					scope.rowKeys.has(row.row_key)
				)
			) {
				throw new ProtocolError("a round row is outside its scope");
			}
			baselineSync.rowKeys.add(row.row_key);
			baselineSync.rows.push(row);
		}
		baselineSync.nextBatch += 1;
	}

	private baselineSyncEnd(
		message: Extract<ReconciliationMessage, { type: "baseline_sync_end" }>,
	): void {
		const state = this.target(message.live_id);
		if (!state.active) return;
		const version = baselineSyncVersion(
			message.epoch,
			message.round,
			message.baseline_sync_attempt,
		);
		if (
			version.epoch < state.epoch ||
			isOlder(version, state.latestBaselineSync)
		)
			return;
		const baselineSync = state.baselineSync;
		if (
			version.epoch !== state.epoch ||
			!baselineSync ||
			!sameVersion(version, baselineSync.version) ||
			baselineSync.batchCount !== undefined ||
			message.batch_count !== baselineSync.nextBatch
		) {
			throw new ProtocolError("invalid baseline sync end");
		}
		baselineSync.batchCount = message.batch_count;
		if (baselineSync.resolves) {
			// The round has ended; the next round may start. It installs once
			// every tick of its covered range has arrived, after earlier rounds.
			state.baselineSync = undefined;
			state.waiting.push(baselineSync);
			this.installWaiting(state);
			return;
		}
		// The exact-frontier baseline-sync contract guarantees that every
		// subsequently delivered publication is newer than the baseline. Replay
		// the contiguous backlog up to the first hole; interpreting transaction
		// IDs against the informational MVCC fields can incorrectly discard
		// valid changes.
		const shown =
			state.holes === 0
				? state.backlog.length
				: state.backlog.findIndex((tick) => tick.hole);
		const replay = state.backlog.slice(0, shown).map((tick) => tick.batch);
		const rows = Object.freeze([...baselineSync.rows]);
		try {
			const install = state.target.prepare(rows, replay);
			install();
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			state.baselineSync = undefined;
			this.releaseBacklog(state);
			state.active = false;
			state.live = false;
			state.target.decodeFailed(error);
			return;
		}
		state.baselineSync = undefined;
		state.backlog = state.backlog.slice(shown);
		if (state.index) {
			state.index.clear();
			for (const row of rows)
				state.index.set(row.row_key, row.segment_tag);
			for (const batch of replay) state.index.apply(batch.changes);
		}
		state.target.baselineSyncCompleted(message.batch_count);
		state.target.publishReset(rows, baselineSync.mvcc);
		for (const batch of replay) state.target.publishBatch(batch);
		state.live = true;
		state.lifecycle?.baselineCompleted();
		state.target.caughtUp();
	}

	/**
	 * Install a round that resolves holes once its final batch and every
	 * covered tick have arrived.
	 *
	 * Work is proportional to the buffered ticks it replays, the rows it
	 * removes and the rows it inserts; a round with scope `all` removes every
	 * visible row.
	 */
	private installWaiting(state: TargetState): void {
		for (
			let round = state.waiting[0];
			round?.resolves &&
			state.active &&
			state.nextSequence > round.resolves.covered.last;
			round = state.waiting[0]
		) {
			state.waiting.shift();
			this.installRound(state, round);
		}
	}

	private installRound(state: TargetState, round: PendingBaselineSync): void {
		const resolves = round.resolves;
		const index = state.index;
		if (!resolves || round.batchCount === undefined || !index) {
			throw new ProtocolError("a round cannot install without its plan");
		}
		const { scope, covered } = resolves;
		const first = state.backlog[0];
		if (!first?.hole || first.sequence !== covered.first) {
			throw new ProtocolError(
				"a covered range must start at the first unresolved hole",
			);
		}

		// Every key the install touches, with its final row or null, and whether
		// the result showed the key before this install.
		const delta = new Map<string, WireRow | null>();
		const visibleBefore = new Map<string, boolean>();
		const touch = (rowKey: string) => {
			if (!visibleBefore.has(rowKey))
				visibleBefore.set(rowKey, index.has(rowKey));
		};
		const txids: string[] = [];
		let replayed = 0;
		let resolvedHoles = 0;
		const replay = (tick: BufferedTick) => {
			for (const change of tick.batch.changes) {
				if (change.op === "move") {
					throw new ProtocolError(
						"a round cannot replay an ordered move",
					);
				}
				touch(change.row_key);
				delta.set(
					change.row_key,
					change.op === "remove"
						? null
						: wireRow(
								change.row_key,
								change.values,
								change.segment_tag,
							),
				);
			}
			index.apply(tick.batch.changes);
			txids.push(...tick.batch.txids);
			if (tick.hole) resolvedHoles += 1;
			replayed += 1;
		};
		const remove = (rowKey: string) => {
			touch(rowKey);
			delta.set(rowKey, null);
			index.delete(rowKey);
		};

		// 1. Every buffered tick through the covered range's end, in order.
		for (
			let sequence = covered.first;
			sequence <= covered.last;
			sequence += 1n
		) {
			const tick = state.backlog[replayed];
			if (tick?.sequence !== sequence) {
				throw new ProtocolError("a covered tick was not received");
			}
			replay(tick);
		}
		// 2. A returned row must not be shown under a tag outside the scope. A
		// patch that moved a row out of the scope landed in step 1, so step 3
		// does not remove it.
		if (!scope.all) {
			for (const row of round.rows) {
				const tag = index.tagOf(row.row_key);
				if (tag !== undefined && !scope.tags.has(tag)) {
					throw new ProtocolError(
						"a round row is shown under a tag outside its scope",
					);
				}
			}
		}
		// 3. Remove the scope's rows.
		if (scope.all) {
			for (const rowKey of index.keys()) remove(rowKey);
		} else {
			for (const tag of scope.tags)
				for (const rowKey of index.keysOf(tag)) remove(rowKey);
			for (const rowKey of scope.rowKeys)
				if (index.has(rowKey)) remove(rowKey);
		}
		// 4. Insert the round's rows.
		for (const row of round.rows) {
			touch(row.row_key);
			delta.set(row.row_key, row);
			index.set(row.row_key, row.segment_tag);
		}
		// 5. The later buffered ticks, up to the next unresolved hole.
		for (
			let tick = state.backlog[replayed];
			tick && !tick.hole;
			tick = state.backlog[replayed]
		) {
			replay(tick);
		}

		// 6. One update: every row the install takes out of the result or
		// replaces first, then every row it shows. A consumer that derives its
		// own keys from rows, such as a collection keyed by an ID column, then
		// never sees two row keys holding one of its keys, even when a segment
		// renumbers its rows. Removing a key the result never showed is a no-op.
		const removes: WireChange[] = [];
		const upserts: WireChange[] = [];
		for (const [rowKey, row] of delta) {
			if (visibleBefore.get(rowKey))
				removes.push(Object.freeze({ op: "remove", row_key: rowKey }));
			if (row !== null) {
				upserts.push(
					Object.freeze({
						op: "upsert",
						row_key: rowKey,
						values: row.values,
						...(row.segment_tag === undefined
							? {}
							: { segment_tag: row.segment_tag }),
					}),
				);
			}
		}
		const batch = Object.freeze({
			changes: Object.freeze([...removes, ...upserts]),
			txids: Object.freeze(txids),
		});
		let install: () => void;
		try {
			install = state.target.prepare(undefined, [batch]);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			state.baselineSync = undefined;
			this.releaseBacklog(state);
			state.active = false;
			state.live = false;
			state.target.decodeFailed(error);
			return;
		}
		state.backlog = state.backlog.slice(replayed);
		state.holes -= resolvedHoles;
		install();
		const shown = (state.backlog[0]?.sequence ?? state.nextSequence) - 1n;
		const released = state.heldProgress.filter(
			({ arrived }) => arrived <= shown,
		);
		state.heldProgress = state.heldProgress.slice(released.length);
		state.target.baselineSyncCompleted(round.batchCount);
		state.target.publishRound(batch, round.mvcc, state.holes > 0);
		for (const progress of released)
			state.target.applyProgress(progress.mvcc);
	}

	private publicationOpen(publicationId: string): void {
		if (this.publication)
			throw new ProtocolError("overlapping publication");
		this.publication = {
			id: publicationId,
			nextBody: 0,
			batches: new Map(),
			resets: new Map(),
		};
	}

	private keyedResults(
		message: Extract<ReconciliationMessage, { type: "keyed_results" }>,
	): void {
		const publication = this.publicationBody(
			message.publication_id,
			message.index,
		);
		const bodyTargets = new Set<string>();
		for (const target of message.targets) {
			const state = this.target(target.live_id);
			if (bodyTargets.has(target.live_id)) {
				throw new ProtocolError("invalid publication target");
			}
			bodyTargets.add(target.live_id);
			if (!state.active) continue;
			const existing = this.stagedTarget(
				publication,
				state,
				target,
				message.txids,
			);
			for (const change of message.changes) {
				if (
					change.op === "upsert" &&
					change.values.length !== state.columnCount
				) {
					throw new ProtocolError(
						"publication row arity does not match columns",
					);
				}
			}
			if (existing) {
				existing.changes.push(...message.changes);
			} else {
				publication.batches.set(target.live_id, {
					changes: [...message.changes],
					txids: message.txids,
					nextSequence: BigInt(target.sequence) + 1n,
					hole: false,
				});
			}
		}
	}

	private segmentsPending(
		message: Extract<ReconciliationMessage, { type: "segments_pending" }>,
	): void {
		const publication = this.publicationBody(
			message.publication_id,
			message.index,
		);
		const bodyTargets = new Set<string>();
		for (const target of message.targets) {
			const state = this.target(target.live_id);
			if (bodyTargets.has(target.live_id)) {
				throw new ProtocolError("invalid hole target");
			}
			bodyTargets.add(target.live_id);
			if (!state.active) continue;
			if (!state.index) {
				throw new ProtocolError("a hole needs protocol v3");
			}
			const existing = this.stagedTarget(
				publication,
				state,
				target,
				message.txids,
			);
			if (existing?.hole) {
				throw new ProtocolError("a target has two holes in one tick");
			}
			if (existing) {
				existing.hole = true;
			} else {
				publication.batches.set(target.live_id, {
					changes: [],
					txids: message.txids,
					nextSequence: BigInt(target.sequence) + 1n,
					hole: true,
				});
			}
		}
	}

	/**
	 * Check one body's target against the tick staged for it so far. Every
	 * body for one live ID in one publication names the same next sequence
	 * and the same transaction IDs.
	 */
	private stagedTarget(
		publication: PendingPublication,
		state: TargetState,
		target: {
			readonly live_id: string;
			readonly epoch: string;
			readonly sequence: string;
		},
		txids: readonly string[],
	): StagedTarget | undefined {
		const sequence = BigInt(target.sequence);
		const existing = publication.batches.get(target.live_id);
		if (
			publication.resets.has(target.live_id) ||
			state.epoch !== BigInt(target.epoch) ||
			state.nextSequence !== sequence ||
			(existing &&
				(existing.nextSequence !== sequence + 1n ||
					!sameStrings(existing.txids, txids)))
		) {
			throw new ProtocolError("invalid publication target");
		}
		return existing;
	}

	private stageReset(
		message: Extract<ReconciliationMessage, { type: "reset_required" }>,
	): void {
		const publication = this.publicationBody(
			message.publication_id,
			message.index,
		);
		for (const target of message.targets) {
			const state = this.target(target.live_id);
			if (!state.active) continue;
			const epoch = BigInt(target.epoch);
			if (
				epoch <= state.epoch ||
				publication.batches.has(target.live_id) ||
				publication.resets.has(target.live_id)
			) {
				throw new ProtocolError("invalid reset target");
			}
			publication.resets.set(target.live_id, {
				epoch,
				firstSequence: BigInt(target.first_sequence),
			});
		}
	}

	private publicationCommit(publicationId: string, bodyCount: number): void {
		const publication = this.publication;
		if (
			!publication ||
			publication.id !== publicationId ||
			publication.nextBody !== bodyCount
		) {
			throw new ProtocolError("invalid publication commit");
		}
		const committed: Array<{
			readonly state: TargetState;
			readonly staged: StagedTarget;
			readonly batch: ReconciledBatch;
			readonly install?: () => void;
			readonly failure?: { readonly error: unknown };
		}> = [];
		// Validate complete programs across fragments, including raw targets and
		// baseline backlogs, before advancing any target's protocol or row state.
		for (const staged of publication.batches.values())
			validateChangeOrder(staged.changes);
		for (const [liveId, staged] of publication.batches) {
			const state = this.target(liveId);
			const batch = Object.freeze({
				changes: Object.freeze([...staged.changes]),
				txids: Object.freeze([...staged.txids]),
			});
			// A hole, and every tick after an unresolved one, stays buffered.
			const applies =
				state.live && !staged.hole && state.backlog.length === 0;
			try {
				const install = applies
					? state.target.prepare(undefined, [batch])
					: undefined;
				// Application parsers may close the client and clear this publication.
				if (this.publication !== publication) return;
				committed.push({ state, staged, batch, install });
			} catch (error) {
				if (this.publication !== publication) return;
				if (error instanceof ProtocolError) throw error;
				committed.push({ state, staged, batch, failure: { error } });
			}
		}
		this.publication = undefined;
		const holePending: TargetState[] = [];
		for (const { state, staged, batch, install, failure } of committed) {
			const sequence = state.nextSequence;
			state.nextSequence = staged.nextSequence;
			if (failure) {
				state.active = false;
				state.live = false;
			} else if (install) {
				install();
				state.index?.apply(batch.changes);
			} else {
				state.backlog.push({ batch, sequence, hole: staged.hole });
				if (staged.hole && ++state.holes === 1) holePending.push(state);
			}
		}
		const resetStates: TargetState[] = [];
		for (const [liveId, reset] of publication.resets) {
			const state = this.target(liveId);
			const discardedHoles = state.holes > 0;
			state.epoch = reset.epoch;
			state.nextSequence = reset.firstSequence;
			state.latestBaselineSync = undefined;
			state.baselineSync = undefined;
			this.releaseBacklog(state);
			state.live = false;
			resetStates.push(state);
			if (discardedHoles) holePending.push(state);
		}
		this.events.publicationCommitted(bodyCount);
		for (const state of resetStates) {
			state.lifecycle?.interrupted();
			state.target.resetRequired();
		}
		for (const { state, failure } of committed) {
			if (failure) state.target.decodeFailed(failure.error);
		}
		for (const { state, batch, install } of committed) {
			if (install) state.target.publishBatch(batch);
		}
		for (const state of holePending) {
			if (state.active) state.target.updatingChanged(state.holes > 0);
		}
		// A round whose covered ticks were still arriving can install now.
		for (const { state, failure } of committed) {
			if (!failure && state.active && state.live)
				this.installWaiting(state);
		}
	}

	private publicationBody(
		publicationId: string,
		index: number,
	): PendingPublication {
		const publication = this.publication;
		if (
			!publication ||
			publication.id !== publicationId ||
			publication.nextBody !== index
		) {
			throw new ProtocolError("invalid publication body");
		}
		publication.nextBody += 1;
		return publication;
	}

	private releaseBacklog(state: TargetState): void {
		state.backlog = [];
		state.holes = 0;
		state.heldProgress = [];
		state.waiting = [];
	}

	private target(liveId: string): TargetState {
		const target = this.targets.get(liveId);
		if (!target) throw new ProtocolError("unknown live ID");
		return target;
	}
}

function assertSameRoundPlan(
	staged: PendingBaselineSync,
	resolves: PendingBaselineSync["resolves"],
	mvcc: MvccSnapshot,
): void {
	const before = staged.resolves;
	if (
		!before ||
		!resolves ||
		before.scope.all !== resolves.scope.all ||
		!sameSet(before.scope.tags, resolves.scope.tags) ||
		!sameSet(before.scope.rowKeys, resolves.scope.rowKeys)
	) {
		throw new ProtocolError("a retry changed its round's scope");
	}
	if (
		before.covered.first !== resolves.covered.first ||
		before.covered.last !== resolves.covered.last
	) {
		throw new ProtocolError("a retry changed its round's covered range");
	}
	if (
		staged.mvcc.xmin !== mvcc.xmin ||
		staged.mvcc.xmax !== mvcc.xmax ||
		!sameSet(new Set(staged.mvcc.xip), new Set(mvcc.xip))
	) {
		throw new ProtocolError("a retry changed its round's snapshot");
	}
}

function sameSet(
	left: ReadonlySet<string>,
	right: ReadonlySet<string>,
): boolean {
	return (
		left.size === right.size && [...left].every((item) => right.has(item))
	);
}

function wireRow(
	rowKey: string,
	values: WireRow["values"],
	segmentTag: string | undefined,
): WireRow {
	return segmentTag === undefined
		? { row_key: rowKey, values }
		: { row_key: rowKey, values, segment_tag: segmentTag };
}

function baselineSyncVersion(
	epoch: string,
	round: string,
	attempt: string,
): BaselineSyncVersion {
	return {
		epoch: BigInt(epoch),
		round: BigInt(round),
		attempt: BigInt(attempt),
	};
}

function sameVersion(
	left: BaselineSyncVersion,
	right: BaselineSyncVersion | undefined,
): boolean {
	return (
		right !== undefined &&
		left.epoch === right.epoch &&
		left.round === right.round &&
		left.attempt === right.attempt
	);
}

/** Rounds advance within an epoch, and attempts within a round. */
function isOlder(
	candidate: BaselineSyncVersion,
	current: BaselineSyncVersion | undefined,
): boolean {
	if (current === undefined) return false;
	if (candidate.epoch !== current.epoch)
		return candidate.epoch < current.epoch;
	if (candidate.round !== current.round)
		return candidate.round < current.round;
	return candidate.attempt < current.attempt;
}

function sameStrings(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}
