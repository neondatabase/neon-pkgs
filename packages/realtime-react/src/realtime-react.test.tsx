// @vitest-environment jsdom

import type {
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQuerySubscription,
	RawLiveQueryUpdate,
	RealtimeClient,
	RealtimeLogEntry,
	SealedLiveQuery,
} from "@neon/realtime/client";
import { createRealtimeClient } from "@neon/realtime/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	RealtimeProvider,
	type UseLiveQueryResult,
	useLiveQuery,
	useRealtimeClient,
} from "./index.js";

interface MessageRow {
	readonly id: number;
	readonly title: string;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Realtime React integration", () => {
	it("preserves the server sequence through the real materialized client", () => {
		const wire = wireClient();
		const results: UseLiveQueryResult<MessageRow>[] = [];
		try {
			render(
				<RealtimeProvider client={wire.client}>
					<Messages
						query={query("ordered")}
						observe={(result) => results.push(result)}
					/>
				</RealtimeProvider>,
			);
			act(() =>
				wire.baseline(
					["a", "b", "c", "d"].map((id, index) => ({
						row_key: id.repeat(64),
						values: [String(index + 1), id],
					})),
				),
			);
			act(() => {
				wire.receive({ type: "open", publication_id: "rotation" });
				wire.receive({
					type: "keyed_results",
					publication_id: "rotation",
					index: 0,
					txids: ["42"],
					targets: [{ live_id: "1", epoch: "1", sequence: "1" }],
					changes: [
						{
							op: "move",
							row_key: "c".repeat(64),
							after_row_key: null,
						},
						{
							op: "move",
							row_key: "d".repeat(64),
							after_row_key: "c".repeat(64),
						},
					],
				});
			});
			expect(screen.getByText("live:a")).toBeTruthy();
			act(() =>
				wire.receive({
					type: "commit",
					publication_id: "rotation",
					body_count: 1,
					frontier: { lsn: "0/10" },
				}),
			);
			expect(screen.getByText("live:c")).toBeTruthy();
			expect(results.at(-1)?.data?.map((row) => row.title)).toEqual([
				"c",
				"d",
				"a",
				"b",
			]);
		} finally {
			wire.client.close();
		}
	});

	it("confirms no-op progress through the real client without notifying row listeners", async () => {
		const wire = wireClient();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		const observe = vi.fn((result: UseLiveQueryResult<MessageRow>) => {
			observed = result;
		});
		try {
			const view = render(
				<RealtimeProvider client={wire.client}>
					<Messages query={query("progress")} observe={observe} />
				</RealtimeProvider>,
			);
			act(() => wire.baseline());
			if (!observed)
				throw new Error("Expected the live query hook to render");
			const { utils } = observed;
			const onUpdate = vi.fn();
			const onChange = vi.fn();
			utils.onUpdate(onUpdate);
			utils.onChange(onChange);
			observe.mockClear();
			const pending = utils.awaitTxId("42");
			await act(async () => {
				wire.receive({
					type: "progress",
					mvcc: { xmin: "43", xmax: "43", xip: [] },
				});
				await pending;
			});
			await expect(utils.awaitTxId("41")).resolves.toBeUndefined();
			expect(onUpdate).not.toHaveBeenCalled();
			expect(onChange).not.toHaveBeenCalled();
			expect(observe).not.toHaveBeenCalled();
			expect(screen.getByText("live:before")).toBeTruthy();

			const followingNoOp = utils.awaitTxId("44").then(() => {
				expect(utils.getSnapshot().data).toEqual([
					{ id: 1, title: "after" },
				]);
			});
			await act(async () => {
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
							values: ["1", "after"],
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
				await followingNoOp;
			});
			expect(screen.getByText("live:after")).toBeTruthy();
			expect(onUpdate).toHaveBeenCalledOnce();
			expect(onChange).toHaveBeenCalledOnce();

			const cancelled = expect(utils.awaitTxId("100")).rejects.toThrow(
				"subscription is closed",
			);
			view.unmount();
			await cancelled;
		} finally {
			act(() => wire.client.close());
		}
	});

