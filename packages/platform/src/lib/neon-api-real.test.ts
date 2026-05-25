import { describe, expect, test } from "vitest";
import { createNeonAuthRestInput, retryOnLocked } from "./neon-api-real.js";

const FAST_CONFIG = { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 4 };

describe("retryOnLocked", () => {
	test("returns the value when the call succeeds on the first try", async () => {
		let calls = 0;
		const result = await retryOnLocked(async () => {
			calls += 1;
			return "ok";
		}, FAST_CONFIG);
		expect(result).toBe("ok");
		expect(calls).toBe(1);
	});

	test("retries on HTTP 423 and eventually succeeds", async () => {
		let calls = 0;
		const result = await retryOnLocked(async () => {
			calls += 1;
			if (calls < 3) {
				throw Object.assign(new Error("locked"), {
					response: { status: 423 },
				});
			}
			return "after-retries";
		}, FAST_CONFIG);
		expect(result).toBe("after-retries");
		expect(calls).toBe(3);
	});

	test("does not retry on non-423 errors", async () => {
		let calls = 0;
		await expect(
			retryOnLocked(async () => {
				calls += 1;
				throw Object.assign(new Error("bad request"), {
					response: { status: 400 },
				});
			}, FAST_CONFIG),
		).rejects.toMatchObject({ message: "bad request" });
		expect(calls).toBe(1);
	});

	test("rethrows the last 423 after maxAttempts", async () => {
		let calls = 0;
		await expect(
			retryOnLocked(async () => {
				calls += 1;
				throw Object.assign(new Error("still locked"), {
					response: { status: 423 },
				});
			}, FAST_CONFIG),
		).rejects.toMatchObject({ message: "still locked" });
		expect(calls).toBe(FAST_CONFIG.maxAttempts);
	});
});

describe("createNeonAuthRestInput", () => {
	test("uses the documented Better Auth provider value", () => {
		expect(createNeonAuthRestInput({})).toEqual({
			auth_provider: "better_auth",
		});
	});

	test("includes the database name when one is selected", () => {
		expect(createNeonAuthRestInput({ databaseName: "app" })).toEqual({
			auth_provider: "better_auth",
			database_name: "app",
		});
	});
});
