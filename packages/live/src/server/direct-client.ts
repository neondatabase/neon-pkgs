import type { LiveQueryAuthorization } from "../client/authorization.js";
import type { PostgreSQLParsers } from "../client/postgres/parsers.js";
import type {
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
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
	) {
		if (!url) throw new Error("Neon Live requires a WebSocket URL");
	}

	assertOpen(): void {
		if (this.closed) throw new Error("Neon Live direct client is closed");
	}

	async subscribe<Row>(
		authorization: LiveQueryAuthorization<Row>,
		options:
			| MaterializedLiveQueryOptions<Row>
			| RawLiveQueryOptions
			| undefined,
		refreshAuthorization: () => Promise<LiveQueryAuthorization<Row>>,
	): Promise<
		MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row>
	> {
		this.assertOpen();
		const client = await this.getClient();
		const subscription = subscribeClient(client, authorization, options);
		let managed!: ManagedDirectSubscription<typeof subscription>;
		managed = manageDirectSubscription(
			subscription,
			authorization,
			refreshAuthorization,
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
	authorization: LiveQueryAuthorization<Row>,
	options?: MaterializedLiveQueryOptions<Row> | RawLiveQueryOptions,
): MaterializedLiveQuerySubscription<Row> | RawLiveQuerySubscription<Row> {
	if (options?.materialize === false) {
		return client.subscribe(authorization, options);
	}
	return client.subscribe(authorization, options);
}