	it("renders preloaded data and exposes materialized subscription utilities", async () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		render(
			<RealtimeProvider client={client}>
				<Messages
					query={query("query-1")}
					initialData={[{ id: 1, title: "server" }]}
					observe={(result) => {
						observed = result;
					}}
				/>
			</RealtimeProvider>,
		);

		expect(screen.getByText("connecting:server")).toBeTruthy();
		expectTypeOf(observed).toEqualTypeOf<
			UseLiveQueryResult<MessageRow> | undefined
		>();
		expect(observed?.utils).not.toHaveProperty("unsubscribe");
		await expect(observed?.utils.awaitTxId("42")).resolves.toBeUndefined();
		expect(client.latest().awaitTxId).toHaveBeenCalledWith("42", undefined);
		const matches = (rows: readonly MessageRow[]) => rows.length > 0;
		await expect(
			observed?.utils.awaitRows(matches),
		).resolves.toBeUndefined();
		expect(client.latest().awaitRows).toHaveBeenCalledWith(
			matches,
			undefined,
		);

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
			<RealtimeProvider client={client}>
				<Messages query={first} />
			</RealtimeProvider>,
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
			<RealtimeProvider client={client}>
				<Messages query={query("query-2")} />
			</RealtimeProvider>,
		);

		expect(firstSubscription.unsubscribed).toBe(true);
		expect(client.subscriptions).toHaveLength(2);
		expect(screen.getByText("connecting:none")).toBeTruthy();
	});

	it("does not restart when only the refresh callback changes", () => {
		const client = new TestClient<MessageRow>();
		const currentQuery = query("query-1", 3_000);
		const view = render(
			<RealtimeProvider client={client}>
				<Messages
					query={currentQuery}
					refreshQuery={async () => query("refresh-1")}
				/>
			</RealtimeProvider>,
		);

		view.rerender(
			<RealtimeProvider client={client}>
				<Messages
					query={currentQuery}
					refreshQuery={async () => query("refresh-2")}
				/>
			</RealtimeProvider>,
		);

		expect(client.subscriptions).toHaveLength(1);
	});

	it("refreshes an expiring query through renew", async () => {
		const client = new TestClient<MessageRow>();
		const replacement = query("query-2", 3_000);
		const refreshQuery = vi.fn(async () => replacement);
		render(
			<RealtimeProvider client={client}>
				<Messages
					query={query("query-1", 9)}
					refreshQuery={refreshQuery}
				/>
			</RealtimeProvider>,
		);

		await act(async () => {
			await eventually(() => expect(refreshQuery).toHaveBeenCalledOnce());
		});
		expect(client.latest().renewals).toEqual([replacement]);
		expect(screen.getByText("connecting:none")).toBeTruthy();
	});

	it("uses the subscription diagnostic context for query refreshes", async () => {
		vi.stubGlobal("WebSocket", SilentWebSocket);
		const entries: RealtimeLogEntry[] = [];
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			logLevel: "debug",
			logger: (entry) => entries.push(entry),
		});
		const view = render(
			<RealtimeProvider client={client}>
				<Messages
					query={query("query-1", 9)}
					refreshQuery={async () => query("query-2")}
				/>
			</RealtimeProvider>,
		);

		await act(async () => {
			await eventually(() =>
				expect(
					entries.some(
						(entry) =>
							entry.event === "query_refresh_callback_succeeded",
					),
				).toBe(true),
			);
		});
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

		view.unmount();
		client.close();
	});

	it("owns subscription cleanup", () => {
		const client = new TestClient<MessageRow>();
		const view = render(
			<RealtimeProvider client={client}>
				<Messages query={query("query-1")} />
			</RealtimeProvider>,
		);
		const subscription = client.latest();
		view.unmount();
		expect(subscription.unsubscribed).toBe(true);
	});

	it("renders preloaded server snapshots without opening a subscription", () => {
		const client = new TestClient<MessageRow>();
		const html = renderToString(
			<RealtimeProvider client={client}>
				<Messages
					query={query("query-1")}
					initialData={[{ id: 1, title: "server" }]}
				/>
			</RealtimeProvider>,
		);

		expect(html).toContain("connecting");
		expect(html).toContain("server");
		expect(client.subscriptions).toHaveLength(0);
	});

	it("throws outside a provider", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => render(<Messages query={query("query-1")} />)).toThrow(
			"useLiveQuery requires a RealtimeProvider",
		);
	});
});

