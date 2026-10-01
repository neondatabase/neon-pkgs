import {
	ConnectionCoordinator,
	ConnectionCoordinatorError,
	type ConnectionHandle,
} from "./connection/coordinator.js";
import {
	createRealtimeDiagnostics,
	type RealtimeDiagnostics,
	registerSubscriptionDiagnostics,
} from "./diagnostics.js";
import {
	createParserRegistry,
	type PostgreSQLParserRegistry,
} from "./postgres/parsers.js";
import { type SealedLiveQuery, validateSealedQuery } from "./sealed-query.js";
import { Subscription } from "./subscription.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
	RealtimeClient,
	RealtimeClientOptions,
} from "./types.js";

export type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQueryError,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
	RealtimeClient,
	RealtimeClientOptions,
	RealtimeLogEntry,
	RealtimeLogEvent,
	RealtimeLogger,
	RealtimeLogLevel,
} from "./types.js";

class RealtimeClientImpl implements RealtimeClient {
	private readonly coordinator: ConnectionCoordinator;
	private readonly handles = new Map<
		Subscription<unknown>,
		ConnectionHandle
	>();
	private disposed = false;
	private readonly parsers: PostgreSQLParserRegistry;
	private readonly diagnostics: RealtimeDiagnostics;

	constructor(options: RealtimeClientOptions) {
		this.diagnostics = createRealtimeDiagnostics(options);
		this.coordinator = new ConnectionCoordinator({
			...options,
			diagnostics: this.diagnostics,
		});
		this.parsers = createParserRegistry(options.parsers);
	}

	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?: MaterializedLiveQueryOptions<Row>,
	): MaterializedLiveQuerySubscription<Row>;
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<Row>;
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?: MaterializedLiveQueryOptions<Row> | RawLiveQueryOptions,
	): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
		if (this.disposed) throw new Error("Realtime client is closed");
		validateSealedQuery(query);
		const materialized = options?.materialize !== false;
		const subscriptionId = this.diagnostics.nextSubscriptionId();
		const initialData = materialized
			? (options as MaterializedLiveQueryOptions<Row> | undefined)
					?.initialData
			: undefined;
		const subscription = new Subscription(
			this,
			query,
			materialized,
			this.parsers,
			initialData,
			this.diagnostics,
			subscriptionId,
		);
		registerSubscriptionDiagnostics(subscription, {
			diagnostics: this.diagnostics,
			subscriptionId,
		});
		const handle = this.coordinator.subscribe(query, {
			subscriptionId,
			reconciliation: subscription,
			admitted: (columns) => subscription.admit(columns),
			disconnected: () => subscription.disconnected(),
			failed: (error) => subscription.fail(error),
		});
		this.handles.set(subscription as Subscription<unknown>, handle);
		return subscription;
	}

	async renew<Row>(
		subscription: Subscription<Row>,
		query: SealedLiveQuery<Row>,
	): Promise<void> {
		validateSealedQuery(query);
		const handle = this.handles.get(subscription as Subscription<unknown>);
		if (!handle) throw new Error("Live-query subscription is closed");
		await handle.renew(query);
		subscription.replaceSealedQuery(query);
	}

	unsubscribe<Row>(subscription: Subscription<Row>): void {
		const handle = this.handles.get(subscription as Subscription<unknown>);
		if (!handle) return;
		this.handles.delete(subscription as Subscription<unknown>);
		subscription.markClosed();
		handle.unsubscribe();
	}

	parserFailed<Row>(subscription: Subscription<Row>, cause: Error): void {
		const handle = this.handles.get(subscription as Subscription<unknown>);
		if (!handle) return;
		handle.fail(
			new ConnectionCoordinatorError(
				"parser_error",
				false,
				cause.message,
				{ cause: cause.cause },
			),
		);
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const subscription of this.handles.keys())
			subscription.markClosed();
		this.handles.clear();
		this.coordinator.close();
		this.diagnostics.log(
			"info",
			"client_closed",
			"Realtime client closed",
		);
	}
}

/**
 * Create a reusable client that lazily opens and multiplexes a Realtime
 * WebSocket connection that is bound by its first accepted query capability.
 *
 * The connection carries no user session credential; each subscription sends
 * its own short-lived sealed query. Idle connections are heartbeat-probed,
 * and recoverable disconnects retry with capped jittered backoff until the
 * connection recovers or the client is closed.
 *
 * @param options - Browser client configuration, including the proxy WebSocket
 * URL.
 * @returns A client that opens its connection when the first query subscribes.
 */
export function createRealtimeClient(
	options: RealtimeClientOptions,
): RealtimeClient {
	return new RealtimeClientImpl(options);
}
