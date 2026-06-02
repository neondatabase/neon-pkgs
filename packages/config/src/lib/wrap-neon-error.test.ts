import { describe, expect, test } from "vitest";
import { ErrorCode, PlatformError } from "./errors.js";
import { wrapNeonError } from "./wrap-neon-error.js";

function axiosLike(
	status: number,
	body?: { message?: string; code?: string; request_id?: string },
): { response: { status: number; data?: object } } {
	const err: { response: { status: number; data?: object } } = {
		response: { status },
	};
	if (body) err.response.data = body;
	return err;
}

const CTX = { op: "getProject(proj-x)", projectId: "proj-x" } as const;

describe("wrapNeonError — HTTP status mapping", () => {
	test("401 → Unauthorized + key + neonctl-auth advice + request id", () => {
		const err = wrapNeonError(
			axiosLike(401, { message: "Invalid API key", request_id: "req-1" }),
			CTX,
		);
		expect(err).toBeInstanceOf(PlatformError);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.Unauthorized);
		// Message now suggests both fix paths since we accept both API keys and the
		// OAuth token written by `neonctl auth`.
		expect(p.message).toContain(
			"Bearer token sent to the Neon API was rejected",
		);
		expect(p.message).toContain(
			"https://console.neon.tech/app/settings/api-keys",
		);
		expect(p.message).toContain("neonctl auth");
		expect(p.message).toContain("req-1");
		expect(p.details.status).toBe(401);
		expect(p.details.requestId).toBe("req-1");
	});

	test("403 → Forbidden + project-scoped key explanation", () => {
		const err = wrapNeonError(
			axiosLike(403, {
				message: "not allowed for organization API keys",
			}),
			CTX,
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.Forbidden);
		expect(p.message).toContain(
			"Project-scoped keys can only operate on their own project",
		);
	});

	test("404 → NotFound + verifies project id when present", () => {
		const err = wrapNeonError(
			axiosLike(404, { message: "project not found" }),
			CTX,
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.NotFound);
		expect(p.message).toContain("project 'proj-x'");
	});

	test("409 → Conflict + name-collision hint", () => {
		const err = wrapNeonError(
			axiosLike(409, { message: "branch already exists" }),
			{
				op: "createBranch(proj-x/preview)",
			},
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.Conflict);
		expect(p.message).toContain("conflicting resource");
		expect(p.message).toContain("Pull first");
	});

	test("423 → Locked + retry-knob hint", () => {
		const err = wrapNeonError(
			axiosLike(423, { message: "operation in progress" }),
			CTX,
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.Locked);
		expect(p.message).toContain("retryOnLocked");
	});

	test("429 → RateLimited + support link", () => {
		const err = wrapNeonError(axiosLike(429), CTX);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.RateLimited);
		expect(p.message).toContain("rate-limited");
	});

	test("5xx → ServerError + status mention", () => {
		const err = wrapNeonError(
			axiosLike(503, { message: "service unavailable" }),
			CTX,
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.ServerError);
		expect(p.message).toContain("HTTP 503");
		expect(p.message).toContain("https://neonstatus.com");
	});

	test("unknown 4xx falls back to ServerError with raw status", () => {
		const err = wrapNeonError(
			axiosLike(418, { message: "I'm a teapot" }),
			CTX,
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.ServerError);
		expect(p.message).toContain("HTTP 418");
	});
});

describe("wrapNeonError — network errors", () => {
	test.each([
		["ECONNREFUSED", "Connection refused"],
		["ETIMEDOUT", "Operation timed out"],
		["ENOTFOUND", "DNS lookup failed"],
		["ECONNABORTED", "Request aborted"],
	])("%s → NetworkError with explanation", (code, message) => {
		const err = wrapNeonError(
			Object.assign(new Error(message), { code }),
			CTX,
		);
		const p = err as PlatformError;
		expect(p.code).toBe(ErrorCode.NetworkError);
		expect(p.message).toContain("Could not reach the Neon API");
		expect(p.message).toContain(message);
	});
});

describe("wrapNeonError — passthrough", () => {
	test("returns existing PlatformError unchanged (no double-wrapping)", () => {
		const original = new PlatformError(ErrorCode.InternalError, "test");
		expect(wrapNeonError(original, CTX)).toBe(original);
	});

	test("returns non-axios, non-network errors unchanged", () => {
		const original = new Error("plain error");
		expect(wrapNeonError(original, CTX)).toBe(original);
	});
});
