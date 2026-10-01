import type { PostgreSQLParsers } from "../client/postgres/parsers.js";
import type { SealedLiveQuery } from "../client/sealed-query.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
	NeonLiveLogger,
	NeonLiveLogLevel,
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

/** Own the lazily loaded low-level client used by trusted subscriptions. */
export class DirectLiveQueryClient {
	private readonly subscriptions = new Set<DirectSubscription>();
	private client?: NeonLiveClient;
	private clientPromise?: Promise<NeonLiveClient>;
	private closed = false;

	constructor(
		private readonly url: string,
		private readonly parsers: PostgreSQLParsers | undefined,
		private readonly logLevel: NeonLiveLogLevel | undefined,
		private readonly logger: NeonLiveLogger | undefined,
	) {
		if (!url) throw new Error("Neon Live requires a WebSocket URL");
	}

	assertOpen(): void {
		if (this.closed) throw new Error("Neon Live direct client is closed");
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

	private getClient(): Promise<NeonLiveClient> {
		this.assertOpen();
		this.clientPromise ??= import("../client/neon-live-client.js").then(
			(module) => {
				this.assertOpen();
				const client = module.createNeonLiveClient({
					url: this.url,
					parsers: this.parsers,
					logLevel: this.logLevel,
					logger: this.logger,
				});
				this.client = client;
				return client;
			},
		);
		return this.clientPromise;
	}
}

function subscribeClient<Row>(
	client: NeonLiveClient,
	query: SealedLiveQuery<Row>,
	options?: MaterializedLiveQueryOptions<Row> | RawLiveQueryOptions,
): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
	if (options?.materialize === false) {
		return client.subscribe(query, options);
	}
	return client.subscribe(query, options);
}
