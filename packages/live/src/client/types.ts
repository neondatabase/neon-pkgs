import type { PostgreSQLParsers } from "./postgres/parsers.js";
import type { SealedLiveQuery } from "./sealed-query.js";

/** An error reported by a Neon Live subscription. */
export interface LiveQueryError extends Error {
	/** Stable machine-readable error code. */
	readonly code: string;
	/** Whether reconnecting or obtaining a fresh sealed query may recover it. */
	readonly retryable: boolean;
}

/** Atomic lifecycle state for a live-query subscription. */
export type LiveQueryState =
	| {
			/** Current non-error lifecycle status. */
			readonly status: "connecting" | "live" | "stale" | "closed";
			/** Non-error states never carry an error. */
			readonly error: undefined;
	  }
	| {
			/** Indicates that automatic recovery has stopped. */
			readonly status: "error";
			/** Failure that caused the error state. */
			readonly error: LiveQueryError;
	  };

/**
 * Materialized query rows paired with their atomic lifecycle state.
 *
 * @typeParam Row - Row produced by the subscribed query.
 */
export type LiveQuerySnapshot<Row> = LiveQueryState & {
	/** Current rows, or `undefined` before the first reset when not preloaded. */
	readonly data: readonly Row[] | undefined;
};

/** Metadata for one atomically published batch of PostgreSQL transactions. */
export interface LiveQueryBatchInfo {
	/** Exact PostgreSQL transaction IDs represented as decimal strings. */
	readonly txids: readonly string[];
}

/**
 * A row in a raw reset, paired with its opaque Neon Live identity.
 *
 * @typeParam Row - Row produced by the subscribed query.
 */
export interface RawLiveQueryRow<Row> {
	/** Opaque identity scoped to the subscription and invalidated by reset. */
	readonly rowId: string;
	/** Decoded query row. */
	readonly row: Row;
}

/**
 * A row upsert or removal in an atomic publication batch.
 *
 * @typeParam Row - Row produced by the subscribed query.
 */
export type LiveQueryChange<Row> =
	| {
			/** Insert or replace the complete row at this opaque identity. */
			readonly type: "upsert";
			/** Opaque identity scoped to the subscription and invalidated by reset. */
			readonly rowId: string;
			/** Complete row after the insert or update. */
			readonly row: Row;
	  }
	| {
			/** Remove the row at this opaque identity. */
			readonly type: "remove";
			/** Opaque identity scoped to the subscription and invalidated by reset. */
			readonly rowId: string;
	  };

/** Options for the default materialized subscription. */
export interface MaterializedLiveQueryOptions<Row> {
	/** Select materialization; omitted and `true` are equivalent. */
	readonly materialize?: true;
	/** Preloaded rows exposed as stale data until the first authoritative reset. */
	readonly initialData?: readonly Row[];
}

/** Options for a raw, non-materializing subscription. */
export interface RawLiveQueryOptions {
	/** Disable SDK materialization and consume resets and batches directly. */
	readonly materialize: false;
}

/**
 * A live-query subscription that exposes raw reset and publication events.
 *
 * @typeParam Row - Row produced by the subscribed query.
 */
