import type { PostgreSQLParsers } from "./postgres/parsers.js";
import type { SealedLiveQuery } from "./sealed-query.js";

/** Client-side diagnostic verbosity. */
export type RealtimeLogLevel = "silent" | "error" | "warn" | "info" | "debug";

type EmittedRealtimeLogLevel = Exclude<RealtimeLogLevel, "silent">;

interface SubscriptionLogMetadata {
	/** Client-local opaque subscription identifier. */
	readonly subscriptionId: string;
}

interface ErrorLogMetadata {
	/** Stable machine-readable error code. */
	readonly code: string;
	/** Whether the reported condition can be retried. */
	readonly retryable: boolean;
	/**
	 * Original error. It may contain details from the proxy or application code
	 * and should be handled according to the application's error-logging policy.
	 */
	readonly error: unknown;
}

/** @internal Type-level catalogue used to derive the public diagnostic union. */
export interface RealtimeLogEventDefinition {
	readonly client_closed: {
		readonly level: "info";
		readonly metadata: object;
	};
	readonly connection_attempt_started: {
		readonly level: "debug";
		readonly metadata: { readonly attempt?: number };
	};
	readonly connection_failed: {
		readonly level: "error";
		readonly metadata: ErrorLogMetadata;
	};
	readonly connection_heartbeat_ping_sent: {
		readonly level: "debug";
		readonly metadata: object;
	};
	readonly connection_heartbeat_pong_received: {
		readonly level: "debug";
		readonly metadata: object;
	};
	readonly connection_heartbeat_timeout: {
		readonly level: "debug";
		readonly metadata: object;
	};
	readonly connection_lost: {
		readonly level: "warn";
		readonly metadata: {
			readonly activeSubscriptionCount: number;
			readonly code?: string;
			readonly retryable?: boolean;
			readonly error?: unknown;
		};
	};
	readonly connection_publication_committed: {
		readonly level: "debug";
		readonly metadata: { readonly bodyCount: number };
	};
	readonly connection_ready: {
		readonly level: "info";
		readonly metadata: { readonly attempt?: number };
	};
	readonly connection_reconnect_exhausted: {
		readonly level: "error";
		readonly metadata: ErrorLogMetadata;
	};
	readonly connection_reconnect_scheduled: {
		readonly level: "debug";
		readonly metadata: {
			readonly attempt: number;
			readonly delayMs: number;
		};
	};
	readonly connection_recovered: {
		readonly level: "info";
		readonly metadata: {
			readonly attempt?: number;
			readonly durationMs: number;
		};
	};
	readonly connection_stable: {
		readonly level: "debug";
		readonly metadata: object;
	};
	readonly query_encryption_key_rotated: {
		readonly level: "warn";
		readonly metadata: SubscriptionLogMetadata & ErrorLogMetadata;
	};
	readonly query_expired: {
		readonly level: "warn";
		readonly metadata: SubscriptionLogMetadata & ErrorLogMetadata;
	};
	readonly query_refresh_callback_failed: {
		readonly level: "warn";
		readonly metadata: SubscriptionLogMetadata & {
			readonly error: unknown;
		};
	};
	readonly query_refresh_callback_started: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly query_refresh_callback_succeeded: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly query_refresh_scheduled: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata & {
			readonly delayMs: number;
			readonly expiresAt: number;
		};
	};
	readonly query_refresh_stopped: {
		readonly level: "error";
		readonly metadata: SubscriptionLogMetadata & {
			readonly error: unknown;
		};
	};
	readonly subscription_admitted: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_failed: {
		readonly level: "error";
		readonly metadata: SubscriptionLogMetadata & ErrorLogMetadata;
	};
	readonly subscription_listener_failed: {
		readonly level: "warn";
		readonly metadata: SubscriptionLogMetadata & {
			readonly error: unknown;
		};
	};
	readonly subscription_live: {
		readonly level: "info";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_renewal_failed: {
		readonly level: "warn";
		readonly metadata: SubscriptionLogMetadata & {
			readonly error: unknown;
		};
	};
	readonly subscription_renewal_started: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_renewed: {
		readonly level: "info";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_reset_required: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_row_decoding_failed: {
		readonly level: "error";
		readonly metadata: SubscriptionLogMetadata & ErrorLogMetadata;
	};
	readonly subscription_baseline_sync_completed: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata & {
			readonly batchCount: number;
		};
	};
	readonly subscription_baseline_sync_started: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_started: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
	readonly subscription_state_changed: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata & {
			readonly fromStatus: LiveQueryState["status"];
			readonly toStatus: LiveQueryState["status"];
		};
	};
	readonly subscription_unsubscribed: {
		readonly level: "debug";
		readonly metadata: SubscriptionLogMetadata;
	};
}

/** Stable name for one client diagnostic event. */
export type RealtimeLogEvent = keyof RealtimeLogEventDefinition;

type RealtimeLogEntryFor<Event extends RealtimeLogEvent> = Readonly<
	{
		/** Severity used for level filtering and the default console method. */
		level: RealtimeLogEventDefinition[Event]["level"] &
			EmittedRealtimeLogLevel;
		/** Stable machine-readable event name. */
		event: Event;
		/** Human-readable event summary; use `event` for program logic. */
		message: string;
		/** Unix timestamp in milliseconds at which the event was emitted. */
		timestamp: number;
	} & RealtimeLogEventDefinition[Event]["metadata"]
>;

/**
 * Structured client diagnostic passed to a configured logger.
 *
 * Narrowing on `event` also narrows the metadata available on the entry.
 */
export type RealtimeLogEntry = {
	[Event in RealtimeLogEvent]: RealtimeLogEntryFor<Event>;
}[RealtimeLogEvent];

/** Receives structured Realtime client diagnostics. */
export type RealtimeLogger = (entry: RealtimeLogEntry) => void;

/** An error reported by a live-query subscription. */
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
 * A row in a raw reset, paired with its opaque Realtime identity.
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
	 * Pass an ID from a transaction already known to have committed. This is
	 * not a check of whether a transaction committed or rolled back.
	 * Live batches, applied baselines, and ordered MVCC progress can confirm the
	 * transaction, including mutations that produce no result changes. Progress
	 * is periodic and size-bounded: excluded transactions and conservative
	 * truncation can delay confirmation. Use a timeout to bound the wait.
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

/** Configuration for a reusable Realtime browser client. */
export interface RealtimeClientOptions {
	/**
	 * Realtime proxy WebSocket URL, using `wss:` outside local development.
	 */
	readonly url: string;
	/**
	 * PostgreSQL result parsers keyed by type OID.
	 *
	 * These entries override {@link nodePostgresParsers}. The client snapshots
	 * the object when it is created, so later mutations have no effect.
	 */
	readonly parsers?: PostgreSQLParsers;
	/**
	 * Minimum client diagnostic level. The default, `silent`, emits nothing.
	 * When enabled without {@link logger}, entries are written to `console`.
	 */
	readonly logLevel?: RealtimeLogLevel;
	/**
	 * Structured diagnostic sink. It is called only for events enabled by
	 * {@link logLevel}; exceptions from the sink are ignored.
	 */
	readonly logger?: RealtimeLogger;
}

/** A client that multiplexes independently disposable subscriptions. */
export interface RealtimeClient {
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
