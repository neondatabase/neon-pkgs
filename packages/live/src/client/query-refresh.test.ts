import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryRefreshController } from "./query-refresh.js";
import type { SealedLiveQuery } from "./sealed-query.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("QueryRefreshController", () => {
	it("refreshes before expiry and schedules from the replacement", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const replacement = query(40);
		const refreshQuery = vi.fn(async () => replacement);
		const applyQuery = vi.fn();
		const onQueryApplied = vi.fn();
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			applyQuery,
			onQueryApplied,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(refreshQuery).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(applyQuery).toHaveBeenCalledWith(replacement);
		expect(onQueryApplied).toHaveBeenCalledOnce();
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
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery,
			applyQuery: vi.fn(),
			onRefreshExhausted,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(4_000);

		expect(refreshQuery).toHaveBeenCalledTimes(5);
		expect(onRefreshExhausted).not.toHaveBeenCalled();
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
		const applyQuery = vi.fn();
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery,
			applyQuery,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);
		controller.stop();
		resolveRefresh(query(20));
		await Promise.resolve();

		expect(applyQuery).not.toHaveBeenCalled();
	});

	it("keeps obtaining capabilities while acceptance is pending", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const pending = new Promise<void>(() => undefined);
		const refreshQuery = vi.fn(async () => query(Date.now() / 1_000 + 20));
		const applyQuery = vi.fn(() => pending);
		const controller = new QueryRefreshController({
			query: query(20),
			refreshQuery,
			applyQuery,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshQuery).toHaveBeenCalledOnce();
		expect(applyQuery).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshQuery).toHaveBeenCalledTimes(2);
		expect(applyQuery).toHaveBeenCalledTimes(2);
		controller.stop();
	});

	it("stops when a refresh returns a sealed query for another query", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshQuery = vi.fn(async () => ({
			...query(20),
			queryFingerprint: "22".repeat(32),
		}));
		const applyQuery = vi.fn();
		const onRefreshExhausted = vi.fn();
		const controller = new QueryRefreshController({
			query: query(2),
			refreshQuery,
			applyQuery,
			onRefreshExhausted,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(refreshQuery).toHaveBeenCalledOnce();
		expect(applyQuery).not.toHaveBeenCalled();
		expect(onRefreshExhausted).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Neon Live renewal must be for the same query",
			}),
		);
		controller.stop();
	});
});

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
