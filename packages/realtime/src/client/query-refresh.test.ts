import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createClientEventSink,
	registerSubscriptionEvents,
} from "./diagnostics.js";
import { QueryRefreshController } from "./query-refresh.js";
import type { SealedLiveQuery } from "./sealed-query.js";
import type { LiveQueryState, RawLiveQuerySubscription } from "./types.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("QueryRefreshController", () => {
	it("backs off failed refreshes with jitter and resets after recovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		let failing = true;
		const refreshQuery = vi.fn(async () => {
			if (failing) throw new Error("authorization unavailable");
			return query(Date.now() / 1000 + 60);
		});
		const controller = new QueryRefreshController({
			query: query(5),
			refreshQuery,
			renewSubscription: async () => {},
			onRefreshExhausted: vi.fn(),
		});
		try {
			controller.start();
			await vi.advanceTimersByTimeAsync(20_000);
			expect(refreshQuery.mock.calls.length).toBeLessThanOrEqual(6);
			expect(refreshQuery.mock.calls.length).toBeGreaterThanOrEqual(3);
			failing = false;
			await vi.advanceTimersToNextTimerAsync();
			const recoveredCalls = refreshQuery.mock.calls.length;
			failing = true;
			await vi.advanceTimersToNextTimerAsync();
			const failedCalls = refreshQuery.mock.calls.length;
			expect(failedCalls).toBeGreaterThan(recoveredCalls);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(refreshQuery.mock.calls.length).toBeGreaterThan(failedCalls);
		} finally {
			controller.stop();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("backs off rejected renewals even when issuing fresh capabilities succeeds", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const renewSubscription = vi.fn(async () => {
			throw new Error("subscription temporarily unavailable");
		});
		const controller = new QueryRefreshController({
			query: query(5),
			refreshQuery: async () => query(Date.now() / 1000 + 60),
			renewSubscription,
			onRefreshExhausted: vi.fn(),
		});
		try {
			controller.start();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(renewSubscription.mock.calls.length).toBeLessThanOrEqual(9);
			expect(renewSubscription.mock.calls.length).toBeGreaterThanOrEqual(
				3,
			);
		} finally {
			controller.stop();
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("paces successful refreshes within the early-refresh window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => query(Date.now() / 1000 + 5));
		const controller = new QueryRefreshController({
			query: query(5),
			refreshQuery,
			renewSubscription: async () => {},
			onRefreshExhausted: vi.fn(),
		});
		try {
			controller.start();
			await vi.advanceTimersByTimeAsync(20);
			expect(refreshQuery).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(980);
			expect(refreshQuery).toHaveBeenCalledTimes(2);
		} finally {
			controller.stop();
		}
	});

	it.each([
		"in order",
		"in reverse",
	])("applies overlapping manual renewals %s", async (order) => {
		const renewals = [deferred(), deferred()];
		let next = 0;
		const controller = new QueryRefreshController({
			query: query(20),
			renewSubscription: () => renewals[next++].promise,
			onRefreshExhausted: vi.fn(),
		});
		const older = query(40);
		const newer = query(60);
		const first = controller.replaceSealedQuery(older);
		const second = controller.replaceSealedQuery(newer);
		if (order === "in order") {
			renewals[0].resolve();
			await first;
			expect(controller.currentQuery()).toBe(older);
			renewals[1].resolve();
			await second;
		} else {
			renewals[1].resolve();
			await second;
			renewals[0].resolve();
			await first;
		}
		expect(controller.currentQuery()).toBe(newer);
	});

	it("ignores a manual renewal completion from an earlier lifecycle", async () => {
		vi.useFakeTimers();
		const pending = deferred();
		const initial = query(20);
		const onSubscriptionRenewed = vi.fn();
		const controller = new QueryRefreshController({
			query: initial,
			renewSubscription: () => pending.promise,
			onSubscriptionRenewed,
			onRefreshExhausted: vi.fn(),
		});
		controller.start();
		const replacement = controller.replaceSealedQuery(query(40));
		controller.stop();
		controller.start();
		pending.resolve();
		await replacement;
		expect(controller.currentQuery()).toBe(initial);
		expect(onSubscriptionRenewed).not.toHaveBeenCalled();
		controller.stop();
	});

	it("keeps successful manual replacements usable while stopped and after a newer failure", async () => {
		const renewals = [deferred(), deferred()];
		let next = 0;
		const initial = query(20);
		const controller = new QueryRefreshController({
			query: initial,
			renewSubscription: () => renewals[next++].promise,
			onRefreshExhausted: vi.fn(),
		});
		const accepted = query(40);
		const first = controller.replaceSealedQuery(accepted);
		const second = controller.replaceSealedQuery(query(60));
		const failure = expect(second).rejects.toThrow("renewal failed");
		renewals[1].reject(new Error("renewal failed"));
		await failure;
		expect(controller.currentQuery()).toBe(initial);
		renewals[0].resolve();
		await first;
		expect(controller.currentQuery()).toBe(accepted);
	});

	it("refreshes before expiry and schedules from the replacement", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const replacement = query(40);
		const refreshQuery = vi.fn(async () => replacement);
		const renewSubscription = vi.fn();
		const onSubscriptionRenewed = vi.fn();
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onSubscriptionRenewed,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(refreshQuery).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(renewSubscription).toHaveBeenCalledWith(replacement);
		expect(onSubscriptionRenewed).toHaveBeenCalledOnce();
		expect(controller.currentQuery()).toBe(replacement);
		controller.stop();
	});

	it("continues retrying capability issuance after expiry", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => {
			throw new Error("unavailable");
		});
		const onRefreshExhausted = vi.fn();
		const events: string[] = [];
		const subscription = loggedSubscription(events);
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery,
			renewSubscription: vi.fn(),
			onRefreshExhausted,
			subscription,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(4_000);

		expect(refreshQuery).toHaveBeenCalledTimes(3);
		expect(onRefreshExhausted).not.toHaveBeenCalled();
		expect(
			events.filter((event) => event === "query_refresh_callback_failed"),
		).toHaveLength(3);
		expect(events).toContain("query_refresh_callback_started");
		expect(events).toContain("query_refresh_scheduled");
		controller.stop();
	});

	it("ignores an in-flight result after it is stopped", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let resolveRefresh!: (query: SealedLiveQuery<unknown>) => void;
		const refreshQuery = vi.fn(
			() =>
				new Promise<SealedLiveQuery<unknown>>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const renewSubscription = vi.fn();
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);
		controller.stop();
		resolveRefresh(query(20));
		await Promise.resolve();

		expect(renewSubscription).not.toHaveBeenCalled();
	});

	it("keeps obtaining capabilities while acceptance is pending", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const pending = new Promise<void>(() => undefined);
		const refreshQuery = vi.fn(async () => query(Date.now() / 1_000 + 20));
		const renewSubscription = vi.fn(() => pending);
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshQuery).toHaveBeenCalledOnce();
		expect(renewSubscription).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshQuery).toHaveBeenCalledTimes(2);
		expect(renewSubscription).toHaveBeenCalledTimes(2);
		controller.stop();
	});

	it("reports a valid callback result before renewal acceptance", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const events: string[] = [];
		const subscription = loggedSubscription(events);
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery: async () => query(20),
			renewSubscription: async () => {
				throw new Error("transport unavailable");
			},
			onRefreshExhausted: vi.fn(),
			subscription,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(events).toContain("query_refresh_callback_succeeded");
		controller.stop();
	});

	it("stops when a refresh returns a sealed query for another query", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => ({
			...query(20),
			queryFingerprint: "22".repeat(32),
		}));
		const renewSubscription = vi.fn();
		const onRefreshExhausted = vi.fn();
		const events: string[] = [];
		const subscription = loggedSubscription(events);
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted,
			subscription,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(refreshQuery).toHaveBeenCalledOnce();
		expect(renewSubscription).not.toHaveBeenCalled();
		expect(onRefreshExhausted).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Live-query renewal must be for the same query",
			}),
		);
		expect(events).not.toContain("query_refresh_callback_succeeded");
		expect(events).toContain("query_refresh_stopped");
		controller.stop();
	});

	it.each([
		"error",
		"closed",
	] as const)("does not refresh a subscription that is %s", async (status) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => query(Date.now() / 1_000 + 20));
		const renewSubscription = vi.fn(async () => undefined);
		const subscription = statefulSubscription({ status: "live" });
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted: vi.fn(),
		});
		// Integrations that subscribe after constructing the controller, such
		// as the React store, associate the subscription afterwards.
		controller.setSubscription(subscription);

		controller.start();
		subscription.setState(endedState(status));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(refreshQuery).not.toHaveBeenCalled();
		expect(renewSubscription).not.toHaveBeenCalled();
		controller.stop();
	});

	it.each([
		"error",
		"closed",
	] as const)("does not renew when the subscription becomes %s during refresh", async (status) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let resolveRefresh!: (query: SealedLiveQuery<unknown>) => void;
		const refreshQuery = vi.fn(
			() =>
				new Promise<SealedLiveQuery<unknown>>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const renewSubscription = vi.fn(async () => undefined);
		const subscription = statefulSubscription({ status: "live" });
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted: vi.fn(),
			subscription,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);
		subscription.setState(endedState(status));
		const replacement = query(60);
		resolveRefresh(replacement);
		await vi.advanceTimersByTimeAsync(120_000);

		expect(renewSubscription).not.toHaveBeenCalled();
		expect(controller.currentQuery()).not.toBe(replacement);
		expect(refreshQuery).toHaveBeenCalledOnce();
		controller.stop();
	});

	it("does not retry a failed refresh after the subscription ends", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let rejectRefresh!: (error: Error) => void;
		const refreshQuery = vi.fn(
			() =>
				new Promise<SealedLiveQuery<unknown>>((_, reject) => {
					rejectRefresh = reject;
				}),
		);
		const renewSubscription = vi.fn(async () => undefined);
		const subscription = statefulSubscription({ status: "live" });
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted: vi.fn(),
			subscription,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);
		subscription.setState(endedState("error"));
		rejectRefresh(new Error("seal endpoint unavailable"));
		await vi.advanceTimersByTimeAsync(120_000);

		expect(refreshQuery).toHaveBeenCalledOnce();
		expect(renewSubscription).not.toHaveBeenCalled();
		controller.stop();
	});

	it("stops retrying when the subscription fails during renewal", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => query(Date.now() / 1_000 + 60));
		const subscription = statefulSubscription({ status: "live" });
		// A failed subscription rejects renewal, as the client does for a
		// subscription whose wire state has failed.
		const renewSubscription = vi.fn(async () => {
			subscription.setState(endedState("error"));
			throw new Error("Realtime connection cannot recover");
		});
		const onRefreshExhausted = vi.fn();
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted,
			subscription,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshQuery).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(refreshQuery).toHaveBeenCalledOnce();
		expect(renewSubscription).toHaveBeenCalledOnce();
		expect(onRefreshExhausted).not.toHaveBeenCalled();
		controller.stop();
	});

	it("keeps retrying renewal while the subscription can recover", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => query(Date.now() / 1_000 + 60));
		const renewSubscription = vi.fn(async () => {
			throw new Error("transport unavailable");
		});
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			renewSubscription,
			onRefreshExhausted: vi.fn(),
			subscription: statefulSubscription({ status: "connecting" }),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(13_000);

		expect(refreshQuery).toHaveBeenCalledTimes(3);
		controller.stop();
	});
});

