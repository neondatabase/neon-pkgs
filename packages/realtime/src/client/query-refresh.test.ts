import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createClientEventSink,
	registerSubscriptionEvents,
} from "./diagnostics.js";
import { QueryRefreshController } from "./query-refresh.js";
import type { SealedLiveQuery } from "./sealed-query.js";
import type { RawLiveQuerySubscription } from "./types.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("QueryRefreshController", () => {
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

		expect(refreshQuery).toHaveBeenCalledTimes(5);
		expect(onRefreshExhausted).not.toHaveBeenCalled();
		expect(
			events.filter((event) => event === "query_refresh_callback_failed"),
		).toHaveLength(5);
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
				message: "Realtime renewal must be for the same query",
			}),
		);
		expect(events).not.toContain("query_refresh_callback_succeeded");
		expect(events).toContain("query_refresh_stopped");
		controller.stop();
	});
});

function loggedSubscription(
	events: string[],
): RawLiveQuerySubscription<unknown> {
	const subscription = {} as RawLiveQuerySubscription<unknown>;
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
			kid: "current",
			v: 1,
		}),
	).toString("base64url");
	return `${header}..a.b.c`;
}