describe("useLiveQuery skip", () => {
	it("returns a stable idle result without subscribing while the query is null", async () => {
		const client = new TestClient<MessageRow>();
		const results: UseLiveQueryResult<MessageRow>[] = [];
		const refreshQuery = vi.fn(async () => query("refresh"));
		const props = {
			query: null,
			initialData: [{ id: 1, title: "server" }],
			refreshQuery,
			observe: (result: UseLiveQueryResult<MessageRow>) =>
				results.push(result),
		};
		const { rerender } = renderMessages(client, props);
		rerender({ ...props, initialData: [{ id: 2, title: "ignored" }] });
		rerender({ ...props, refreshQuery: async () => query("refresh-2") });

		expect(client.subscriptions).toHaveLength(0);
		expect(screen.getByText("closed:none")).toBeTruthy();
		const [idle] = results;
		expect(results).toHaveLength(3);
		for (const result of results) expect(result).toBe(idle);
		expect(Object.isFrozen(idle)).toBe(true);
		expect(idle).toEqual({
			status: "closed",
			error: undefined,
			data: undefined,
			isPlaceholderData: false,
			utils: expect.any(Object),
		});

		const { utils } = idle;
		expect(utils.getState()).toEqual({
			status: "closed",
			error: undefined,
		});
		expect(utils.getSnapshot()).toEqual({
			status: "closed",
			error: undefined,
			data: undefined,
		});
		expect(utils).not.toHaveProperty("unsubscribe");
		const stopListening = [
			utils.onChange(vi.fn()),
			utils.onStateChange(vi.fn()),
			utils.onUpdate(vi.fn()),
		];
		for (const stop of stopListening) expect(stop()).toBeUndefined();
		await expect(utils.awaitTxId("42")).rejects.toThrow(
			"Live query is skipped",
		);
		await expect(utils.awaitRows(() => true)).rejects.toThrow(
			"Live query is skipped",
		);
		await expect(utils.renew(query("query-1"))).rejects.toThrow(
			"Live query is skipped",
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(refreshQuery).not.toHaveBeenCalled();
	});

	it("subscribes when a query arrives and unsubscribes when skipped again", () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		const observe = (result: UseLiveQueryResult<MessageRow>) => {
			observed = result;
		};
		const { rerender } = renderMessages(client, { query: null, observe });
		const idleUtils = observed?.utils;

		const first = query("query-1");
		rerender({ query: first, observe });
		expect(client.subscriptions).toHaveLength(1);
		expect(screen.getByText("connecting:none")).toBeTruthy();
		expect(observed?.utils).not.toBe(idleUtils);
		act(() =>
			client.latest().publish(liveSnapshot({ id: 1, title: "first" })),
		);
		expect(screen.getByText("live:first")).toBeTruthy();

		rerender({ query: null, observe });
		expect(client.latest().unsubscribed).toBe(true);
		expect(screen.getByText("closed:none")).toBeTruthy();
		expect(observed?.utils).toBe(idleUtils);

		rerender({ query: first, observe });
		expect(client.subscriptions).toHaveLength(2);
		expect(activeSubscriptions(client)).toHaveLength(1);
	});

	it("opens exactly one subscription under StrictMode", () => {
		const client = new TestClient<MessageRow>();
		const { view, rerender } = renderMessages(
			client,
			{ query: null },
			{ strict: true },
		);
		expect(client.subscriptions).toHaveLength(0);
		expect(screen.getByText("closed:none")).toBeTruthy();

		rerender({ query: query("query-1") });
		expect(activeSubscriptions(client)).toHaveLength(1);
		act(() =>
			activeSubscriptions(client)[0]?.publish(
				liveSnapshot({ id: 1, title: "first" }),
			),
		);
		expect(screen.getByText("live:first")).toBeTruthy();

		view.unmount();
		expect(activeSubscriptions(client)).toHaveLength(0);
	});

	it("renders a skipped query on the server without subscribing", () => {
		const client = new TestClient<MessageRow>();
		const html = renderToString(
			<RealtimeProvider client={client}>
				<Messages
					query={null}
					initialData={[{ id: 1, title: "server" }]}
					keepPreviousData
				/>
			</RealtimeProvider>,
		);

		expect(html.replaceAll("<!-- -->", "")).toBe(
			"<span>closed:none</span>",
		);
		expect(client.subscriptions).toHaveLength(0);
	});
});

