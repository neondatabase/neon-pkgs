import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveQueryAuthorization } from "./authorization.js";
import { AuthorizationRefreshController } from "./authorization-refresh.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("AuthorizationRefreshController", () => {
	it("refreshes before expiry and schedules from the replacement", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const replacement = authorization(40);
		const refreshAuthorization = vi.fn(async () => replacement);
		const applyAuthorization = vi.fn();
		const onAuthorizationApplied = vi.fn();
		const controller = new AuthorizationRefreshController({
			authorization: authorization(20),
			refreshAuthorization,
			applyAuthorization,
			onAuthorizationApplied,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(refreshAuthorization).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(applyAuthorization).toHaveBeenCalledWith(replacement);
		expect(onAuthorizationApplied).toHaveBeenCalledOnce();
		expect(controller.currentAuthorization()).toBe(replacement);
		controller.stop();
	});

	it("continues retrying capability issuance after expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshAuthorization = vi.fn(async () => {
			throw new Error("unavailable");
		});
		const onRefreshExhausted = vi.fn();
		const controller = new AuthorizationRefreshController({
			authorization: authorization(2),
			refreshAuthorization,
			applyAuthorization: vi.fn(),
			onRefreshExhausted,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(4_000);

		expect(refreshAuthorization).toHaveBeenCalledTimes(5);
		expect(onRefreshExhausted).not.toHaveBeenCalled();
		controller.stop();
	});

	it("ignores an in-flight result after it is stopped", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let resolveRefresh!: (
			authorization: LiveQueryAuthorization<unknown>,
		) => void;
		const refreshAuthorization = vi.fn(
			() =>
				new Promise<LiveQueryAuthorization<unknown>>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const applyAuthorization = vi.fn();
		const controller = new AuthorizationRefreshController({
			authorization: authorization(2),
			refreshAuthorization,
			applyAuthorization,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);
		controller.stop();
		resolveRefresh(authorization(20));
		await Promise.resolve();

		expect(applyAuthorization).not.toHaveBeenCalled();
	});

	it("keeps obtaining capabilities while acceptance is pending", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const pending = new Promise<void>(() => undefined);
		const refreshAuthorization = vi.fn(async () =>
			authorization(Date.now() / 1_000 + 20),
		);
		const applyAuthorization = vi.fn(() => pending);
		const controller = new AuthorizationRefreshController({
			authorization: authorization(20),
			refreshAuthorization,
			applyAuthorization,
			onRefreshExhausted: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshAuthorization).toHaveBeenCalledOnce();
		expect(applyAuthorization).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(refreshAuthorization).toHaveBeenCalledTimes(2);
		expect(applyAuthorization).toHaveBeenCalledTimes(2);
		controller.stop();
	});

	it("stops when a refresh returns an authorization for another query", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const refreshAuthorization = vi.fn(async () => ({
			...authorization(20),
			queryFingerprint: "22".repeat(32),
		}));
		const applyAuthorization = vi.fn();
		const onRefreshExhausted = vi.fn();
		const controller = new AuthorizationRefreshController({
			authorization: authorization(2),
			refreshAuthorization,
			applyAuthorization,
			onRefreshExhausted,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(refreshAuthorization).toHaveBeenCalledOnce();
		expect(applyAuthorization).not.toHaveBeenCalled();
		expect(onRefreshExhausted).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Neon Live renewal must be for the same query",
			}),
		);
		controller.stop();
	});
});

function authorization(expiresAt: number): LiveQueryAuthorization<unknown> {
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
