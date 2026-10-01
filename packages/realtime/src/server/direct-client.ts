import type { PostgreSQLParsers } from "../client/postgres/parsers.js";
import type { SealedLiveQuery } from "../client/sealed-query.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RealtimeClient,
	RealtimeLogger,
	RealtimeLogLevel,
	RawLiveQueryOptions,
	RawLiveQuerySubscription,
} from "../client/types.js";
import {
	type ManagedDirectSubscription,
	manageDirectSubscription,
} from "./direct-subscription.js";

type DirectSubscription = ManagedDirectSubscription<
	RawLiveQuerySubscription<unknown>
>;

interface DirectLiveQueryClientOptions {
	readonly url: string;
	readonly parsers?: PostgreSQLParsers;
	readonly logLevel?: RealtimeLogLevel;
	readonly logger?: RealtimeLogger;
}

/** Own the lazily loaded low-level client used by trusted subscriptions. */
export class DirectLiveQueryClient {
	private readonly subscriptions = new Set<DirectSubscription>();
	private client?: RealtimeClient;
	private clientPromise?: Promise<RealtimeClient>;
	private closed = false;

	constructor(private readonly options: DirectLiveQueryClientOptions) {
		if (!options.url) throw new Error("Realtime requires a WebSocket URL");
	}

	assertOpen(): void {
		if (this.closed) throw new Error("Realtime direct client is closed");
	}

	async subscribe<Row>(
		query: SealedLiveQuery<Row>,
		options:
			| MaterializedLiveQueryOptions<Row>
			| RawLiveQueryOptions
			| undefined,
		refreshQuery: () => Promise<SealedLiveQuery<Row>>,
	): Promise<
		MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row>
	> {
		this.assertOpen();
		const client = await this.getClient();
		const subscription = subscribeClient(client, query, options);
		let managed!: ManagedDirectSubscription<typeof subscription>;
		managed = manageDirectSubscription(
			subscription,
			query,
			refreshQuery,
			() => this.subscriptions.delete(managed as DirectSubscription),
		);
		this.subscriptions.add(managed as DirectSubscription);
		return managed.subscription;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const subscription of [...this.subscriptions]) {
			subscription.stopRefresh();
		}
		this.subscriptions.clear();
		this.client?.close();
	}

	private getClient(): Promise<RealtimeClient> {
		this.assertOpen();
		this.clientPromise ??= import("../client/realtime-client.js").then(
			(module) => {
				this.assertOpen();
				const client = module.createRealtimeClient({
					url: this.options.url,
					parsers: this.options.parsers,
					logLevel: this.options.logLevel,
					logger: this.options.logger,
				});
				this.client = client;
				return client;
			},
		);
		return this.clientPromise;
	}
}

function subscribeClient<Row>(
	client: RealtimeClient,
	query: SealedLiveQuery<Row>,
	options?: MaterializedLiveQueryOptions<Row> | RawLiveQueryOptions,
): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
	if (options?.materialize === false) {
		return client.subscribe(query, options);
	}
	return client.subscribe(query, options);
}
