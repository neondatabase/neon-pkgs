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
import {
	type BufferedTick,
	inScope,
	Membership,
	planInstall,
	type RoundPlan,
	roundPlan,
	samePlan,
} from "./rounds.js";

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
	publishBatch(batch: ReconciledBatch, publishSnapshot?: boolean): void;
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
	readonly attempt: bigint;
}

interface PendingBaselineSync {
	readonly version: BaselineSyncVersion;
	readonly mvcc: MvccSnapshot;
	/** Present for a selected round; absent for an epoch's first baseline. */
	readonly round?: RoundPlan;
	nextBatch: number;
	rows: WireRow[];
	rowKeys: Set<string>;
}

interface TargetState {
	readonly target: ReconciliationTarget;
	readonly lifecycle?: ReconciliationLifecycle;
	readonly columnCount: number;
	active: boolean;
	epoch: bigint;
	nextSequence: bigint;
	latestBaselineSync?: BaselineSyncVersion;
	baselineSync?: PendingBaselineSync;
	/**
	 * Every received tick the live query does not show. Once live, it is empty
	 * or starts with the first unresolved hole.
	 */
	backlog: BufferedTick[];
	/** The visible row keys and their segments. */
	readonly members: Membership;
	/** Fixed by the first selected round, for this live ID across epochs. */
	ordered?: boolean;
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
			active: true,
			epoch: BigInt(input.epoch),
			nextSequence: BigInt(input.firstSequence),
			backlog: [],
			members: new Membership(),
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
				this.baselineSyncStart(message, mvcc);
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
			// A live query with an unresolved hole holds the proof with the last
			// tick it has received, until an install shows that tick.
			const held = state.backlog.at(-1);
			if (!held) state.target.applyProgress(mvcc);
			else
				held.proof = held.proof
					? mergeMvccSnapshots(held.proof, mvcc)
					: mvcc;
		}
	}

	private baselineSyncStart(
		message: Extract<
			ReconciliationMessage,
			{ type: "baseline_sync_start" }
		>,
		mvcc: ParsedMvccSnapshot | undefined,
	): void {
		const state = this.target(message.live_id);
		if (!state.active) return;
		const version = baselineSyncVersion(
			message.epoch,
			message.baseline_sync_attempt,
		);
		if (
			version.epoch < state.epoch ||
			isOlder(version, state.latestBaselineSync)
		)
			return;
		// An epoch's first baseline replaces everything; a selected round
		// arrives only while live.
		if (
			version.epoch !== state.epoch ||
			sameVersion(version, state.latestBaselineSync) ||
			(message.scope.kind === "selected") !== state.live
		) {
			throw new ProtocolError("invalid baseline sync start");
		}
		const round =
			message.scope.kind === "selected"
				? roundPlan(
						message.scope,
						mvcc ?? parseMvccSnapshot(message.mvcc),
					)
				: undefined;
		if (round) this.checkRoundStart(state, round);
		state.latestBaselineSync = version;
		state.baselineSync = {
			version,
			mvcc: message.mvcc,
			round,
			nextBatch: 0,
			rows: [],
			rowKeys: new Set(),
		};
		state.target.baselineSyncStarted();
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
			message.index !== baselineSync.nextBatch
		) {
			throw new ProtocolError("invalid baseline sync batch");
		}
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
			if (
				baselineSync.round &&
				!inScope(baselineSync.round, row.row_key, row.segment_tag)
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
			message.batch_count !== baselineSync.nextBatch
		) {
			throw new ProtocolError("invalid baseline sync end");
		}
		if (baselineSync.round) {
			this.installRound(
				message.live_id,
				state,
				baselineSync,
				message.batch_count,
			);
			return;
		}
		// The exact-frontier baseline-sync contract guarantees that every
		// subsequently delivered publication is newer than the baseline. Replay
		// the contiguous backlog up to the first hole; interpreting transaction
		// IDs against the informational MVCC fields can incorrectly discard
		// valid changes.
		const hole = state.backlog.findIndex((tick) => tick.hole);
		const shown = hole === -1 ? state.backlog.length : hole;
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
		state.members.reset(rows);
		for (const batch of replay) state.members.apply(batch.changes);
		state.baselineSync = undefined;
		state.backlog = state.backlog.slice(shown);
		state.target.baselineSyncCompleted(message.batch_count);
		state.target.publishReset(rows, baselineSync.mvcc);
		// Replay raw batches individually. caughtUp publishes the complete view.
		for (const batch of replay) state.target.publishBatch(batch, false);
		state.live = true;
		state.lifecycle?.baselineCompleted();
		state.target.caughtUp();
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
				// A body is wire-sized; spreading it as arguments can exceed the
				// engine's argument limit.
				for (const change of message.changes)
					existing.changes.push(change);
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
		for (const target of message.targets) {
			const state = this.target(target.live_id);
			if (!state.active) continue;
			const existing = this.stagedTarget(
				publication,
				state,
				target,
				message.txids,
			);
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
	 * Check one body's target against the tick staged for it so far: every body
	 * for one live ID in one publication carries the same sequence and txids.
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
		for (const { state, staged, batch, install, failure } of committed) {
			state.nextSequence = staged.nextSequence;
			if (failure) {
				state.active = false;
				state.live = false;
			} else if (install) {
				install();
				state.members.apply(batch.changes);
			} else state.backlog.push({ batch, hole: staged.hole });
		}
		const resetStates: TargetState[] = [];
		for (const [liveId, reset] of publication.resets) {
			const state = this.target(liveId);
			state.epoch = reset.epoch;
			state.nextSequence = reset.firstSequence;
			state.latestBaselineSync = undefined;
			state.baselineSync = undefined;
			this.releaseBacklog(state);
			state.live = false;
			resetStates.push(state);
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

	/**
	 * Check a selected round's start. Its covered range runs from the first
	 * unresolved hole through ticks already received, and a retry repeats the
	 * staged round's plan.
	 */
	private checkRoundStart(state: TargetState, round: RoundPlan): void {
		const firstHole = state.nextSequence - BigInt(state.backlog.length);
		if (
			!state.backlog[0]?.hole ||
			round.from !== firstHole ||
			round.through < round.from ||
			round.through >= state.nextSequence
		) {
			throw new ProtocolError("invalid covered range");
		}
		const staged = state.baselineSync?.round;
		if (staged && !samePlan(staged, round)) {
			throw new ProtocolError("a retry changed its round's plan");
		}
		if (state.ordered !== undefined && state.ordered !== round.ordered) {
			throw new ProtocolError("a selected round changed its ordering");
		}
		state.ordered = round.ordered;
	}

	/**
	 * Install a selected round at its end: the covered ticks, the round and the
	 * later ticks up to the next hole become visible in one step, as ordinary
	 * updates.
	 */
	private installRound(
		liveId: string,
		state: TargetState,
		staged: PendingBaselineSync,
		batchCount: number,
	): void {
		const round = staged.round as RoundPlan;
		const covered =
			Number(
				round.through -
					(state.nextSequence - BigInt(state.backlog.length)),
			) + 1;
		const plan = planInstall(
			state.members,
			state.backlog,
			covered,
			round,
			staged.rows,
		);
		const batches = [plan.batch, ...plan.later.map((tick) => tick.batch)];
		// Application parsers may close the client or its transport, which
		// retires this target; then abandon the install and any decoding error.
		const current = () =>
			this.targets.get(liveId) === state &&
			state.active &&
			state.baselineSync === staged;
		let install: () => void;
		try {
			install = state.target.prepare(undefined, batches);
		} catch (error) {
			if (!current()) return;
			if (error instanceof ProtocolError) throw error;
			state.baselineSync = undefined;
			this.releaseBacklog(state);
			state.active = false;
			state.live = false;
			state.target.decodeFailed(error);
			return;
		}
		if (!current()) return;
		install();
		for (const batch of batches) state.members.apply(batch.changes);
		const released = state.backlog.splice(0, plan.shown);
		state.baselineSync = undefined;
		state.target.baselineSyncCompleted(batchCount);
		for (const batch of batches) state.target.publishBatch(batch);
		state.target.applyProgress(round.mvcc);
		for (const tick of released) {
			if (tick.proof) state.target.applyProgress(tick.proof);
		}
	}

	private releaseBacklog(state: TargetState): void {
		state.backlog = [];
	}

	private target(liveId: string): TargetState {
		const target = this.targets.get(liveId);
		if (!target) throw new ProtocolError("unknown live ID");
		return target;
	}
}

function baselineSyncVersion(
	epoch: string,
	attempt: string,
): BaselineSyncVersion {
	return { epoch: BigInt(epoch), attempt: BigInt(attempt) };
}

function sameVersion(
	left: BaselineSyncVersion,
	right: BaselineSyncVersion | undefined,
): boolean {
	return (
		right !== undefined &&
		left.epoch === right.epoch &&
		left.attempt === right.attempt
	);
}

function isOlder(
	candidate: BaselineSyncVersion,
	current: BaselineSyncVersion | undefined,
): boolean {
	return (
		current !== undefined &&
		(candidate.epoch < current.epoch ||
			(candidate.epoch === current.epoch &&
				candidate.attempt < current.attempt))
	);
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