export interface RawLiveQuerySubscription<Row> {
	/** Return the complete current lifecycle state. */
	getState(): LiveQueryState;
	/**
	 * Observe authoritative full-result resets.
	 * A reset replaces the preceding row-ID namespace in its entirety.
	 *
	 * @returns A function that removes this listener.
	 */
	onReset(
		listener: (rows: readonly RawLiveQueryRow<Row>[]) => void,
	): () => void;
	/**
	 * Observe changes from one atomic publication and its transaction IDs.
	 * Every affected materialized subscription has already applied the batch
	 * before any batch listener runs.
	 *
	 * @returns A function that removes this listener.
	 */
	onBatch(
		listener: (
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void,
	): () => void;
	/**
	 * Observe lifecycle transitions.
	 *
	 * @returns A function that removes this listener.
	 */
	onStateChange(listener: (state: LiveQueryState) => void): () => void;
	/**
	 * Wait until this subscription has applied a PostgreSQL transaction.
	 *
	 * Recently applied transaction IDs are retained so this also succeeds when
	 * the batch arrives before the caller receives the mutation response.
	 *
	 * @remarks
	 * This resolves for transaction IDs included in a live batch or proven
	 * visible by the last successfully applied reset snapshot. Neon Live does
	 * not currently acknowledge a no-op transaction after that snapshot. It can
	 * resolve only if a later reset proves it visible; otherwise it remains
	 * pending until the timeout elapses or the subscription closes.
	 *
	 * @param txid - PostgreSQL transaction ID as a decimal string.
	 * @param timeout - Optional maximum wait in milliseconds. By default the
	 * promise remains pending until the transaction arrives or the subscription
	 * closes.
	 * @throws If the timeout elapses, the transaction ID is invalid, or the
	 * subscription closes before applying the transaction.
	 */
	awaitTxId(txid: string, timeout?: number): Promise<void>;
	/**
	 * Renew this logical subscription with a capability for the same exact query.
	 * If the preceding subscription has expired, the client creates a new
	 * wire subscription while preserving this object, its listeners, and any
	 * retained rows. The replacement then produces a new authoritative reset.
	 *
	 * @returns A promise that resolves after the proxy accepts the replacement.
	 * A subsequent authoritative reset returns the subscription to `live`.
	 * @throws If the replacement query fingerprint differs or renewal is rejected.
	 */
	renew(query: SealedLiveQuery<Row>): Promise<void>;
	/** Permanently close this subscription and remove its listeners. */
	unsubscribe(): void;
}

/**
 * A live-query subscription that also retains and publishes the current rows.
 *
 * @typeParam Row - Row produced by the subscribed query.
 */
export interface MaterializedLiveQuerySubscription<Row>
	extends RawLiveQuerySubscription<Row> {
	/** Return the current rows and lifecycle state atomically. */
	getSnapshot(): LiveQuerySnapshot<Row>;
	/**
	 * Wait until the materialized rows satisfy a predicate.
	 *
	 * The current snapshot is inspected before waiting for later changes, so
	 * this also succeeds when matching rows arrived before the call.
	 *
	 * @param matches - Predicate evaluated against each complete row snapshot.
	 * @param timeout - Optional maximum wait in milliseconds. By default the
	 * promise remains pending until the rows match or the subscription closes.
	 * @throws If a supplied timeout elapses, the predicate throws, or the
	 * subscription closes or enters a terminal error before the rows match.
	 */
	awaitRows(
		matches: (rows: readonly Row[]) => boolean,
		timeout?: number,
	): Promise<void>;
	/**
	 * Observe row or lifecycle changes as complete snapshots.
	 * The listener runs after resets, publication batches, and state transitions.
	 *
	 * @returns A function that removes this listener.
	 */
	onChange(listener: (snapshot: LiveQuerySnapshot<Row>) => void): () => void;
}

/** Configuration for a reusable Neon Live browser client. */
export interface NeonLiveClientOptions {
	/**
	 * Neon Live proxy WebSocket URL, using `wss:` outside local development.
	 */
	readonly url: string;
	/**
	 * PostgreSQL result parsers keyed by type OID.
	 *
	 * These entries override {@link nodePostgresParsers}. The client snapshots
	 * the object when it is created, so later mutations have no effect.
	 */
	readonly parsers?: PostgreSQLParsers;
}

/** A client that multiplexes independently disposable subscriptions. */
export interface NeonLiveClient {
	/**
	 * Start a materialized subscription, optionally with preloaded rows.
	 *
	 * @typeParam Row - Row inferred from the query.
	 * @param query - Short-lived capability returned by the application
	 * backend.
	 * @param options - Materialization and optional preloaded-row settings.
	 * @returns An independently disposable materialized subscription.
	 * @throws If the query is malformed or the client is closed.
	 */
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?: MaterializedLiveQueryOptions<Row>,
	): MaterializedLiveQuerySubscription<Row>;
	/**
	 * Start a raw subscription without retaining query rows in the SDK.
	 *
	 * @typeParam Row - Row inferred from the query.
	 * @param query - Short-lived capability returned by the application
	 * backend.
	 * @param options - Set `materialize` to `false` to consume raw events.
	 * @returns An independently disposable raw subscription.
	 * @throws If the query is malformed or the client is closed.
	 */
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<Row>;
	/** Permanently close all subscriptions and the underlying WebSocket. */
	close(): void;
}
