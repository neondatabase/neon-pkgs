import type { ConnectionCoordinatorError } from "./connection/coordinator.js";
import type { SubscriptionEventSink } from "./diagnostics.js";
import type { ParsedMvccSnapshot } from "./mvcc.js";
import type { PostgreSQLParserRegistry } from "./postgres/parsers.js";
import {
	decodeRow,
	PostgresValueParserError,
	validateColumns,
} from "./postgres/value-decoder.js";
import type {
	MvccSnapshot,
	WireChange,
	WireColumn,
	WireRow,
} from "./protocol/messages.js";
import { applyMaterializedChanges } from "./reconciliation/ordered-changes.js";
import type {
	ReconciledBatch,
	ReconciliationTarget,
} from "./reconciliation/reconciler.js";
import { waitForRows } from "./row-waiter.js";
import type { SealedLiveQuery } from "./sealed-query.js";
import { TransactionTracker } from "./transaction-tracker.js";
import type {
	LiveQueryChange,
	LiveQueryError,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQueryRow,
	RawLiveQueryUpdate,
} from "./types.js";

export interface SubscriptionOwner {
	renew<Row>(
		subscription: Subscription<Row>,
		query: SealedLiveQuery<Row>,
	): Promise<void>;
	unsubscribe<Row>(subscription: Subscription<Row>): void;
	parserFailed<Row>(subscription: Subscription<Row>, cause: Error): void;
}

interface PublicLiveQueryErrorOptions extends ErrorOptions {
	readonly sqlState?: string;
}

export class PublicLiveQueryError extends Error implements LiveQueryError {
	readonly sqlState?: string;

	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message = `Live query failed: ${code}`,
		options?: PublicLiveQueryErrorOptions,
	) {
		super(message, options);
		this.name = "LiveQueryError";
		this.sqlState = options?.sqlState;
	}
}