describe("useLiveQuery keepPreviousData", () => {
	it("keeps the previous rows until the next query's first result", () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		const observe = (result: UseLiveQueryResult<MessageRow>) => {
			observed = result;
		};
		const { rerender } = renderMessages(client, {
			query: query("query-1"),
			keepPreviousData: true,
			observe,
		});
		const firstSubscription = client.latest();
		act(() =>
			firstSubscription.publish(liveSnapshot({ id: 1, title: "first" })),
		);
		expect(observed?.isPlaceholderData).toBe(false);

		rerender({ query: query("query-2"), keepPreviousData: true, observe });

		expect(firstSubscription.unsubscribed).toBe(true);
		expect(client.subscriptions).toHaveLength(2);
		expect(screen.getByText("connecting:first:previous")).toBeTruthy();
		expect(observed).toMatchObject({
			status: "connecting",
			error: undefined,
			data: [{ id: 1, title: "first" }],
			isPlaceholderData: true,
		});
		// utils describe the current query, which has no rows yet.
		expect(observed?.utils.getSnapshot().data).toBeUndefined();

		act(() =>
			client.latest().publish(liveSnapshot({ id: 2, title: "second" })),
		);
		expect(screen.getByText("live:second")).toBeTruthy();
		expect(observed).toMatchObject({
			data: [{ id: 2, title: "second" }],
			isPlaceholderData: false,
		});
	});

	it("shows the next query's empty result instead of the previous rows", () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		const observe = (result: UseLiveQueryResult<MessageRow>) => {
			observed = result;
		};
		const { rerender } = renderMessages(client, {
			query: query("query-1"),
			keepPreviousData: true,
			observe,
		});
		act(() =>
			client.latest().publish(liveSnapshot({ id: 1, title: "first" })),
		);
		rerender({ query: query("query-2"), keepPreviousData: true, observe });
		act(() => client.latest().publish(liveSnapshot()));

		expect(screen.getByText("live:none")).toBeTruthy();
		expect(observed).toMatchObject({ data: [], isPlaceholderData: false });
	});

	it("keeps the last rows through rapid query changes", () => {
		const client = new TestClient<MessageRow>();
		const { rerender } = renderMessages(client, {
			query: query("query-a"),
			keepPreviousData: true,
		});
		act(() => client.latest().publish(liveSnapshot({ id: 1, title: "a" })));

		// B is replaced by C before B's first snapshot arrives.
		rerender({ query: query("query-b"), keepPreviousData: true });
		const [, b] = client.subscriptions;
		rerender({ query: query("query-c"), keepPreviousData: true });
		expect(b?.unsubscribed).toBe(true);
		expect(activeSubscriptions(client)).toEqual([client.latest()]);
		expect(screen.getByText("connecting:a:previous")).toBeTruthy();

		// A late snapshot from the abandoned query is ignored.
		act(() => b?.publish(liveSnapshot({ id: 2, title: "b" })));
		expect(screen.getByText("connecting:a:previous")).toBeTruthy();

		act(() => client.latest().publish(liveSnapshot({ id: 3, title: "c" })));
		expect(screen.getByText("live:c")).toBeTruthy();

		// The placeholder is always the latest rows that were rendered.
		rerender({ query: query("query-d"), keepPreviousData: true });
		expect(screen.getByText("connecting:c:previous")).toBeTruthy();
	});

	it("keeps the previous rows while the query is skipped", () => {
		const client = new TestClient<MessageRow>();
		const results: UseLiveQueryResult<MessageRow>[] = [];
		const observe = (result: UseLiveQueryResult<MessageRow>) => {
			results.push(result);
		};
		const { rerender } = renderMessages(client, {
			query: query("query-1"),
			keepPreviousData: true,
			observe,
		});
		act(() =>
			client.latest().publish(liveSnapshot({ id: 1, title: "first" })),
		);

		// For example, while the next sealed query is being fetched.
		rerender({ query: null, keepPreviousData: true, observe });
		expect(client.latest().unsubscribed).toBe(true);
		expect(screen.getByText("closed:first:previous")).toBeTruthy();
		const skipped = results.at(-1);
		expect(skipped).toMatchObject({
			status: "closed",
			error: undefined,
			data: [{ id: 1, title: "first" }],
			isPlaceholderData: true,
		});
		expect(skipped?.utils.getState().status).toBe("closed");
		rerender({ query: null, keepPreviousData: true, observe });
		expect(results.at(-1)).toBe(skipped);

		rerender({ query: query("query-2"), keepPreviousData: true, observe });
		expect(screen.getByText("connecting:first:previous")).toBeTruthy();
		act(() =>
			client.latest().publish(liveSnapshot({ id: 2, title: "second" })),
		);
		expect(screen.getByText("live:second")).toBeTruthy();
	});

	it("prefers the next query's initialData over the previous rows", () => {
		const client = new TestClient<MessageRow>();
		const { rerender } = renderMessages(client, {
			query: query("query-1"),
			keepPreviousData: true,
		});
		act(() =>
			client.latest().publish(liveSnapshot({ id: 1, title: "first" })),
		);

		rerender({
			query: query("query-2"),
			initialData: [{ id: 2, title: "seed" }],
			keepPreviousData: true,
		});
		expect(screen.getByText("connecting:seed")).toBeTruthy();
	});

	it("reports the next query's error alongside the previous rows", () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		const observe = (result: UseLiveQueryResult<MessageRow>) => {
			observed = result;
		};
		const { rerender } = renderMessages(client, {
			query: query("query-1"),
			keepPreviousData: true,
			observe,
		});
		act(() =>
			client.latest().publish(liveSnapshot({ id: 1, title: "first" })),
		);
		rerender({ query: query("query-2"), keepPreviousData: true, observe });

		const error = Object.assign(new Error("Query rejected"), {
			code: "QUERY_REJECTED",
			retryable: false,
		});
		act(() =>
			client
				.latest()
				.publish({ status: "error", error, data: undefined }),
		);
		expect(screen.getByText("error:first:previous")).toBeTruthy();
		expect(observed).toMatchObject({
			status: "error",
			error,
			isPlaceholderData: true,
		});
	});

	it("empties data on a query change unless keepPreviousData is set", () => {
		const client = new TestClient<MessageRow>();
		let observed: UseLiveQueryResult<MessageRow> | undefined;
		const observe = (result: UseLiveQueryResult<MessageRow>) => {
			observed = result;
		};
		const { rerender } = renderMessages(client, {
			query: query("query-1"),
			observe,
		});
		act(() =>
			client.latest().publish(liveSnapshot({ id: 1, title: "first" })),
		);

		const second = query("query-2");
		rerender({ query: second, observe });
		expect(screen.getByText("connecting:none")).toBeTruthy();
		expect(observed?.isPlaceholderData).toBe(false);

		// The option is read on every render.
		rerender({ query: second, keepPreviousData: true, observe });
		expect(screen.getByText("connecting:first:previous")).toBeTruthy();
		rerender({ query: second, keepPreviousData: false, observe });
		expect(screen.getByText("connecting:none")).toBeTruthy();
		expect(client.subscriptions).toHaveLength(2);
	});

	it("keeps the previous rows under StrictMode", () => {
		const client = new TestClient<MessageRow>();
		const { view, rerender } = renderMessages(
			client,
			{ query: query("query-a"), keepPreviousData: true },
			{ strict: true },
		);
		expect(activeSubscriptions(client)).toHaveLength(1);
		act(() =>
			activeSubscriptions(client)[0]?.publish(
				liveSnapshot({ id: 1, title: "a" }),
			),
		);
		expect(screen.getByText("live:a")).toBeTruthy();

		rerender({ query: query("query-b"), keepPreviousData: true });
		rerender({ query: query("query-c"), keepPreviousData: true });
		expect(activeSubscriptions(client)).toEqual([client.latest()]);
		expect(screen.getByText("connecting:a:previous")).toBeTruthy();

		act(() => client.latest().publish(liveSnapshot({ id: 3, title: "c" })));
		expect(screen.getByText("live:c")).toBeTruthy();

		view.unmount();
		expect(activeSubscriptions(client)).toHaveLength(0);
	});
});

