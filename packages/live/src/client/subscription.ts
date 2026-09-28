import type { LiveQueryAuthorization } from "./authorization.js";
import type { ConnectionCoordinatorError } from "./connection/coordinator.js";
import type { PostgreSQLParserRegistry } from "./postgres/parsers.js";
import {
	decodeRow,
	PostgresValueParserError,
	validateColumns,
} from "./postgres/value-decoder.js";
import type { WireChange, WireColumn, WireRow } from "./protocol/messages.js";
import type {
	ReconciledBatch,
	ReconciliationTarget,
} from "./reconciliation/reconciler.js";
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
		authorization: LiveQueryAuthorization<Row>,
	): Promise<void>;
	unsubscribe<Row>(subscription: Subscription<Row>): void;
	parserFailed<Row>(subscription: Subscription<Row>, cause: Error): void;
}

export class PublicLiveQueryError extends Error implements LiveQueryError {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message = `Neon Live query failed: ${code}`,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "LiveQueryError";
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
	closed = false;

	constructor(
		private readonly owner: SubscriptionOwner,
		private authorization: LiveQueryAuthorization<Row>,
		readonly materialized: boolean,
		private readonly parsers: PostgreSQLParserRegistry,
		initialData?: readonly Row[],
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

	currentAuthorization(): LiveQueryAuthorization<Row> {
		return this.authorization;
	}

	replaceAuthorization(authorization: LiveQueryAuthorization<Row>): void {
		this.authorization = authorization;
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

	onChange = (
		listener: (snapshot: LiveQuerySnapshot<Row>) => void,
	): (() => void) => {
		if (!this.materialized) {
			throw new Error(
				"Raw Neon Live subscriptions do not expose snapshots",
			);
		}
		return listen(this.changeListeners, listener);
	};

	renew = (authorization: LiveQueryAuthorization<Row>): Promise<void> => {
		if (this.closed) {
			return Promise.reject(
				new Error("Neon Live subscription is closed"),
			);
		}
		if (
			authorization.queryFingerprint !==
			this.authorization.queryFingerprint
		) {
			return Promise.reject(
				new Error("Neon Live renewal must be for the same query"),
			);
		}
		const failedState =
			this.state.status === "error" ? this.state : undefined;
		if (failedState) this.setLifecycle(staleState(this));
		return this.owner.renew(this, authorization).catch((error: unknown) => {
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

	publishReset(): void {
		if (this.closed) return;
		const staged = this.stagedReset;
		if (!staged)
			throw new Error("Neon Live published an uninstalled reset");
		if (this.rows && staged.materializedRows) {
			this.rows.clear();
			for (const [rowId, row] of staged.materializedRows)
				this.rows.set(rowId, row);
		}
		this.stagedReset = undefined;
		this.initialized = true;
		this.snapshot = this.makeSnapshot();
		notify(this.resetListeners, staged.rows);
	}

	publishBatch(batch: ReconciledBatch): void {
		if (this.closed) return;
		const changes =
			batch.changes.length === 0
				? (Object.freeze([]) as readonly LiveQueryChange<Row>[])
				: this.appliedBatches.get(batch.changes);
		if (!changes) throw new Error("Neon Live published an unapplied batch");
		this.appliedBatches.delete(batch.changes);
		const info = Object.freeze({ txids: batch.txids });
		notify(this.batchListeners, changes, info);
		if (this.materialized && this.state.status === "live") {
			notify(this.changeListeners, this.snapshot);
		}
	}

	caughtUp(): void {
		if (this.closed) return;
		this.setLifecycle(
			Object.freeze({ status: "live", error: undefined }),
			false,
		);
		if (this.materialized) notify(this.changeListeners, this.snapshot);
	}

	resetRequired(): void {
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
					{ cause: error.cause },
				),
			}),
		);
	}

	markClosed(): void {
		if (this.closed) return;
		this.closed = true;
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
					throw new Error("Duplicate Neon Live row ID");
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
			throw new Error("Neon Live subscription is not admitted");
		return this.columns;
	}

	private requireParsers(): PostgreSQLParserRegistry {
		return this.parsers;
	}

	private setLifecycle(state: LiveQueryState, publishChange = true): void {
		if (this.closed && state.status !== "closed") return;
		if (sameState(this.state, state)) return;
		this.state = state;
		this.snapshot = this.makeSnapshot();
		notify(this.stateListeners, this.state);
		if (publishChange && this.materialized) {
			notify(this.changeListeners, this.snapshot);
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

function notify<Arguments extends readonly unknown[]>(
	listeners: Set<(...args: Arguments) => void>,
	...args: Arguments
): void {
	for (const listener of [...listeners]) {
		try {
			listener(...args);
		} catch {
			// One application listener cannot interrupt atomic stream delivery.
		}
	}
}