export class Subscription<Row>
	implements MaterializedLiveQuerySubscription<Row>, ReconciliationTarget
{
	private state: LiveQueryState;
	private snapshot: LiveQuerySnapshot<Row>;
	private rows?: Map<string, Row>;
	private initialized: boolean;
	private columns?: readonly WireColumn[];
	private stagedReset?: {
		readonly rows: readonly RawLiveQueryRow<Row>[];
	};
	private readonly appliedBatches = new Map<
		readonly WireChange[],
		readonly LiveQueryChange<Row>[]
	>();
	private readonly updateListeners = new Set<
		(update: RawLiveQueryUpdate<Row>) => void
	>();
	private readonly stateListeners = new Set<
		(state: LiveQueryState) => void
	>();
	private readonly changeListeners = new Set<
		(snapshot: LiveQuerySnapshot<Row>) => void
	>();
	private readonly transactions = new TransactionTracker();
	closed = false;

	constructor(
		private readonly owner: SubscriptionOwner,
		private query: SealedLiveQuery<Row>,
		readonly materialized: boolean,
		private readonly parsers: PostgreSQLParserRegistry,
		initialData: readonly Row[] | undefined,
		private readonly events: SubscriptionEventSink,
	) {
		if (materialized) {
			this.rows = new Map(
				(initialData ?? []).map((row, index) => [
					`preloaded:${index}`,
					row,
				]),
			);
		}
		this.initialized = initialData !== undefined;
		this.state = connectingState;
		this.snapshot = this.makeSnapshot(
			this.rows && this.initialized
				? Object.freeze([...this.rows.values()])
				: undefined,
		);
	}

	currentQuery(): SealedLiveQuery<Row> {
		return this.query;
	}

	replaceSealedQuery(query: SealedLiveQuery<Row>): void {
		this.query = query;
	}

	renewalFailed(error: unknown): void {
		this.events.renewalFailed(error);
	}

	admit(columns: readonly WireColumn[]): void {
		validateColumns(columns);
		this.columns = columns;
	}

	getState = (): LiveQueryState => this.state;

	getSnapshot = (): LiveQuerySnapshot<Row> => this.snapshot;

	onUpdate = (
		listener: (update: RawLiveQueryUpdate<Row>) => void,
	): (() => void) => listen(this.updateListeners, listener);

	onStateChange = (listener: (state: LiveQueryState) => void): (() => void) =>
		listen(this.stateListeners, listener);

	awaitTxId = (txid: string, timeout?: number): Promise<void> =>
		this.transactions.wait(txid, timeout);

	awaitRows = (
		matches: (rows: readonly Row[]) => boolean,
		timeout?: number,
	): Promise<void> => {
		if (!this.materialized) {
			return Promise.reject(
				new Error("Raw live-query subscriptions do not expose rows"),
			);
		}
		return waitForRows(this, matches, timeout);
	};

	onChange = (
		listener: (snapshot: LiveQuerySnapshot<Row>) => void,
	): (() => void) => {
		if (!this.materialized) {
			throw new Error(
				"Raw live-query subscriptions do not expose snapshots",
			);
		}
		return listen(this.changeListeners, listener);
	};

	renew = (query: SealedLiveQuery<Row>): Promise<void> => {
		if (this.closed) {
			return Promise.reject(
				new Error("Live-query subscription is closed"),
			);
		}
		if (query.queryFingerprint !== this.query.queryFingerprint) {
			return Promise.reject(
				new Error("Live-query renewal must be for the same query"),
			);
		}
		const precedingState =
			this.state.status === "error" || this.state.status === "stale"
				? this.state
				: undefined;
		if (precedingState) this.setLifecycle(connectingState);
		return this.owner.renew(this, query).catch((error: unknown) => {
			if (precedingState && this.state.status !== "error") {
				this.setLifecycle(precedingState);
			}
			throw error;
		});
	};

	unsubscribe = (): void => {
		if (this.closed) return;
		this.owner.unsubscribe(this);
	};

	baselineSyncStarted(): void {
		if (this.closed) return;
		this.events.baselineSyncStarted();
	}

	prepare(
		wireRows: readonly WireRow[] | undefined,
		batches: readonly ReconciledBatch[],
	): () => void {
		if (this.closed) return () => {};
		const reset =
			wireRows === undefined ? undefined : this.decodeReset(wireRows);
		const decodedBatches = new Map<
			readonly WireChange[],
			readonly LiveQueryChange<Row>[]
		>();
		let hasMoves = false;
		for (const batch of batches) {
			const changes = Object.freeze(
				batch.changes.map((change): LiveQueryChange<Row> => {
					if (change.op === "remove") {
						return Object.freeze({
							type: "remove",
							rowId: change.row_key,
						});
					}
					if (change.op === "move") {
						hasMoves = true;
						return Object.freeze({
							type: "move",
							rowId: change.row_key,
							afterRowId: change.after_row_key,
						});
					}
					return Object.freeze({
						type: "upsert",
						rowId: change.row_key,
						row: decodeRow<Row>(
							change.values,
							this.requireColumns(),
							this.requireParsers(),
						),
					});
				}),
			);
			decodedBatches.set(batch.changes, changes);
		}
		const incrementalContents = reset === undefined && !hasMoves;
		let candidate = this.rows
			? reset
				? new Map(reset.map(({ rowId, row }) => [rowId, row]))
				: incrementalContents
					? this.rows
					: new Map(this.rows)
			: undefined;
		if (candidate && !incrementalContents) {
			for (const changes of decodedBatches.values())
				candidate = applyMaterializedChanges(candidate, changes);
		}
		let data =
			candidate &&
			!incrementalContents &&
			(reset !== undefined || this.initialized)
				? Object.freeze([...candidate.values()])
				: undefined;
		// Decode and validate moves before any target installs. Content-only live
		// updates can then mutate the existing Map without cloning the full window.
		// Resets and their complete replay backlog always use a private candidate.
		return () => {
			if (this.closed) return;
			if (candidate && incrementalContents) {
				for (const changes of decodedBatches.values())
					applyMaterializedChanges(candidate, changes);
				data = this.initialized
					? Object.freeze([...candidate.values()])
					: undefined;
			}
			this.rows = candidate;
			this.stagedReset = reset ? { rows: reset } : undefined;
			for (const [changes, decoded] of decodedBatches)
				this.appliedBatches.set(changes, decoded);
			if (reset) this.initialized = true;
			this.snapshot = this.makeSnapshot(data);
		};
	}

	decodeFailed(error: unknown): void {
		if (!(error instanceof PostgresValueParserError)) throw error;
		this.appliedBatches.clear();
		this.stagedReset = undefined;
		this.owner.parserFailed(this, error);
	}

	publishReset(_wireRows: readonly WireRow[], mvcc: MvccSnapshot): void {
		if (this.closed) return;
		const staged = this.stagedReset;
		if (!staged) throw new Error("Realtime published an uninstalled reset");
		this.stagedReset = undefined;
		this.transactions.applySnapshot(mvcc);
		this.notify(
			this.updateListeners,
			Object.freeze({ type: "rows", rows: staged.rows }),
		);
	}

	publishBatch(batch: ReconciledBatch): void {
		if (this.closed) return;
		const changes =
			batch.changes.length === 0
				? (Object.freeze([]) as readonly LiveQueryChange<Row>[])
				: this.appliedBatches.get(batch.changes);
		if (!changes) throw new Error("Realtime published an unapplied batch");
		this.appliedBatches.delete(batch.changes);
		const info = Object.freeze({ txids: batch.txids });
		this.notify(
			this.updateListeners,
			Object.freeze({ type: "changes", changes, batch: info }),
		);
		if (this.materialized && this.state.status === "live") {
			this.notify(this.changeListeners, this.snapshot);
		}
		for (const txid of batch.txids) this.transactions.seen(txid);
	}

	applyProgress(mvcc: ParsedMvccSnapshot): void {
		this.transactions.applyProgress(mvcc);
	}

	caughtUp(): void {
		if (this.closed) return;
		const becameLive = this.state.status !== "live";
		this.setLifecycle(
			Object.freeze({ status: "live", error: undefined }),
			false,
			becameLive ? () => this.events.live() : undefined,
		);
		if (this.materialized) this.notify(this.changeListeners, this.snapshot);
	}

	baselineSyncCompleted(batchCount: number): void {
		if (this.closed) return;
		this.events.baselineSyncCompleted(batchCount);
	}

	resetRequired(): void {
		if (this.closed) return;
		this.events.resetRequired();
	}

	connecting(): void {
		this.resetSynchronization();
		this.setLifecycle(connectingState);
	}

	queryUnavailable(): void {
		this.resetSynchronization();
		this.setLifecycle(staleState);
	}

	fail(error: ConnectionCoordinatorError): void {
		const publicError = new PublicLiveQueryError(
			error.code,
			error.retryable,
			error.message,
			{ cause: error.cause, sqlState: error.sqlState },
		);
		this.transactions.close(publicError);
		this.setLifecycle(
			Object.freeze({
				status: "error",
				error: publicError,
			}),
		);
	}

	markClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.transactions.close();
		this.setLifecycle(
			Object.freeze({ status: "closed", error: undefined }),
		);
	}

	private decodeReset(
		wireRows: readonly WireRow[],
	): readonly RawLiveQueryRow<Row>[] {
		const columns = this.requireColumns();
		const rowIds = new Set<string>();
		return Object.freeze(
			wireRows.map((wireRow) => {
				if (rowIds.has(wireRow.row_key)) {
					throw new Error("Duplicate Realtime row ID");
				}
				rowIds.add(wireRow.row_key);
				return Object.freeze({
					rowId: wireRow.row_key,
					row: decodeRow<Row>(
						wireRow.values,
						columns,
						this.requireParsers(),
					),
				});
			}),
		);
	}

	private requireColumns(): readonly WireColumn[] {
		if (!this.columns)
			throw new Error("Live-query subscription is not admitted");
		return this.columns;
	}

	private requireParsers(): PostgreSQLParserRegistry {
		return this.parsers;
	}

	private resetSynchronization(): void {
		this.columns = undefined;
		this.appliedBatches.clear();
		this.stagedReset = undefined;
	}

	private setLifecycle(
		state: LiveQueryState,
		publishChange = true,
		beforeListeners?: () => void,
	): void {
		if (this.closed && state.status !== "closed") return;
		if (sameState(this.state, state)) return;
		const previousStatus = this.state.status;
		this.state = state;
		this.snapshot = this.makeSnapshot();
		this.events.stateChanged(previousStatus, state.status);
		beforeListeners?.();
		this.notify(this.stateListeners, this.state);
		if (publishChange && this.materialized) {
			this.notify(this.changeListeners, this.snapshot);
		}
	}

	private notify<Arguments extends readonly unknown[]>(
		listeners: Set<(...args: Arguments) => void>,
		...args: Arguments
	): void {
		for (const listener of [...listeners]) {
			try {
				listener(...args);
			} catch (error) {
				this.events.listenerFailed(error);
			}
		}
	}

	private makeSnapshot(data = this.snapshot?.data): LiveQuerySnapshot<Row> {
		return Object.freeze({ ...this.state, data });
	}
}

const connectingState: LiveQueryState = Object.freeze({
	status: "connecting",
	error: undefined,
});

const staleState: LiveQueryState = Object.freeze({
	status: "stale",
	error: undefined,
});

function sameState(left: LiveQueryState, right: LiveQueryState): boolean {
	return left.status === right.status && left.error === right.error;
}

function listen<Listener>(
	listeners: Set<Listener>,
	listener: Listener,
): () => void {
	listeners.add(listener);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		listeners.delete(listener);
	};
}
