import type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQueryState,
	MaterializedLiveQueryOptions,
	MaterializedLiveQuerySubscription,
	RawLiveQueryOptions,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
	RealtimeClient,
	RealtimeLogEntry,
	SealedLiveQuery,
} from "@neon/realtime/client";
import { createRealtimeClient } from "@neon/realtime/client";
import { collectionOptions, createCollection, DbClient } from "@tanstack/db";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type RealtimeCollectionUtils,
	realtimeCollectionOptions,
} from "./index.js";

interface MessageRow {
	readonly id: number;
	readonly title: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Realtime TanStack DB collection", () => {
	it("confirms real-client no-op progress after queuing preceding authoritative changes", async () => {
		const wire = wireClient();
		let startMutation!: () => void;
		const mutationStarted = new Promise<void>((resolve) => {
			startMutation = resolve;
		});
		const collection = createCollection(
			realtimeCollectionOptions({
				id: "progress-messages",
				client: wire.client,
				query: query("progress"),
				getKey: (message) => message.id,
				onUpdate: async ({ collection: current }) => {
					startMutation();
					await current.utils.awaitTxId("44");
				},
			}),
		);
		cleanups.push(async () => {
			await collection.cleanup();
			wire.client.close();
		});
		const preload = collection.preload();
		wire.baseline();
		await preload;
		const changes = vi.fn();
		const listener = collection.subscribeChanges(changes, {
			includeInitialState: false,
		});

		const noOp = collection.utils.awaitTxId("42");
		wire.receive({
			type: "progress",
			mvcc: { xmin: "43", xmax: "43", xip: [] },
		});
		await expect(noOp).resolves.toBe(true);
		await expect(collection.utils.awaitTxId("41")).resolves.toBe(true);
		expect(changes).not.toHaveBeenCalled();
		expect(collection.get(1)).toMatchObject({ title: "before" });

		const mutation = collection.update(1, (draft) => {
			draft.title = "optimistic";
		});
		await mutationStarted;
		expect(collection.get(1)).toMatchObject({ title: "optimistic" });
		wire.receive({ type: "open", publication_id: "change" });
		wire.receive({
			type: "keyed_results",
			publication_id: "change",
			index: 0,
			txids: ["43"],
			targets: [{ live_id: "1", epoch: "1", sequence: "1" }],
			changes: [
				{
					op: "upsert",
					row_key: "a".repeat(64),
					values: ["1", "authoritative"],
				},
			],
		});
		wire.receive({
			type: "commit",
			publication_id: "change",
			body_count: 1,
			frontier: { lsn: "0/10" },
		});
		wire.receive({
			type: "progress",
			mvcc: { xmin: "45", xmax: "45", xip: [] },
		});
		await mutation.isPersisted.promise;
		await eventually(() =>
			expect(collection.get(1)).toMatchObject({ title: "authoritative" }),
		);

		const cancelled = expect(
			collection.utils.awaitTxId("100"),
		).rejects.toThrow("cleaned up");
		listener.unsubscribe();
		await collection.cleanup();
		await cancelled;
	});

	it("installs resets and transactions as authoritative collection state", async () => {
		const client = new TestClient<MessageRow>();
		const collection = createTestCollection(client);
		expectTypeOf(collection.utils).toEqualTypeOf<RealtimeCollectionUtils>();
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
			realtimeCollectionOptions({
				id: "mutable-messages",
				client,
				query: query("query-1"),
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

	it("keeps a ready collection ready while Realtime is stale", async () => {
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
		const failure = liveError("ACCESS_DENIED");

		client.latest().state({ status: "error", error: failure });

		expect(collection.status).toBe("error");
		expect(collection._lifecycle.getSyncError()).toBe(failure);
	});

	it("renews expiring query without changing the collection API", async () => {
		const client = new TestClient<MessageRow>();
		const replacement = query("query-2", 3_000);
		const refreshQuery = vi.fn(async () => replacement);
		const collection = createTestCollection(
			client,
			query("query-1", 9),
			refreshQuery,
		);
		void collection.preload();

		await eventually(() => expect(refreshQuery).toHaveBeenCalledOnce());

		expect(client.latest().renewals).toEqual([replacement]);
	});

	it("uses the subscription diagnostic context for query refreshes", async () => {
		vi.stubGlobal("WebSocket", SilentWebSocket);
		const entries: RealtimeLogEntry[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => entries.push(entry),
		});
		const collection = createCollection(
			realtimeCollectionOptions({
				id: "diagnostic-messages",
				client,
				query: query("query-1", 9),
				refreshQuery: async () => query("query-2"),
				getKey: (message) => message.id,
			}),
		);
		cleanups.push(async () => {
			await collection.cleanup();
			client.close();
		});
		void collection.preload();

		await eventually(() =>
			expect(
				entries.some(
					(entry) =>
						entry.event === "query_refresh_callback_succeeded",
				),
			).toBe(true),
		);
		const started = entries.find(
			(entry) => entry.event === "subscription_started",
		);
		if (started?.event !== "subscription_started") {
			throw new Error("Missing subscription diagnostics");
		}
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "query_refresh_scheduled",
					subscriptionId: started.subscriptionId,
				}),
				expect.objectContaining({
					event: "query_refresh_callback_started",
					subscriptionId: started.subscriptionId,
				}),
				expect.objectContaining({
					event: "query_refresh_callback_succeeded",
					subscriptionId: started.subscriptionId,
				}),
			]),
		);
	});

	it("hydrates provisional rows and replaces them with the first reset", async () => {
		const client = new TestClient<MessageRow>();
		const descriptor = collectionOptions(
			realtimeCollectionOptions({
				id: "hydrated-messages",
				client,
				query: query("query-1"),
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
			"Timed out waiting for live-query transaction 9",
		);
		const pending = collection.utils.awaitTxId("10", 10_000);
		await collection.cleanup();
		await expect(pending).rejects.toThrow("cleaned up");
		expect(client.latest().unsubscribed).toBe(true);
	});
});