function statefulSubscription(state: {
	readonly status: "connecting" | "live";
}): RawLiveQuerySubscription<unknown> & {
	setState(next: LiveQueryState): void;
} {
	let current: LiveQueryState = { ...state, error: undefined };
	return Object.assign({} as RawLiveQuerySubscription<unknown>, {
		getState: () => current,
		setState: (next: LiveQueryState) => {
			current = next;
		},
	});
}

function endedState(status: "error" | "closed"): LiveQueryState {
	return status === "error"
		? {
				status,
				error: Object.assign(new Error("Live query failed"), {
					code: "connection_lost",
					retryable: false,
				}),
			}
		: { status, error: undefined };
}

function loggedSubscription(
	events: string[],
): RawLiveQuerySubscription<unknown> {
	const subscription = statefulSubscription({ status: "live" });
	const clientEvents = createClientEventSink({
		logLevel: "debug",
		logger: (entry) => events.push(entry.event),
	});
	registerSubscriptionEvents(subscription, clientEvents.createSubscription());
	return subscription;
}

function query(expiresAt: number): SealedLiveQuery<unknown> {
	return {
		capability: compactJwe(),
		queryFingerprint: "11".repeat(32),
		expiresAt: expiresAt * 1_000,
	};
}

function compactJwe(): string {
	const header = Buffer.from(
		JSON.stringify({
			alg: "dir",
			enc: "A256GCM",
			v: 1,
		}),
	).toString("base64url");
	return `${header}..a.b.c`;
}

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}
