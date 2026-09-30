// @vitest-environment jsdom

import type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
	SealedLiveQuery,
} from "@neon/live/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	NeonLiveProvider,
	type UseLiveQueryResult,
	useLiveQuery,
} from "./index.js";

interface MessageRow {
	readonly id: number;
	readonly title: string;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Neon Live React integration", () => {
	it("renders preloaded data and exposes materialized subscription utilities", async () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		render(
			<NeonLiveProvider client={client}>
				<Messages
					query={query("query-1")}
					initialData={[{ id: 1, title: "server" }]}
					observe={(result) => {
						observed = result;
					}}
				/>
			</NeonLiveProvider>,
		);

		expect(screen.getByText("stale:server")).toBeTruthy();
		expectTypeOf(observed).toEqualTypeOf<
			UseLiveQueryResult<MessageRow> | undefined
		>();
		expect(observed?.utils).not.toHaveProperty("unsubscribe");
		await expect(observed?.utils.awaitTxId("42")).resolves.toBeUndefined();
		expect(client.latest().awaitTxId).toHaveBeenCalledWith("42", undefined);

		act(() => {
			client.latest().publish({
				status: "live",
				error: undefined,
				data: [{ id: 1, title: "stream" }],
			});
		});
		expect(screen.getByText("live:stream")).toBeTruthy();
	});

	it("replaces subscriptions when query identity changes", () => {
		const client = new TestClient<MessageRow>();
		const first = query("query-1");
		const view = render(
			<NeonLiveProvider client={client}>
				<Messages query={first} />
			</NeonLiveProvider>,
		);
		const firstSubscription = client.latest();
		act(() => {
			firstSubscription.publish({
				status: "live",
				error: undefined,
				data: [{ id: 1, title: "first" }],
			});
		});
		expect(screen.getByText("live:first")).toBeTruthy();

		view.rerender(
			<NeonLiveProvider client={client}>
				<Messages query={query("query-2")} />
			</NeonLiveProvider>,
		);

		expect(firstSubscription.unsubscribed).toBe(true);
		expect(client.subscriptions).toHaveLength(2);
		expect(screen.getByText("connecting:none")).toBeTruthy();
	});

	it("does not restart when only the refresh callback changes", () => {
		const client = new TestClient<MessageRow>();
		const currentQuery = query("query-1", 3_000);
		const view = render(
			<NeonLiveProvider client={client}>
				<Messages
					query={currentQuery}
					refreshQuery={async () => query("refresh-1")}
				/>
			</NeonLiveProvider>,
		);

		view.rerender(
			<NeonLiveProvider client={client}>
				<Messages
					query={currentQuery}
					refreshQuery={async () => query("refresh-2")}
				/>
			</NeonLiveProvider>,
		);

		expect(client.subscriptions).toHaveLength(1);
	});

	it("refreshes an expiring query through renew", async () => {
		const client = new TestClient<MessageRow>();
		const replacement = query("query-2", 3_000);
		const refreshQuery = vi.fn(async () => replacement);
		render(
			<NeonLiveProvider client={client}>
				<Messages
					query={query("query-1", 9)}
					refreshQuery={refreshQuery}
				/>
			</NeonLiveProvider>,
		);

		await act(async () => {
			await eventually(() => expect(refreshQuery).toHaveBeenCalledOnce());
		});
		expect(client.latest().renewals).toEqual([replacement]);
		expect(screen.getByText("stale:none")).toBeTruthy();
	});

	it("owns subscription cleanup", () => {
		const client = new TestClient<MessageRow>();
		const view = render(
			<NeonLiveProvider client={client}>
				<Messages query={query("query-1")} />
			</NeonLiveProvider>,
		);
		const subscription = client.latest();
		view.unmount();
		expect(subscription.unsubscribed).toBe(true);
	});

	it("renders preloaded server snapshots without opening a subscription", () => {
		const client = new TestClient<MessageRow>();
		const html = renderToString(
			<NeonLiveProvider client={client}>
				<Messages
					query={query("query-1")}
					initialData={[{ id: 1, title: "server" }]}
				/>
			</NeonLiveProvider>,
		);

		expect(html).toContain("stale");
		expect(html).toContain("server");
		expect(client.subscriptions).toHaveLength(0);
	});
});

