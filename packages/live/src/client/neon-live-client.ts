import {
	type LiveQueryAuthorization,
	validateAuthorization,
} from "./authorization.js";
import {
	ConnectionCoordinator,
	type ConnectionHandle,
} from "./connection/coordinator.js";
import { Subscription } from "./subscription.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
	NeonLiveClientOptions,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
} from "./types.js";

export type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQueryError,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
	NeonLiveClientOptions,
	RawLiveQueryOptions,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
} from "./types.js";

class NeonLiveClientImpl implements NeonLiveClient {
	private readonly coordinator: ConnectionCoordinator;
	private readonly handles = new Map<
		Subscription<unknown>,
		ConnectionHandle
	>();
	private disposed = false;

	constructor(options: NeonLiveClientOptions) {
		this.coordinator = new ConnectionCoordinator(options);
	}

	subscribe<Row>(
		authorization: LiveQueryAuthorization<Row>,
		options?: MaterializedLiveQueryOptions<Row>,
	): MaterializedLiveQuerySubscription<Row>;
	subscribe<Row>(
		authorization: LiveQueryAuthorization<Row>,
		options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<Row>;
	subscribe<Row>(
		authorization: LiveQueryAuthorization<Row>,
		options?: MaterializedLiveQueryOptions<Row> | RawLiveQueryOptions,
	): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
		if (this.disposed) throw new Error("Neon Live client is closed");
		validateAuthorization(authorization);
		const materialized = options?.materialize !== false;
		const initialData = materialized
			? (options as MaterializedLiveQueryOptions<Row> | undefined)
					?.initialData
			: undefined;
		const subscription = new Subscription(
			this,
			authorization,
			materialized,
			initialData,
		);
		const handle = this.coordinator.subscribe(authorization, {
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
		authorization: LiveQueryAuthorization<Row>,
	): Promise<void> {
		validateAuthorization(authorization);
		const handle = this.handles.get(subscription as Subscription<unknown>);
		if (!handle) throw new Error("Neon Live subscription is closed");
		await handle.renew(authorization);
		subscription.replaceAuthorization(authorization);
	}

	unsubscribe<Row>(subscription: Subscription<Row>): void {
		const handle = this.handles.get(subscription as Subscription<unknown>);
		if (!handle) return;
		this.handles.delete(subscription as Subscription<unknown>);
		subscription.markClosed();
		handle.unsubscribe();
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const subscription of this.handles.keys())
			subscription.markClosed();
		this.handles.clear();
		this.coordinator.close();
	}
}

/**
 * Create a reusable client that lazily opens and multiplexes a Neon Live
 * WebSocket connection that is bound by its first accepted query capability.
 *
 * The connection carries no user session credential; each subscription sends
 * its own short-lived authorization. Idle connections are heartbeat-probed,
 * and recoverable disconnects retry with capped jittered backoff until the
 * connection recovers or the client is closed.
 *
 * @param options - Browser client configuration, including the proxy WebSocket
 * URL.
 * @returns A client that opens its connection when the first query subscribes.
 */
export function createNeonLiveClient(
	options: NeonLiveClientOptions,
): NeonLiveClient {
	return new NeonLiveClientImpl(options);
}