function createTestCollection(
	client: TestClient<MessageRow>,
	currentQuery = query("query-1"),
	refreshQuery?: () => Promise<SealedLiveQuery<MessageRow>>,
) {
	const collection = createCollection(
		realtimeCollectionOptions({
			id: "messages",
			client,
			query: currentQuery,
			refreshQuery,
			getKey: (message) => message.id,
		}),
	);
	cleanups.push(() => collection.cleanup());
	return collection;
}

/** Fake transport only: subscriptions, decoding, and reconciliation are real. */
function wireClient() {
	const listeners = new Map<
		string,
		(event: { readonly data: unknown }) => void
	>();
	class FakeWebSocket {
		readyState = 1;
		addEventListener(
			type: string,
			listener: (event: { readonly data: unknown }) => void,
		) {
			listeners.set(type, listener);
		}
		send = vi.fn();
		close() {
			this.readyState = 3;
		}
	}
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const client = createRealtimeClient({
		url: "ws://live.test",
	});
	const receive = (message: object) => {
		listeners.get("message")?.({ data: JSON.stringify(message) });
	};
	return {
		client,
		receive,
		baseline: () => {
			receive({ type: "ready" });
			receive({
				type: "subscribed",
				request_id: "1",
				live_id: "1",
				epoch: "1",
				first_sequence: "1",
				columns: [
					{ name: "id", type_oid: 23, typmod: -1, codec: "pg_text" },
					{
						name: "title",
						type_oid: 25,
						typmod: -1,
						codec: "pg_text",
					},
				],
			});
			const target = {
				live_id: "1",
				epoch: "1",
				baseline_sync_attempt: "1",
			};
			receive({
				type: "baseline_sync_start",
				...target,
				mvcc: { xmin: "1", xmax: "2", xip: [] },
			});
			receive({
				type: "baseline_sync_batch",
				...target,
				index: 0,
				rows: [{ row_key: "a".repeat(64), values: ["1", "before"] }],
			});
			receive({ type: "baseline_sync_end", ...target, batch_count: 1 });
		},
	};
}

class TestClient<Row extends object> implements RealtimeClient {
	readonly subscriptions: TestRawSubscription<Row>[] = [];

	subscribe<CurrentRow>(
		_query: SealedLiveQuery<CurrentRow>,
		_options?: MaterializedLiveQueryOptions<CurrentRow>,
	): MaterializedLiveQuerySubscription<CurrentRow>;
	subscribe<CurrentRow>(
		_query: SealedLiveQuery<CurrentRow>,
		_options: RawLiveQueryOptions,
	): RawLiveQuerySubscription<CurrentRow>;
	subscribe<CurrentRow>(
		_query: SealedLiveQuery<CurrentRow>,
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
	readonly renewals: SealedLiveQuery<Row>[] = [];
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
										`Timed out waiting for live-query transaction ${txid}`,
									),
								);
							}, timeout),
			};
			const waiters = this.txWaiters.get(txid) ?? new Set();
			waiters.add(waiter);
			this.txWaiters.set(txid, waiters);
		});
	};

	renew = async (query: SealedLiveQuery<Row>): Promise<void> => {
		this.renewals.push(query);
		this.state({ status: "stale", error: undefined });
	};

	unsubscribe = (): void => {
		this.unsubscribed = true;
		this.currentState = { status: "closed", error: undefined };
		for (const waiters of this.txWaiters.values()) {
			for (const waiter of waiters) {
				if (waiter.timer !== undefined) clearTimeout(waiter.timer);
				waiter.reject(new Error("Live-query subscription is closed"));
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

class SilentWebSocket {
	readyState = 0;

	addEventListener(): void {}

	send(): void {}

	close(): void {
		this.readyState = 3;
	}
}

function query(
	queryId: string,
	secondsFromNow = 3_000,
): SealedLiveQuery<MessageRow> {
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
			v: 1,
		}),
	).toString("base64url");
	return `${header}..a.${Buffer.from(payload).toString("base64url")}.c`;
}

function liveError(code: string) {
	return Object.assign(new Error(`Realtime error: ${code}`), {
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
