import { ProtocolError } from "../protocol/codec.js";
import type {
	MvccSnapshot,
	ServerMessage,
	WireChange,
	WireRow,
} from "../protocol/messages.js";

export interface ReconciledBatch {
	readonly changes: readonly WireChange[];
	readonly txids: readonly string[];
}

export interface ReconciliationTarget {
	/** Observe a baseline-sync attempt after reconciliation accepts it. */
	baselineSyncStarted(): void;
	/** Install state without notifying application listeners. */
	installReset(rows: readonly WireRow[]): void;
	/** Install changes without notifying application listeners. */
	applyBatch(changes: readonly WireChange[]): void;
	/** Notify raw listeners after all state for this publication is installed. */
	publishReset(rows: readonly WireRow[], mvcc: MvccSnapshot): void;
	/** Notify listeners after all state for this publication is installed. */
	publishBatch(batch: ReconciledBatch): void;
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
}

export interface ReconciliationLimits {
	/** Bytes retained while assembling one baseline sync. */
	readonly maxBaselineSyncBytes: number;
	/** Bytes retained by one publication or all post-baseline-sync backlogs. */
	readonly maxPublicationBytes: number;
}

export interface ReconciliationEventSink {
	publicationCommitted(bodyCount: number): void;
}

const DEFAULT_STAGING_BYTES = 16 * 1024 * 1024;
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
	bytes: number;
	nextBatch: number;
	rows: WireRow[];
	rowKeys: Set<string>;
}

interface BufferedBatch {
	readonly batch: ReconciledBatch;
	readonly bytes: number;
}

interface TargetState {
	readonly target: ReconciliationTarget;
	readonly columnCount: number;
	active: boolean;
	epoch: bigint;
	nextSequence: bigint;
	latestBaselineSync?: BaselineSyncVersion;
	baselineSync?: PendingBaselineSync;
	backlog: BufferedBatch[];
	backlogBytes: number;
	live: boolean;
}

interface StagedTarget {
	readonly changes: WireChange[];
	readonly txids: readonly string[];
	readonly nextSequence: bigint;
	bytes: number;
}

interface StagedReset {
	readonly epoch: bigint;
	readonly firstSequence: bigint;
}

interface PendingPublication {
	readonly id: string;
	bytes: number;
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
			| "reset_required"
			| "commit";
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
	private readonly maxBaselineSyncBytes: number;
	private readonly maxPublicationBytes: number;
	private backlogBytes = 0;
	private publication?: PendingPublication;

	constructor(
		limits: Partial<ReconciliationLimits> = {},
		private readonly events: ReconciliationEventSink = SILENT_RECONCILIATION_EVENTS,
	) {
		this.maxBaselineSyncBytes = positiveLimit(
			limits.maxBaselineSyncBytes ?? DEFAULT_STAGING_BYTES,
			"maxBaselineSyncBytes",
		);
		this.maxPublicationBytes = positiveLimit(
			limits.maxPublicationBytes ?? DEFAULT_STAGING_BYTES,
			"maxPublicationBytes",
		);
	}

	/** Total raw wire bytes currently retained by in-progress reconciliation. */
	get stagingBytes(): number {
		let bytes = this.backlogBytes + (this.publication?.bytes ?? 0);
		for (const state of this.targets.values()) {
			bytes += state.baselineSync?.bytes ?? 0;
		}
		return bytes;
	}

