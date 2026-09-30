import type {
	LiveQueryAuthorization,
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQueryState,
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
	RawLiveQueryOptions,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
} from "@neon/live/client";
import { collectionOptions, createCollection, DbClient } from "@tanstack/db";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type NeonLiveCollectionUtils,
	neonLiveCollectionOptions,
} from "./index.js";

interface MessageRow {
	readonly id: number;
	readonly title: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

describe("Neon Live TanStack DB collection", () => {
	it("installs resets and transactions as authoritative collection state", async () => {
		const client = new TestClient<MessageRow>();
		const collection = createTestCollection(client);
		expectTypeOf(collection.utils).toEqualTypeOf<NeonLiveCollectionUtils>();
		const preload = collection.preload();
		expect(collection.status).toBe("loading");

		client.latest().reset([
			{ rowId: "a", row: { id: 1, title: "one" } },
			{ rowId: "b", row: { id: 2, title: "two" } },
		]);
		await preload;

		expect(collection.status).toBe("ready");
		expect(collection.get(1)).toMatchObject({ id: 1, title: "one" });
		expect(collection.get(2)).toMatchObject({ id: 2, title: "two" });

		const matched = collection.utils.awaitTxId("42");
		expect(client.latest().awaitedTransactions).toEqual([
			{ txid: "42", timeout: undefined },
		]);
		client.latest().batch(
			[
				{
					type: "upsert",
					rowId: "a",
					row: { id: 1, title: "updated" },
				},
				{ type: "remove", rowId: "b" },
				{ type: "upsert", rowId: "c", row: { id: 3, title: "three" } },
			],
			["42"],
		);

		await expect(matched).resolves.toBe(true);
		await eventually(() => {
			expect(collection.get(1)).toMatchObject({
				id: 1,
				title: "updated",
			});
			expect(collection.has(2)).toBe(false);
			expect(collection.get(3)).toMatchObject({ id: 3, title: "three" });
		});
	});

	it("remembers transactions that arrive before awaitTxId", async () => {
		const client = new TestClient<MessageRow>();
		const collection = createTestCollection(client);
		const preload = collection.preload();
		client.latest().reset([{ rowId: "a", row: { id: 1, title: "one" } }]);
		await preload;

		client
			.latest()
			.batch(
				[{ type: "upsert", rowId: "a", row: { id: 1, title: "two" } }],
				["18446744073709551614"],
			);

		await expect(
			collection.utils.awaitTxId("18446744073709551614"),
		).resolves.toBe(true);
	});

	it("lets mutation handlers explicitly await their streamed transaction", async () => {
		const client = new TestClient<MessageRow>();
		let handlerStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			handlerStarted = resolve;
		});
		const collection = createCollection(
			neonLiveCollectionOptions({
				id: "mutable-messages",
				client,
				authorization: authorization("query-1"),
				getKey: (message) => message.id,
				onUpdate: async ({ collection: currentCollection }) => {
					handlerStarted();
					await currentCollection.utils.awaitTxId("77");
				},
			}),
		);
		cleanups.push(() => collection.cleanup());
		const preload = collection.preload();
		client.latest().reset([{ rowId: "a", row: { id: 1, title: "one" } }]);
		await preload;

		const mutation = collection.update(1, (draft) => {
			draft.title = "optimistic";
		});
		await started;
		client.latest().batch(
			[
				{
					type: "upsert",
					rowId: "a",
					row: { id: 1, title: "authoritative" },
				},
			],
			["77"],
		);

		await mutation.isPersisted.promise;
		await eventually(() => {
			expect(collection.get(1)).toMatchObject({ title: "authoritative" });
		});
	});

	it("keeps a ready collection ready while Neon Live is stale", async () => {
		const client = new TestClient<MessageRow>();
		const collection = createTestCollection(client);
		const preload = collection.preload();
		client.latest().reset([{ rowId: "a", row: { id: 1, title: "one" } }]);
		await preload;

		client.latest().state({ status: "stale", error: undefined });

		expect(collection.status).toBe("ready");
		expect(collection.get(1)).toMatchObject({ title: "one" });
	});