describe("useRealtimeClient", () => {
	it("returns the client passed to the provider", () => {
		const client = new TestClient<MessageRow>();
		const observe = vi.fn();
		render(
			<RealtimeProvider client={client}>
				<ClientReader observe={observe} />
			</RealtimeProvider>,
		);

		expect(observe).toHaveBeenCalledOnce();
		expect(observe.mock.lastCall?.[0]).toBe(client);
	});

	it("reads the nearest provider", () => {
		const outer = new TestClient<MessageRow>();
		const inner = new TestClient<MessageRow>();
		const observeOuter = vi.fn();
		const observeInner = vi.fn();
		render(
			<RealtimeProvider client={outer}>
				<ClientReader observe={observeOuter} />
				<RealtimeProvider client={inner}>
					<ClientReader observe={observeInner} />
				</RealtimeProvider>
			</RealtimeProvider>,
		);

		expect(observeOuter.mock.lastCall?.[0]).toBe(outer);
		expect(observeInner.mock.lastCall?.[0]).toBe(inner);
	});

	it("returns the same client across re-renders", () => {
		const client = new TestClient<MessageRow>();
		const observe = vi.fn();
		const view = render(
			<RealtimeProvider client={client}>
				<ClientReader observe={observe} label="first" />
			</RealtimeProvider>,
		);
		view.rerender(
			<RealtimeProvider client={client}>
				<ClientReader observe={observe} label="second" />
			</RealtimeProvider>,
		);

		expect(screen.getByText("second")).toBeTruthy();
		expect(observe).toHaveBeenCalledTimes(2);
		for (const [observed] of observe.mock.calls) {
			expect(observed).toBe(client);
		}
	});

	it("throws outside a provider", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => render(<ClientReader observe={vi.fn()} />)).toThrow(
			"useRealtimeClient requires a RealtimeProvider",
		);
	});
});

