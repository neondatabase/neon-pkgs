import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRateLimitRetry } from "./helpers.js";

describe("withRateLimitRetry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the first success", async () => {
		await expect(withRateLimitRetry(async () => 1)).resolves.toBe(1);
	});

	it("rethrows a non-quota error immediately", async () => {
		await expect(
			withRateLimitRetry(async () => {
				throw new Error("not a quota error");
			}),
		).rejects.toThrow("not a quota error");
	});

	it("retries once after REQUEST_LIMIT_EXCEEDED and a 60s wait", async () => {
		let calls = 0;
		const pending = withRateLimitRetry(async () => {
			calls += 1;
			if (calls === 1) {
				throw new Error(
					"Failed after 3 attempts. Last error: REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit",
				);
			}
			return "ok";
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(pending).resolves.toBe("ok");
		expect(calls).toBe(2);
	});

	it("does not retry a second REQUEST_LIMIT_EXCEEDED", async () => {
		const pending = withRateLimitRetry(async () => {
			throw new Error("REQUEST_LIMIT_EXCEEDED");
		});
		const assertion = expect(pending).rejects.toThrow(
			"REQUEST_LIMIT_EXCEEDED",
		);
		await vi.advanceTimersByTimeAsync(60_000);
		await assertion;
	});
});
