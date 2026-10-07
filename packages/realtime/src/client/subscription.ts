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
import type {
	ReconciledBatch,
	ReconciliationTarget,
} from "./reconciliation/reconciler.js";
import { waitForRows } from "./row-waiter.js";
import type { SealedLiveQuery } from "./sealed-query.js";
import { TransactionTracker } from "./transaction-tracker.js";
import type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQueryError,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQueryRow,
} from "./types.js";

export interface SubscriptionOwner {
	renew<Row>(
		subscription: Subscription<Row>,
		query: SealedLiveQuery<Row>,
	): Promise<void>;
	unsubscribe<Row>(subscription: Subscription<Row>): void;
	parserFailed<Row>(subscription: Subscription<Row>, cause: Error): void;
}

export class PublicLiveQueryError extends Error implements LiveQueryError {
	readonly sqlState?: string;

	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message = `Live query failed: ${code}`,
		options?: ErrorOptions & { readonly sqlState?: string },
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
	private readonly rows?: Map<string, Row>;
	private initialized: boolean;
	private columns?: readonly WireColumn[];
	private stagedReset?: {
		readonly rows: readonly RawLiveQueryRow<Row>[];
		readonly materializedRows?: Map<string, Row>;
	};
	private readonly appliedBatches = new Map<
		readonly WireChange[],
		readonly LiveQueryChange<Row>[]
	>();
	private readonly resetListeners = new Set<
		(rows: readonly RawLiveQueryRow<Row>[]) => void
	>();
	private readonly batchListeners = new Set<
		(
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void
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
		this.state = Object.freeze({
			status: initialData === undefined ? "connecting" : "stale",
			error: undefined,
		});
		this.snapshot = this.makeSnapshot();
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

	onReset = (
		listener: (rows: readonly RawLiveQueryRow<Row>[]) => void,
	): (() => void) => listen(this.resetListeners, listener);

	onBatch = (
		listener: (
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void,
	): (() => void) => listen(this.batchListeners, listener);

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
		const failedState =
			this.state.status === "error" ? this.state : undefined;
		if (failedState) this.setLifecycle(staleState(this));
		return this.owner.renew(this, query).catch((error: unknown) => {
			if (failedState && this.state.status !== "error") {
				this.setLifecycle(failedState);
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

	installReset(wireRows: readonly WireRow[]): void {
		if (this.closed) return;
		const rows = this.decodeReset(wireRows);
		this.stagedReset = {
			rows,
			materializedRows: this.rows
				? new Map(rows.map(({ rowId, row }) => [rowId, row]))
				: undefined,
		};
	}

	applyBatch(wireChanges: readonly WireChange[]): void {
		if (this.closed) return;
		const changes = Object.freeze(
			wireChanges.map((change): LiveQueryChange<Row> => {
				if (change.op === "remove") {
					return Object.freeze({
						type: "remove",
						rowId: change.row_key,
					});
				}
				const row = decodeRow<Row>(
					change.values,
					this.requireColumns(),
					this.requireParsers(),
				);
				return Object.freeze({
					type: "upsert",
					rowId: change.row_key,
					row,
				});
			}),
		);
		const targetRows = this.stagedReset?.materializedRows ?? this.rows;
		for (const change of changes) {
			if (change.type === "remove") targetRows?.delete(change.rowId);
			else targetRows?.set(change.rowId, change.row);
		}
		this.appliedBatches.set(wireChanges, changes);
		if (!this.stagedReset) this.snapshot = this.makeSnapshot();
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
		if (this.rows && staged.materializedRows) {
			this.rows.clear();
			for (const [rowId, row] of staged.materializedRows)
				this.rows.set(rowId, row);
		}
		this.stagedReset = undefined;
		this.initialized = true;
		this.snapshot = this.makeSnapshot();
		this.transactions.applySnapshot(mvcc);
		this.notify(this.resetListeners, staged.rows);
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
		this.notify(this.batchListeners, changes, info);
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
		this.setLifecycle(staleState(this));
	}

	disconnected(): void {
		this.columns = undefined;
		this.appliedBatches.clear();
		this.stagedReset = undefined;
		this.setLifecycle(staleState(this));
	}

	fail(error: ConnectionCoordinatorError): void {
		this.setLifecycle(
			Object.freeze({
				status: "error",
				error: new PublicLiveQueryError(
					error.code,
					error.retryable,
					error.message,
					{ cause: error.cause, sqlState: error.sqlState },
				),
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

	hasRetainedState(): boolean {
		return this.initialized;
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

	private makeSnapshot(): LiveQuerySnapshot<Row> {
		const data =
			this.materialized && this.rows && this.initialized
				? Object.freeze([...this.rows.values()])
				: undefined;
		return Object.freeze({ ...this.state, data });
	}
}

export function staleState<Row>(
	subscription: Subscription<Row>,
): LiveQueryState {
	return Object.freeze({
		status: subscription.hasRetainedState() ? "stale" : "connecting",
		error: undefined,
	});
}

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