function Messages({
	query: currentQuery,
	initialData,
	refreshQuery,
	observe,
}: {
	query: SealedLiveQuery<MessageRow>;
	initialData?: readonly MessageRow[];
	refreshQuery?: () => Promise<SealedLiveQuery<MessageRow>>;
	observe?: (result: UseLiveQueryResult<MessageRow>) => void;
}) {
	const result = useLiveQuery(currentQuery, {
		initialData,
		refreshQuery,
	});
	observe?.(result);
	return (
		<span>
			{result.status}:{result.data?.[0]?.title ?? "none"}
		</span>
	);
}

class TestClient<Row> implements NeonLiveClient {
	readonly subscriptions: TestSubscription<Row>[] = [];

	subscribe<CurrentRow>(
		_query: SealedLiveQuery<CurrentRow>,
		options?: { materialize?: true; initialData?: readonly CurrentRow[] },
	): MaterializedLiveQuerySubscription<CurrentRow>;
	subscribe<CurrentRow>(
		_query: SealedLiveQuery<CurrentRow>,
		_options: { materialize: false },
	): RawLiveQuerySubscription<CurrentRow>;
	subscribe<CurrentRow>(
		_query: SealedLiveQuery<CurrentRow>,
		options?: {
			materialize?: boolean;
			initialData?: readonly CurrentRow[];
		},
	):
		| MaterializedLiveQuerySubscription<CurrentRow>
		| RawLiveQuerySubscription<CurrentRow> {
		if (options?.materialize === false) {
			throw new Error(
				"Test client only supports materialized subscriptions",
			);
		}
		const subscription = new TestSubscription(options?.initialData);
		this.subscriptions.push(
			subscription as unknown as TestSubscription<Row>,
		);
		return subscription;
	}

	latest(): TestSubscription<Row> {
		const subscription = this.subscriptions.at(-1);
		if (!subscription) throw new Error("Expected a subscription");
		return subscription;
	}

	close(): void {}
}

class TestSubscription<Row> implements MaterializedLiveQuerySubscription<Row> {
	private snapshotListeners = new Set<
		(snapshot: LiveQuerySnapshot<Row>) => void
	>();
	private stateListeners = new Set<(state: LiveQueryState) => void>();
	private resetListeners = new Set<
		(rows: readonly RawLiveQueryRow<Row>[]) => void
	>();
	private batchListeners = new Set<
		(
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void
	>();
	readonly renewals: SealedLiveQuery<Row>[] = [];
	unsubscribed = false;
	private snapshot: LiveQuerySnapshot<Row>;

	constructor(initialData?: readonly Row[]) {
		this.snapshot = {
			status: initialData === undefined ? "connecting" : "stale",
			error: undefined,
			data: initialData,
		};
	}

	getState = (): LiveQueryState => {
		const { status, error } = this.snapshot;
		return status === "error"
			? { status, error }
			: { status, error: undefined };
	};

	getSnapshot = (): LiveQuerySnapshot<Row> => this.snapshot;

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

	awaitTxId = vi.fn(
		async (_txid: string, _timeout?: number): Promise<void> =>
			Promise.resolve(),
	);

	onChange = (
		listener: (snapshot: LiveQuerySnapshot<Row>) => void,
	): (() => void) => add(this.snapshotListeners, listener);

	renew = async (query: SealedLiveQuery<Row>): Promise<void> => {
		this.renewals.push(query);
		this.publish({ ...this.snapshot, status: "stale", error: undefined });
	};

	unsubscribe = (): void => {
		this.unsubscribed = true;
	};

	publish(snapshot: LiveQuerySnapshot<Row>): void {
		this.snapshot = snapshot;
		for (const listener of this.stateListeners) listener(this.getState());
		for (const listener of this.snapshotListeners) listener(snapshot);
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
			kid: "current",
			v: 1,
		}),
	).toString("base64url");
	return `${header}..a.${Buffer.from(payload).toString("base64url")}.c`;
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