function ClientReader({
	observe,
	label = "client",
}: {
	observe: (client: RealtimeClient) => void;
	label?: string;
}) {
	observe(useRealtimeClient());
	return <span>{label}</span>;
}

function Messages({
	query: currentQuery,
	initialData,
	refreshQuery,
	keepPreviousData,
	observe,
}: {
	query: SealedLiveQuery<MessageRow> | null;
	initialData?: readonly MessageRow[];
	refreshQuery?: () => Promise<SealedLiveQuery<MessageRow>>;
	keepPreviousData?: boolean;
	observe?: (result: UseLiveQueryResult<MessageRow>) => void;
}) {
	const result = useLiveQuery(currentQuery, {
		initialData,
		refreshQuery,
		keepPreviousData,
	});
	observe?.(result);
	return (
		<span>
			{result.status}:{result.data?.[0]?.title ?? "none"}
			{result.isPlaceholderData ? ":previous" : ""}
		</span>
	);
}

/** Render `Messages` and return a function that re-renders it with new props. */
function renderMessages(
	client: RealtimeClient,
	props: Parameters<typeof Messages>[0],
	{ strict = false }: { strict?: boolean } = {},
) {
	const tree = (current: Parameters<typeof Messages>[0]) => {
		const provided = (
			<RealtimeProvider client={client}>
				<Messages {...current} />
			</RealtimeProvider>
		);
		return strict ? <StrictMode>{provided}</StrictMode> : provided;
	};
	const view = render(tree(props));
	return {
		view,
		rerender: (next: Parameters<typeof Messages>[0]) =>
			view.rerender(tree(next)),
	};
}

function liveSnapshot(
	...rows: readonly MessageRow[]
): LiveQuerySnapshot<MessageRow> {
	return { status: "live", error: undefined, data: rows };
}

function activeSubscriptions<Row>(
	client: TestClient<Row>,
): TestSubscription<Row>[] {
	return client.subscriptions.filter(
		(subscription) => !subscription.unsubscribed,
	);
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
		baseline: (
			rows = [{ row_key: "a".repeat(64), values: ["1", "before"] }],
		) => {
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
				rows,
			});
			receive({ type: "baseline_sync_end", ...target, batch_count: 1 });
		},
	};
}

class TestClient<Row> implements RealtimeClient {
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
	private updateListeners = new Set<
		(update: RawLiveQueryUpdate<Row>) => void
	>();
	readonly renewals: SealedLiveQuery<Row>[] = [];
	unsubscribed = false;
	private snapshot: LiveQuerySnapshot<Row>;

	constructor(initialData?: readonly Row[]) {
		this.snapshot = {
			status: "connecting",
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

	onUpdate = (
		listener: (update: RawLiveQueryUpdate<Row>) => void,
	): (() => void) => add(this.updateListeners, listener);

	onStateChange = (listener: (state: LiveQueryState) => void): (() => void) =>
		add(this.stateListeners, listener);

	awaitTxId = vi.fn(
		async (_txid: string, _timeout?: number): Promise<void> =>
			Promise.resolve(),
	);

	awaitRows = vi.fn(
		async (
			_matches: (rows: readonly Row[]) => boolean,
			_timeout?: number,
		): Promise<void> => Promise.resolve(),
	);

	onChange = (
		listener: (snapshot: LiveQuerySnapshot<Row>) => void,
	): (() => void) => add(this.snapshotListeners, listener);

	renew = async (query: SealedLiveQuery<Row>): Promise<void> => {
		this.renewals.push(query);
		this.publish({
			...this.snapshot,
			status: "connecting",
			error: undefined,
		});
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