	add(input: AddReconciliationTarget): void {
		if (this.targets.has(input.liveId)) {
			throw new ProtocolError("duplicate live ID");
		}
		this.targets.set(input.liveId, {
			target: input.target,
			columnCount: input.columnCount,
			active: true,
			epoch: BigInt(input.epoch),
			nextSequence: BigInt(input.firstSequence),
			backlog: [],
			backlogBytes: 0,
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
		this.backlogBytes = 0;
	}

	accept(message: ReconciliationMessage, byteLength: number): void {
		const bytes = messageBytes(byteLength);
		if (
			this.publication &&
			(message.type === "baseline_sync_start" ||
				message.type === "baseline_sync_batch" ||
				message.type === "baseline_sync_end")
		) {
			throw new ProtocolError("baseline sync interrupted a publication");
		}
		switch (message.type) {
			case "baseline_sync_start":
				this.baselineSyncStart(message, bytes);
				return;
			case "baseline_sync_batch":
				this.baselineSyncBatch(message, bytes);
				return;
			case "baseline_sync_end":
				this.baselineSyncEnd(message, bytes);
				return;
			case "open":
				this.publicationOpen(message.publication_id, bytes);
				return;
			case "keyed_results":
				this.keyedResults(message, bytes);
				return;
			case "reset_required":
				this.stageReset(message, bytes);
				return;
			case "commit":
				this.publicationCommit(
					message.publication_id,
					message.body_count,
					bytes,
				);
				return;
		}
	}

	private baselineSyncStart(
		message: Extract<
			ReconciliationMessage,
			{ type: "baseline_sync_start" }
		>,
		bytes: number,
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
		if (
			version.epoch !== state.epoch ||
			sameVersion(version, state.latestBaselineSync) ||
			state.live
		) {
			throw new ProtocolError("invalid baseline sync start");
		}
		this.checkBaselineSyncBytes(bytes);
		state.latestBaselineSync = version;
		state.baselineSync = {
			version,
			mvcc: message.mvcc,
			bytes,
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
		bytes: number,
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
		this.checkBaselineSyncBytes(baselineSync.bytes + bytes);
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
			baselineSync.rowKeys.add(row.row_key);
			baselineSync.rows.push(row);
		}
		baselineSync.bytes += bytes;
		baselineSync.nextBatch += 1;
	}

	private baselineSyncEnd(
		message: Extract<ReconciliationMessage, { type: "baseline_sync_end" }>,
		bytes: number,
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
		this.checkBaselineSyncBytes(baselineSync.bytes + bytes);

		// The exact-frontier baseline-sync contract guarantees that every
		// subsequently delivered publication is newer than the baseline. Replay
		// the complete contiguous backlog; interpreting transaction IDs against
		// the informational MVCC fields can incorrectly discard valid changes.
		const replay = state.backlog;
		const rows = Object.freeze([...baselineSync.rows]);
		state.baselineSync = undefined;
		this.releaseBacklog(state);
		try {
			state.target.installReset(rows);
			for (const buffered of replay) {
				if (buffered.batch.changes.length > 0) {
					state.target.applyBatch(buffered.batch.changes);
				}
			}
		} catch (error) {
			state.active = false;
			state.live = false;
			state.target.decodeFailed(error);
			return;
		}
		state.target.baselineSyncCompleted(message.batch_count);
		state.target.publishReset(rows, baselineSync.mvcc);
		for (const buffered of replay)
			state.target.publishBatch(buffered.batch);
		state.live = true;
		state.target.caughtUp();
	}

	private publicationOpen(publicationId: string, bytes: number): void {
		if (this.publication)
			throw new ProtocolError("overlapping publication");
		this.checkPublicationBytes(bytes);
		this.publication = {
			id: publicationId,
			bytes,
			nextBody: 0,
			batches: new Map(),
			resets: new Map(),
		};
	}

	private keyedResults(
		message: Extract<ReconciliationMessage, { type: "keyed_results" }>,
		bytes: number,
	): void {
		const publication = this.publicationBody(
			message.publication_id,
			message.index,
			bytes,
		);
		const bodyTargets = new Set<string>();
		for (const target of message.targets) {
			const state = this.target(target.live_id);
			if (bodyTargets.has(target.live_id)) {
				throw new ProtocolError("invalid publication target");
			}
			bodyTargets.add(target.live_id);
			if (!state.active) continue;
			const sequence = BigInt(target.sequence);
			const existing = publication.batches.get(target.live_id);
			if (
				publication.resets.has(target.live_id) ||
				state.epoch !== BigInt(target.epoch) ||
				state.nextSequence !== sequence ||
				(existing &&
					(existing.nextSequence !== sequence + 1n ||
						!sameStrings(existing.txids, message.txids)))
			) {
				throw new ProtocolError("invalid publication target");
			}
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
				existing.bytes += bytes;
			} else {
				publication.batches.set(target.live_id, {
					changes: [...message.changes],
					txids: message.txids,
					nextSequence: sequence + 1n,
					bytes,
				});
			}
		}
	}

	private stageReset(
		message: Extract<ReconciliationMessage, { type: "reset_required" }>,
		bytes: number,
	): void {
		const publication = this.publicationBody(
			message.publication_id,
			message.index,
			bytes,
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

	private publicationCommit(
		publicationId: string,
		bodyCount: number,
		bytes: number,
	): void {
		const publication = this.publication;
		if (
			!publication ||
			publication.id !== publicationId ||
			publication.nextBody !== bodyCount
		) {
			throw new ProtocolError("invalid publication commit");
		}
		this.checkPublicationBytes(publication.bytes + bytes);

		let projectedBacklogBytes = this.backlogBytes;
		for (const [liveId, staged] of publication.batches) {
			if (!this.target(liveId).live)
				projectedBacklogBytes += staged.bytes;
		}
		for (const liveId of publication.resets.keys()) {
			projectedBacklogBytes -= this.target(liveId).backlogBytes;
		}
		if (projectedBacklogBytes > this.maxPublicationBytes) {
			throw new ProtocolError("change backlog exceeds the byte limit");
		}
		this.publication = undefined;

		const immediate: Array<{
			readonly state: TargetState;
			readonly batch: ReconciledBatch;
		}> = [];
		for (const [liveId, staged] of publication.batches) {
			const state = this.target(liveId);
			state.nextSequence = staged.nextSequence;
			const batch = Object.freeze({
				changes: Object.freeze([...staged.changes]),
				txids: Object.freeze([...staged.txids]),
			});
			if (state.live) immediate.push({ state, batch });
			else {
				const buffered = Object.freeze({ batch, bytes: staged.bytes });
				state.backlog.push(buffered);
				state.backlogBytes += staged.bytes;
				this.backlogBytes += staged.bytes;
			}
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

		// Preserve publication atomicity: mutate every target before invoking any
		// listener that could inspect another subscription on this connection.
		const installed: typeof immediate = [];
		const failed: Array<{
			readonly state: TargetState;
			readonly error: unknown;
		}> = [];
		for (const entry of immediate) {
			try {
				entry.state.target.applyBatch(entry.batch.changes);
				installed.push(entry);
			} catch (error) {
				entry.state.active = false;
				entry.state.live = false;
				failed.push({ state: entry.state, error });
			}
		}
		this.events.publicationCommitted(bodyCount);
		for (const state of resetStates) state.target.resetRequired();
		for (const { state, error } of failed) state.target.decodeFailed(error);
		for (const { state, batch } of installed) {
			state.target.publishBatch(batch);
		}
	}

	private publicationBody(
		publicationId: string,
		index: number,
		bytes: number,
	): PendingPublication {
		const publication = this.publication;
		if (
			!publication ||
			publication.id !== publicationId ||
			publication.nextBody !== index
		) {
			throw new ProtocolError("invalid publication body");
		}
		this.checkPublicationBytes(publication.bytes + bytes);
		publication.bytes += bytes;
		publication.nextBody += 1;
		return publication;
	}

	private releaseBacklog(state: TargetState): void {
		this.backlogBytes -= state.backlogBytes;
		state.backlogBytes = 0;
		state.backlog = [];
	}

	private checkBaselineSyncBytes(bytes: number): void {
		if (bytes > this.maxBaselineSyncBytes) {
			throw new ProtocolError("baseline sync exceeds the byte limit");
		}
	}

	private checkPublicationBytes(bytes: number): void {
		if (bytes > this.maxPublicationBytes) {
			throw new ProtocolError("publication exceeds the byte limit");
		}
	}

	private target(liveId: string): TargetState {
		const target = this.targets.get(liveId);
		if (!target) throw new ProtocolError("unknown live ID");
		return target;
	}
}

function positiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}

function messageBytes(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(
			"message byte length must be a positive safe integer",
		);
	}
	return value;
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
