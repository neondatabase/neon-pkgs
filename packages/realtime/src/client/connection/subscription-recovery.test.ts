import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defined } from "../../defined.test-helpers.js";
import type { DiagnosticError } from "../diagnostics.js";
import type { ReconnectOptions } from "./reconnect.js";
import { SubscriptionRecovery } from "./subscription-recovery.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function createRecovery(options: boolean | ReconnectOptions = {}) {
	const callbacks = {
		resubscribe: vi.fn(),
		exhausted: vi.fn(),
		scheduled: vi.fn(),
	};
	const recovery = new SubscriptionRecovery(
		typeof options === "object"
			? {
					baseMs: 100,
					capMs: 400,
					stabilityMs: 1_000,
					random: () => 0,
					...options,
				}
			: options,
		callbacks,
	);
	return { recovery, callbacks };
}

function error(code = "upstream_cancelled"): DiagnosticError {
	return Object.assign(new Error(code), { code, retryable: false });
}

describe("SubscriptionRecovery", () => {
	it("shares capped exponential backoff across cancellations and admission rejections", async () => {
		const { recovery, callbacks } = createRecovery();
		for (const [index, delayMs] of [50, 100, 200, 200].entries()) {
			const code =
				index % 2 ? "backend_unavailable" : "upstream_cancelled";
			expect(recovery.retry(error(code))).toBe(true);
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				code,
				index + 1,
				delayMs,
			);
			expect(recovery.waiting).toBe(true);
			await vi.advanceTimersByTimeAsync(delayMs - 1);
			expect(callbacks.resubscribe).toHaveBeenCalledTimes(index);
			await vi.advanceTimersByTimeAsync(1);
			expect(callbacks.resubscribe).toHaveBeenCalledTimes(index + 1);
			expect(recovery.waiting).toBe(false);
			// Admission without baseline completion never resets the episode.
			await vi.advanceTimersByTimeAsync(2_000);
		}
		expect(callbacks.exhausted).not.toHaveBeenCalled();
		recovery.cancel();
	});

	it("resets backoff only after a complete baseline stays stable", async () => {
		const { recovery, callbacks } = createRecovery();
		recovery.retry(error());
		await vi.advanceTimersByTimeAsync(50);
		recovery.baselineCompleted();
		await vi.advanceTimersByTimeAsync(999);
		recovery.retry(error());
		expect(callbacks.scheduled).toHaveBeenLastCalledWith(
			"upstream_cancelled",
			2,
			100,
		);
		await vi.advanceTimersByTimeAsync(100);
		recovery.baselineCompleted();
		await vi.advanceTimersByTimeAsync(1_000);
		recovery.retry(error());
		expect(callbacks.scheduled).toHaveBeenLastCalledWith(
			"upstream_cancelled",
			1,
			50,
		);
		recovery.cancel();
	});

	it("preserves the delay and episode when interrupted", async () => {
		const { recovery, callbacks } = createRecovery();
		recovery.retry(error());
		recovery.interrupted();
		await vi.advanceTimersByTimeAsync(49);
		expect(recovery.waiting).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(callbacks.resubscribe).toHaveBeenCalledOnce();
		recovery.baselineCompleted();
		await vi.advanceTimersByTimeAsync(500);
		recovery.interrupted();
		await vi.advanceTimersByTimeAsync(1_000);
		recovery.retry(error());
		expect(callbacks.scheduled).toHaveBeenLastCalledWith(
			"upstream_cancelled",
			2,
			100,
		);
		recovery.cancel();
	});

	it("honors disabled recovery", () => {
		const { recovery, callbacks } = createRecovery(false);
		expect(recovery.retry(error())).toBe(false);
		expect(recovery.waiting).toBe(false);
		expect(callbacks.scheduled).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("honors the attempt limit and cancels the deadline on exhaustion", async () => {
		const { recovery, callbacks } = createRecovery({ maxAttempts: 1 });
		expect(recovery.retry(error())).toBe(true);
		await vi.advanceTimersByTimeAsync(50);
		expect(recovery.retry(error("backend_unavailable"))).toBe(false);
		expect(callbacks.scheduled).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps an absolute deadline across retries and reports the latest error", async () => {
		const { recovery, callbacks } = createRecovery({ maxElapsedMs: 200 });
		recovery.retry(error());
		await vi.advanceTimersByTimeAsync(50);
		const latest = error("backend_unavailable");
		recovery.retry(latest);
		await vi.advanceTimersByTimeAsync(100);
		// Admission and baseline completion do not cancel the elapsed-time limit.
		recovery.baselineCompleted();
		await vi.advanceTimersByTimeAsync(49);
		expect(callbacks.exhausted).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(callbacks.exhausted).toHaveBeenCalledExactlyOnceWith(latest);
		expect(recovery.waiting).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("enforces elapsed-time bounds even if an injected scheduler never fires", async () => {
		const handle = setTimeout(() => undefined, 10_000);
		const clearTimer = vi.fn((timer) => clearTimeout(timer));
		const { recovery, callbacks } = createRecovery({
			maxElapsedMs: 200,
			setTimer: () => handle,
			clearTimer,
		});
		const failure = error();
		recovery.retry(failure);
		await vi.advanceTimersByTimeAsync(200);
		expect(callbacks.resubscribe).not.toHaveBeenCalled();
		expect(callbacks.exhausted).toHaveBeenCalledExactlyOnceWith(failure);
		expect(clearTimer).toHaveBeenCalledWith(handle);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels the deadline after stable recovery", async () => {
		const { recovery, callbacks } = createRecovery({ maxElapsedMs: 2_000 });
		recovery.retry(error());
		await vi.advanceTimersByTimeAsync(50);
		recovery.baselineCompleted();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(callbacks.exhausted).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		"delay",
		"stability",
	])("cancels every timer during %s", async (phase) => {
		const { recovery, callbacks } = createRecovery({ maxElapsedMs: 2_000 });
		recovery.retry(error());
		if (phase === "stability") {
			await vi.advanceTimersByTimeAsync(50);
			recovery.baselineCompleted();
			callbacks.resubscribe.mockClear();
		}
		recovery.cancel();
		recovery.cancel();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(callbacks.resubscribe).not.toHaveBeenCalled();
		expect(callbacks.exhausted).not.toHaveBeenCalled();
		expect(recovery.waiting).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores obsolete delay and stability callbacks from an injected scheduler", async () => {
		const pending: Array<() => void> = [];
		const { recovery, callbacks } = createRecovery({
			setTimer: (callback) => {
				pending.push(callback);
				return setTimeout(() => undefined, 0);
			},
			clearTimer: (handle) => clearTimeout(handle),
		});
		recovery.retry(error());
		const obsoleteDelay = defined(pending[0]);
		recovery.cancel();
		recovery.retry(error());
		obsoleteDelay();
		expect(recovery.waiting).toBe(true);
		defined(pending[1])();
		recovery.baselineCompleted();
		const obsoleteStability = defined(pending[2]);
		recovery.interrupted();
		recovery.baselineCompleted();
		obsoleteStability();
		recovery.retry(error());
		expect(callbacks.scheduled).toHaveBeenLastCalledWith(
			"upstream_cancelled",
			2,
			100,
		);
		recovery.cancel();
		await vi.runAllTimersAsync();
	});

	it("terminates recovery if a policy source throws", async () => {
		const random = vi
			.fn()
			.mockReturnValueOnce(0)
			.mockImplementation(() => {
				throw new Error("random failed");
			});
		const { recovery } = createRecovery({ maxElapsedMs: 2_000, random });
		expect(recovery.retry(error())).toBe(true);
		await vi.advanceTimersByTimeAsync(50);
		expect(recovery.retry(error())).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