	it("maps Neon errors and unexpected closure to collection errors", async () => {
		const client = new TestClient<MessageRow>();
		const collection = createTestCollection(client);
		void collection.preload();
		const failure = liveError("NOT_AUTHORIZED");

		client.latest().state({ status: "error", error: failure });

		expect(collection.status).toBe("error");
		expect(collection._lifecycle.getSyncError()).toBe(failure);
	});

	it("renews expiring authorization without changing the collection API", async () => {
		const client = new TestClient<MessageRow>();
		const replacement = authorization("query-2", 3_000);
		const refreshAuthorization = vi.fn(async () => replacement);
		const collection = createTestCollection(
			client,
			authorization("query-1", 9),
			refreshAuthorization,
		);
		void collection.preload();

		await eventually(() =>
			expect(refreshAuthorization).toHaveBeenCalledOnce(),
		);

		expect(client.latest().renewals).toEqual([replacement]);
	});

	it("hydrates provisional rows and replaces them with the first reset", async () => {
		const client = new TestClient<MessageRow>();
		const descriptor = collectionOptions(
			neonLiveCollectionOptions({
				id: "hydrated-messages",
				client,
				authorization: authorization("query-1"),
				getKey: (message) => message.id,
			}),
		);
		const serverDb = new DbClient();
		const serverCollection = serverDb.collection(descriptor, {
			initialData: [{ id: 1, title: "server" }],
		});
		const state = serverDb.dehydrate();
		const browserDb = new DbClient();
		browserDb.hydrate(state);
		const browserCollection = browserDb.collection(descriptor);
		cleanups.push(() => serverCollection.cleanup());
		cleanups.push(() => browserCollection.cleanup());

		expect(browserCollection.get(1)).toMatchObject({ title: "server" });
		expect(client.subscriptions).toHaveLength(0);

		const preload = browserCollection.preload();
		client.latest().reset([
			{ rowId: "a", row: { id: 1, title: "authoritative" } },
			{ rowId: "b", row: { id: 2, title: "new" } },
		]);
		await preload;

		expect(browserCollection.get(1)).toMatchObject({
			title: "authoritative",
		});
		expect(browserCollection.get(2)).toMatchObject({ title: "new" });
		expect(browserCollection.status).toBe("ready");
	});

	it("times out unmatched transactions and rejects waiters on cleanup", async () => {
		const client = new TestClient<MessageRow>();
		const collection = createTestCollection(client);
		void collection.preload();

		await expect(collection.utils.awaitTxId("9", 1)).rejects.toThrow(
			"Timed out waiting for Neon Live transaction 9",
		);
		const pending = collection.utils.awaitTxId("10", 10_000);
		await collection.cleanup();
		await expect(pending).rejects.toThrow("cleaned up");
		expect(client.latest().unsubscribed).toBe(true);
	});
});

function createTestCollection(
	client: TestClient<MessageRow>,
	currentAuthorization = authorization("query-1"),
	refreshAuthorization?: () => Promise<LiveQueryAuthorization<MessageRow>>,
) {
	const collection = createCollection(
		neonLiveCollectionOptions({
			id: "messages",
			client,
			authorization: currentAuthorization,
			refreshAuthorization,
			getKey: (message) => message.id,
		}),
	);
	cleanups.push(() => collection.cleanup());
	return collection;
}

class TestClient<Row extends object> implements NeonLiveClient {
	readonly subscriptions: TestRawSubscription<Row>[] = [];

	subscribe<CurrentRow>(
		_authorization: LiveQueryAuthorization<CurrentRow>,
		_options?: MaterializedLiveQueryOptions<CurrentRow>,
	): MaterializedLiveQuerySubscription<CurrentRow>;
	subscribe<CurrentRow>(
		_authorization: LiveQueryAuthorization<CurrentRow>,
		_options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<CurrentRow>;
	subscribe<CurrentRow>(
		_authorization: LiveQueryAuthorization<CurrentRow>,
		options?:
			| MaterializedLiveQueryOptions<CurrentRow>
			| RawLiveQueryOptions,
	):
		| MaterializedLiveQuerySubscription<CurrentRow>
		| RawLiveQuerySubscription<CurrentRow> {
		if (options?.materialize !== false) {
			throw new Error("Test client expects a raw subscription");
		}
		const subscription = new TestRawSubscription<CurrentRow>();
		this.subscriptions.push(
			subscription as unknown as TestRawSubscription<Row>,
		);
		return subscription;
	}

	latest(): TestRawSubscription<Row> {
		const subscription = this.subscriptions.at(-1);
		if (!subscription) throw new Error("Expected a subscription");
		return subscription;
	}

	close(): void {}
}

class TestRawSubscription<Row> implements RawLiveQuerySubscription<Row> {
	private readonly appliedTxids = new Set<string>();
	private readonly txWaiters = new Map<
		string,
		Set<{
			resolve: () => void;
			reject: (error: Error) => void;
			timer?: ReturnType<typeof setTimeout>;
		}>
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
	readonly renewals: LiveQueryAuthorization<Row>[] = [];
	readonly awaitedTransactions: Array<{
		readonly txid: string;
		readonly timeout: number | undefined;
	}> = [];
	unsubscribed = false;
	private currentState: LiveQueryState = {
		status: "connecting",
		error: undefined,
	};

