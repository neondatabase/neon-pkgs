import {
	ConnectionCoordinator,
	ConnectionCoordinatorError,
	type ConnectionHandle,
} from "./connection/coordinator.js";
import { scheduleMicrotask } from "./diagnostics/dispatcher.js";
import {
	type ClientEventSink,
	createClientEventSink,
	registerSubscriptionEvents,
} from "./diagnostics.js";
import type { NoInferCompat } from "./no-infer.js";
import {
	createParserRegistry,
	type PostgreSQLParserRegistry,
} from "./postgres/parsers.js";
import { type SealedLiveQuery, validateSealedQuery } from "./sealed-query.js";
import { PublicLiveQueryError, Subscription } from "./subscription.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
	RealtimeClient,
	RealtimeClientOptions,
	RealtimeConnectionState,
	WebSocketFactory,
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
	RealtimeConnectionState,
	RealtimeLogEntry,
	RealtimeLogEvent,
	RealtimeLogger,
	RealtimeLogLevel,
	WebSocketFactory,
	WebSocketLike,
} from "./types.js";

class RealtimeClientImpl implements RealtimeClient {
	private readonly coordinator: ConnectionCoordinator;
	private readonly handles = new Map<
		Subscription<unknown>,
		ConnectionHandle
	>();
	private disposed = false;
	private readonly parsers: PostgreSQLParserRegistry;
	private readonly events: ClientEventSink;
	private connectionState: RealtimeConnectionState = IDLE_CONNECTION;
	private deliveredConnectionState: RealtimeConnectionState = IDLE_CONNECTION;
	private readonly connectionListeners = new Set<
		(state: RealtimeConnectionState) => void
	>();
	private connectionDeliveryScheduled = false;
	private connectionFailure?: ConnectionCoordinatorError;

	constructor(options: RealtimeClientOptions) {
		this.events = createClientEventSink(options);
		this.coordinator = new ConnectionCoordinator({
			url: options.url,
			events: this.events,
			webSocketFactory: options.webSocketFactory,
			statusMayHaveChanged: () => this.scheduleConnectionDelivery(),
		});
		this.parsers = createParserRegistry(options.parsers);
	}

	getConnectionState = (): RealtimeConnectionState => {
		const status = this.coordinator.connectionStatus();
		if (status === "failed") {
			const failure = this.coordinator.connectionFailure();
			if (
				this.connectionState.status !== "error" ||
				this.connectionFailure !== failure
			) {
				this.connectionFailure = failure;
				this.connectionState = Object.freeze({
					status: "error",
					error: failure
						? new PublicLiveQueryError(
								failure.code,
								failure.retryable,
								failure.message,
								{
									cause: failure.cause,
									sqlState: failure.sqlState,
								},
							)
						: new PublicLiveQueryError("connection_lost", false),
				});
			}
		} else if (this.connectionState.status !== status) {
			this.connectionState = Object.freeze({ status, error: undefined });
		}
		return this.connectionState;
	};

	onConnectionStateChange = (
		listener: (state: RealtimeConnectionState) => void,
	): (() => void) => {
		if (this.getConnectionState().status === "closed") return () => {};
		if (this.connectionListeners.size === 0) {
			this.deliveredConnectionState = this.getConnectionState();
		}
		this.connectionListeners.add(listener);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.connectionListeners.delete(listener);
		};
	};

	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?: MaterializedLiveQueryOptions<NoInferCompat<Row>>,
	): MaterializedLiveQuerySubscription<Row>;
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<Row>;
	subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options?:
			| MaterializedLiveQueryOptions<NoInferCompat<Row>>
			| RawLiveQueryOptions,
	): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
		if (this.disposed) throw new Error("Realtime client is closed");
		validateSealedQuery(query);
		const materialized = options?.materialize !== false;
		const events = this.events.createSubscription();
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
			events,
		);
		registerSubscriptionEvents(subscription, events);
		const handle = this.coordinator.subscribe(query, {
			events,
			reconciliation: subscription,
			admitted: (columns) => subscription.admit(columns),
			connecting: () => subscription.connecting(),
			queryUnavailable: () => subscription.queryUnavailable(),
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
		try {
			await handle.renew(query);
			subscription.replaceSealedQuery(query);
		} catch (error) {
			const state = subscription.getState();
			if (
				state.status !== "closed" &&
				(!(error instanceof ConnectionCoordinatorError) ||
					error.retryable)
			) {
				subscription.renewalFailed(error);
			}
			throw error;
		}
	}

	unsubscribe<Row>(subscription: Subscription<Row>): void {
		const handle = this.handles.get(subscription as Subscription<unknown>);
		if (!handle) return;
		this.handles.delete(subscription as Subscription<unknown>);
		handle.unsubscribe();
		subscription.markClosed();
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
		this.events.closed();
	}

	/** Deliver the latest state once, after the transition that changed it. */
	private scheduleConnectionDelivery(): void {
		if (
			this.connectionDeliveryScheduled ||
			this.connectionListeners.size === 0
		)
			return;
		this.connectionDeliveryScheduled = true;
		scheduleMicrotask(() => {
			this.connectionDeliveryScheduled = false;
			const state = this.getConnectionState();
			const delivered = this.deliveredConnectionState;
			if (
				state.status === delivered.status &&
				state.error === delivered.error
			)
				return;
			this.deliveredConnectionState = state;
			for (const listener of [...this.connectionListeners]) {
				try {
					listener(state);
				} catch (error) {
					this.events.connection.listenerFailed(error);
				}
			}
			if (state.status === "closed") this.connectionListeners.clear();
		});
	}
}

const IDLE_CONNECTION: RealtimeConnectionState = Object.freeze({
	status: "idle",
	error: undefined,
});

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

/** @internal Node direct subscriptions supply a terminable WebSocket. */
export function createRealtimeClientInternal(
	options: RealtimeClientOptions & {
		readonly webSocketFactory: WebSocketFactory;
	},
): RealtimeClient {
	return new RealtimeClientImpl(options);
}
