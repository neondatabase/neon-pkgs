import { describe, expect, test } from "vitest";
import { ErrorCode, PlatformError } from "./errors.js";
import {
	createNeonAuthRestInput,
	isPreviewFeatureUnavailable,
	previewUnavailableError,
	readJsonBody,
	retryOnLocked,
} from "./neon-api-real.js";

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

describe("readJsonBody", () => {
	test("parses a JSON body", async () => {
		await expect(
			readJsonBody(new Response('{"message":"hi"}')),
		).resolves.toEqual({ message: "hi" });
	});

	test("returns {} for an empty body", async () => {
		await expect(readJsonBody(new Response(""))).resolves.toEqual({});
	});

	test("wraps a non-JSON body as { message } instead of throwing", async () => {
		// A real Neon 404 for a Preview route returns this plain-text body.
		await expect(
			readJsonBody(new Response("this route does not exist")),
		).resolves.toEqual({ message: "this route does not exist" });
	});
});

describe("isPreviewFeatureUnavailable", () => {
	const platformError = (
		code: string,
		details: Record<string, unknown>,
	): PlatformError => new PlatformError(code, "boom", { details });

	test("true for a 404 'this route does not exist' (route not deployed)", () => {
		expect(
			isPreviewFeatureUnavailable(
				platformError(ErrorCode.NotFound, {
					status: 404,
					neonMessage: "this route does not exist",
				}),
			),
		).toBe(true);
	});

	test("false for a plain 404 without an unavailability message (feature exists, not enabled)", () => {
		expect(
			isPreviewFeatureUnavailable(
				platformError(ErrorCode.NotFound, { status: 404 }),
			),
		).toBe(false);
	});

	test("true for a 503 'not available for this project'", () => {
		expect(
			isPreviewFeatureUnavailable(
				platformError(ErrorCode.ServerError, {
					status: 503,
					neonMessage:
						"platform functions not available for this project",
				}),
			),
		).toBe(true);
	});

	test("false for a 503 without an unavailability message (real transient error)", () => {
		expect(
			isPreviewFeatureUnavailable(
				platformError(ErrorCode.ServerError, {
					status: 503,
					neonMessage: "internal error",
				}),
			),
		).toBe(false);
	});

	test("false for unrelated errors", () => {
		expect(isPreviewFeatureUnavailable(new Error("nope"))).toBe(false);
		expect(
			isPreviewFeatureUnavailable(
				platformError(ErrorCode.Unauthorized, { status: 401 }),
			),
		).toBe(false);
	});
});

describe("previewUnavailableError", () => {
	test("wraps an unavailable error with a clear FeatureUnavailable message", () => {
		const original = new PlatformError(ErrorCode.ServerError, "boom", {
			details: {
				status: 503,
				neonMessage:
					"platform functions not available for this project",
			},
		});
		const wrapped = previewUnavailableError(original, "Functions");
		expect(wrapped).toBeInstanceOf(PlatformError);
		if (!(wrapped instanceof PlatformError)) throw new Error("not wrapped");
		expect(wrapped.code).toBe(ErrorCode.FeatureUnavailable);
		expect(wrapped.message).toMatch(/Functions is a Preview feature/);
		expect(wrapped.message).toMatch(/not available for this project/);
	});

	test("passes a non-unavailable error through unchanged", () => {
		const original = new PlatformError(ErrorCode.Unauthorized, "nope", {
			details: { status: 401 },
		});
		expect(previewUnavailableError(original, "Functions")).toBe(original);
	});
});
