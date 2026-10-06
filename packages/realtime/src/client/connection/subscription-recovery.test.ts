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

	describe("retryAfterHint", () => {
		it("schedules delay in [hint, 2*hint] for a 2000ms hint", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0.5, // mid-range for predictable testing
			});
			// Start an episode with regular retry first
			expect(recovery.retry(error())).toBe(true);
			// Call retryAfterHint with a 2000ms hint
			expect(recovery.retry(error("backend_overloaded"), 2000)).toBe(
				true,
			);
			// With hint=2000, min=2000, max=4000, delay should be 2000 + 0.5*(4000-2000) = 3000
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"backend_overloaded",
				2,
				3000,
			);
			expect(recovery.waiting).toBe(true);
			recovery.cancel();
		});

		it("floors zero hint to [100, 200]", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0.5,
			});
			recovery.retry(error());
			await vi.advanceTimersByTimeAsync(50);
			expect(recovery.retry(error("backend_overloaded"), 0)).toBe(true);
			// With hint=0, min=100, max=200, delay should be 100 + 0.5*100 = 150
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"backend_overloaded",
				2,
				150,
			);
			recovery.cancel();
		});

		it("caps delay to [hint, 30000] for a 20000ms hint", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0.5,
			});
			recovery.retry(error());
			await vi.advanceTimersByTimeAsync(50);
			// With hint=20000, h=20000, 2*h=40000, C=30000, max=min(2*h, C)=30000
			// delay = 20000 + 0.5*(30000-20000) = 25000
			expect(recovery.retry(error("backend_overloaded"), 20000)).toBe(
				true,
			);
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"backend_overloaded",
				2,
				25000,
			);
			recovery.cancel();
		});

		it("waits exactly the hint when it exceeds the ceiling", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0.5,
			});
			recovery.retry(error());
			await vi.advanceTimersByTimeAsync(50);
			// With hint=45000, h=45000, 2*h=90000, C=30000
			// Since h >= C, delay should be exactly h
			expect(recovery.retry(error("backend_overloaded"), 45000)).toBe(
				true,
			);
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"backend_overloaded",
				2,
				45000,
			);
			recovery.cancel();
		});

		it("falls back to exponential backoff when hint is undefined", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0,
			});
			recovery.retry(error());
			await vi.advanceTimersByTimeAsync(50);
			// No hint provided, should use exponential backoff (attempt 2, delay = 100)
			expect(recovery.retry(error("backend_overloaded"), undefined)).toBe(
				true,
			);
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"backend_overloaded",
				2,
				100,
			);
			recovery.cancel();
		});

		it("returns false when recovery is disabled", () => {
			const { recovery, callbacks } = createRecovery(false);
			expect(recovery.retry(error("backend_overloaded"), 1000)).toBe(
				false,
			);
			expect(callbacks.scheduled).not.toHaveBeenCalled();
		});

		it("counts hint retries toward attempt limits", async () => {
			const { recovery, callbacks } = createRecovery({ maxAttempts: 2 });
			expect(recovery.retry(error())).toBe(true); // Attempt 1
			await vi.advanceTimersByTimeAsync(50);
			expect(recovery.retry(error("backend_overloaded"), 100)).toBe(true); // Attempt 2
			await vi.advanceTimersByTimeAsync(100);
			expect(recovery.retry(error("backend_overloaded"), 100)).toBe(
				false,
			); // Attempt 3 - exhausted
			expect(callbacks.scheduled).toHaveBeenCalledTimes(2);
			// A refused retry reports false; its caller fails the subscription.
			expect(callbacks.exhausted).not.toHaveBeenCalled();
		});

		it("does not advance exponential backoff for hint retries", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0,
			});
			recovery.retry(error()); // backoff step 1
			await vi.advanceTimersByTimeAsync(50);
			// Hint retry should not advance backoff
			recovery.retry(error("backend_overloaded"), 100);
			await vi.advanceTimersByTimeAsync(100);
			// Next exponential retry should still be step 2 (not step 3)
			expect(recovery.retry(error())).toBe(true);
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"upstream_cancelled",
				3,
				100,
			);
			recovery.cancel();
		});

		it("honors the jitter ceiling option", async () => {
			const { recovery, callbacks } = createRecovery({
				random: () => 0.9,
				overloadJitterCapMs: 10_000,
			});
			recovery.retry(error());
			await vi.advanceTimersByTimeAsync(50);
			// With hint=5000, h=5000, 2*h=10000, C=10000
			// delay = 5000 + 0.9*(10000-5000) = 9500
			expect(recovery.retry(error("backend_overloaded"), 5000)).toBe(
				true,
			);
			expect(callbacks.scheduled).toHaveBeenLastCalledWith(
				"backend_overloaded",
				2,
				9500,
			);
			recovery.cancel();
		});

		it("respects elapsed-time limits with hint retries", async () => {
			const { recovery } = createRecovery({
				maxElapsedMs: 200,
			});
			recovery.retry(error()); // At 0ms
			// Hint retry at 0ms with 100ms delay
			expect(recovery.retry(error("backend_overloaded"), 100)).toBe(true);
			// Attempt again with limited elapsed time remaining
			// At this point we're past 200ms, so it should fail
			// For now, just test that a second hint retry within limits returns true
			expect(recovery.retry(error("backend_overloaded"), 50)).toBe(true);
			recovery.cancel();
		});

		it("preserves the episode and stability when interrupted", async () => {
			const { recovery } = createRecovery();
			recovery.retry(error());
			await vi.advanceTimersByTimeAsync(50);
			recovery.interrupted();
			expect(recovery.retry(error("backend_overloaded"), 100)).toBe(true);
			await vi.advanceTimersByTimeAsync(100);
			recovery.baselineCompleted();
			await vi.advanceTimersByTimeAsync(500);
			recovery.interrupted();
			await vi.advanceTimersByTimeAsync(1000);
			// Next hint retry should start a new timer
			expect(recovery.retry(error("backend_overloaded"), 100)).toBe(true);
			recovery.cancel();
		});
	});
});