	getState = (): LiveQueryState => this.currentState;

	onReset = (
		listener: (rows: readonly RawLiveQueryRow<Row>[]) => void,
	): (() => void) => add(this.resetListeners, listener);

	onBatch = (
		listener: (
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void,
	): (() => void) => add(this.batchListeners, listener);

	onStateChange = (listener: (state: LiveQueryState) => void): (() => void) =>
		add(this.stateListeners, listener);

	awaitTxId = async (txid: string, timeout?: number): Promise<void> => {
		this.awaitedTransactions.push({ txid, timeout });
		if (this.appliedTxids.has(txid)) return;
		return new Promise<void>((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timer:
					timeout === undefined
						? undefined
						: setTimeout(() => {
								this.txWaiters.get(txid)?.delete(waiter);
								reject(
									new Error(
										`Timed out waiting for Neon Live transaction ${txid}`,
									),
								);
							}, timeout),
			};
			const waiters = this.txWaiters.get(txid) ?? new Set();
			waiters.add(waiter);
			this.txWaiters.set(txid, waiters);
		});
	};

	renew = async (
		authorization: LiveQueryAuthorization<Row>,
	): Promise<void> => {
		this.renewals.push(authorization);
		this.state({ status: "stale", error: undefined });
	};

	unsubscribe = (): void => {
		this.unsubscribed = true;
		this.currentState = { status: "closed", error: undefined };
		for (const waiters of this.txWaiters.values()) {
			for (const waiter of waiters) {
				if (waiter.timer !== undefined) clearTimeout(waiter.timer);
				waiter.reject(new Error("Neon Live subscription is closed"));
			}
		}
		this.txWaiters.clear();
	};

	reset(rows: readonly RawLiveQueryRow<Row>[]): void {
		this.currentState = { status: "live", error: undefined };
		for (const listener of this.stateListeners) listener(this.currentState);
		for (const listener of this.resetListeners) listener(rows);
	}

	batch(
		changes: readonly LiveQueryChange<Row>[],
		txids: readonly string[],
	): void {
		for (const listener of this.batchListeners) {
			listener(changes, { txids });
		}
		for (const txid of txids) {
			this.appliedTxids.add(txid);
			for (const waiter of this.txWaiters.get(txid) ?? []) {
				if (waiter.timer !== undefined) clearTimeout(waiter.timer);
				waiter.resolve();
			}
			this.txWaiters.delete(txid);
		}
	}

	state(state: LiveQueryState): void {
		this.currentState = state;
		for (const listener of this.stateListeners) listener(state);
	}
}

function authorization(
	queryId: string,
	secondsFromNow = 3_000,
): LiveQueryAuthorization<MessageRow> {
	return {
		capability: compactJwe(queryId),
		queryFingerprint: "11".repeat(32),
		expiresAt: Date.now() + secondsFromNow * 1_000,
	};
}

function compactJwe(payload: string): string {
	const header = Buffer.from(
		JSON.stringify({
			alg: "dir",
			enc: "A256GCM",
			kid: "current",
			v: 1,
		}),
	).toString("base64url");
	return `${header}..a.${Buffer.from(payload).toString("base64url")}.c`;
}

function liveError(code: string) {
	return Object.assign(new Error(`Neon Live error: ${code}`), {
		code,
		retryable: false,
	});
}

function add<Listener>(
	listeners: Set<Listener>,
	listener: Listener,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

async function eventually(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw lastError;
}
