import { describe, expect, test } from "vitest";
import { ErrorCode, PlatformError } from "./errors.js";
import {
	buildFunctionDeployForm,
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

describe("buildFunctionDeployForm", () => {
	const bundle = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

	test("matches the FunctionDeployRequest spec fields (zip / runtime / environment)", () => {
		const form = buildFunctionDeployForm({
			bundle,
			runtime: "nodejs24",
			environment: { RESEND_API_KEY: "re_abc", STRIPE: "sk_x" },
		});
		// Exactly the three spec fields — no legacy `file` / `concurrency`.
		expect([...form.keys()].sort()).toEqual([
			"environment",
			"runtime",
			"zip",
		]);
		expect(form.has("file")).toBe(false);
		expect(form.has("concurrency")).toBe(false);
		expect(form.get("runtime")).toBe("nodejs24");
		const zip = form.get("zip");
		expect(zip).toBeInstanceOf(Blob);
		expect((zip as Blob).type).toBe("application/zip");
	});

	test("encodes environment as a single JSON-encoded string map", () => {
		const form = buildFunctionDeployForm({
			bundle,
			runtime: "nodejs24",
			environment: { A: "1", B: "two" },
		});
		// Spec: `environment` is one JSON string, NOT bracketed `environment[A]` parts.
		expect(form.has("environment[A]")).toBe(false);
		expect(JSON.parse(form.get("environment") as string)).toEqual({
			A: "1",
			B: "two",
		});
	});

	test("omits the environment field entirely when there are no vars", () => {
		const form = buildFunctionDeployForm({
			bundle,
			runtime: "nodejs24",
			environment: {},
		});
		expect(form.has("environment")).toBe(false);
		expect([...form.keys()].sort()).toEqual(["runtime", "zip"]);
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
	test("503 with region-unavailable API body: points at aws-us-east-2 beta rollout", () => {
		const original = new PlatformError(ErrorCode.ServerError, "boom", {
			details: {
				status: 503,
				neonMessage:
					'platform service not available for this region; cell_id:"aws-us-east-1-cell-9"',
				requestId: "req-503-region",
			},
		});
		const wrapped = previewUnavailableError(
			original,
			"Object storage (buckets)",
		);
		expect(wrapped).toBeInstanceOf(PlatformError);
		if (!(wrapped instanceof PlatformError)) throw new Error("not wrapped");
		expect(wrapped.code).toBe(ErrorCode.FeatureUnavailable);
		expect(wrapped.message).toMatch(
			/Object storage \(buckets\) isn't available for this Neon project/,
		);
		expect(wrapped.message).toMatch(/HTTP 503 Service Unavailable/);
		expect(wrapped.message).toMatch(
			/platform service not available for this region/,
		);
		expect(wrapped.message).toMatch(/request id req-503-region/);
		expect(wrapped.message).toMatch(/currently in beta/);
		expect(wrapped.message).toMatch(/more regions are coming shortly/);
		expect(wrapped.message).toMatch(/aws-us-east-2/);
		expect(wrapped.message).not.toMatch(/private preview/);
		expect(wrapped.message).not.toMatch(/neonstatus\.com/);
		expect(wrapped.details.status).toBe(503);
		expect(wrapped.details.requestId).toBe("req-503-region");
	});

	test("503 with project-unavailable API body: points at aws-us-east-2 beta rollout", () => {
		const original = new PlatformError(ErrorCode.ServerError, "boom", {
			details: {
				status: 503,
				neonMessage:
					"platform functions not available for this project",
				requestId: "req-503",
			},
		});
		const wrapped = previewUnavailableError(original, "Functions");
		expect(wrapped).toBeInstanceOf(PlatformError);
		if (!(wrapped instanceof PlatformError)) throw new Error("not wrapped");
		expect(wrapped.code).toBe(ErrorCode.FeatureUnavailable);
		expect(wrapped.message).toMatch(
			/Functions isn't available for this Neon project/,
		);
		expect(wrapped.message).toMatch(/HTTP 503 Service Unavailable/);
		expect(wrapped.message).toMatch(
			/platform functions not available for this project/,
		);
		expect(wrapped.message).toMatch(/request id req-503/);
		expect(wrapped.message).toMatch(/currently in beta/);
		expect(wrapped.message).toMatch(/more regions are coming shortly/);
		expect(wrapped.message).toMatch(/aws-us-east-2/);
		expect(wrapped.message).not.toMatch(/neonstatus\.com/);
		expect(wrapped.details.status).toBe(503);
		expect(wrapped.details.requestId).toBe("req-503");
	});

	test("503 without region signal: incident guidance", () => {
		const original = new PlatformError(ErrorCode.ServerError, "boom", {
			details: {
				status: 503,
				neonMessage: "service not available",
				requestId: "req-503-transient",
			},
		});
		const wrapped = previewUnavailableError(original, "Functions");
		if (!(wrapped instanceof PlatformError)) throw new Error("not wrapped");
		expect(wrapped.message).toMatch(/incident/);
		expect(wrapped.message).toMatch(/neonstatus\.com/);
		expect(wrapped.message).not.toMatch(/aws-us-east-2/);
	});

	test("404: points at aws-us-east-2 beta rollout", () => {
		const original = new PlatformError(ErrorCode.NotFound, "boom", {
			details: { status: 404, neonMessage: "this route does not exist" },
		});
		const wrapped = previewUnavailableError(
			original,
			"Object storage (buckets)",
		);
		if (!(wrapped instanceof PlatformError)) throw new Error("not wrapped");
		expect(wrapped.code).toBe(ErrorCode.FeatureUnavailable);
		expect(wrapped.message).toMatch(/HTTP 404 Not Found/);
		expect(wrapped.message).toMatch(/currently in beta/);
		expect(wrapped.message).toMatch(/more regions are coming shortly/);
		expect(wrapped.message).toMatch(/aws-us-east-2/);
		expect(wrapped.message).not.toMatch(/private preview/);
		expect(wrapped.message).not.toMatch(/neonstatus\.com/);
		expect(wrapped.details.status).toBe(404);
	});

	test("passes a non-unavailable error through unchanged", () => {
		const original = new PlatformError(ErrorCode.Unauthorized, "nope", {
			details: { status: 401 },
		});
		expect(previewUnavailableError(original, "Functions")).toBe(original);
	});
});
