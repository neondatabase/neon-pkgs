import { beforeEach, describe, expect, test, vi } from "vitest";
import { createNeonApiFromOptions } from "./auth.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { createRealNeonApi } from "./neon-api-real.js";
import { stubCleanNeonEnv } from "./test-utils.js";

vi.mock("./neon-api-real.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./neon-api-real.js")>();
	return { ...actual, createRealNeonApi: vi.fn(() => ({}) as never) };
});

beforeEach(() => {
	stubCleanNeonEnv();
});

describe("createNeonApiFromOptions — the API key must be explicit", () => {
	const created = createRealNeonApi as unknown as ReturnType<typeof vi.fn>;

	test("builds an adapter from the apiKey option", () => {
		createNeonApiFromOptions("op", { apiKey: "napi_k" });
		expect(created).toHaveBeenCalledWith({ apiKey: "napi_k" });
	});

	test("trims whitespace around the key", () => {
		createNeonApiFromOptions("op", { apiKey: "  napi_k  " });
		expect(created).toHaveBeenCalledWith({ apiKey: "napi_k" });
	});

	test("throws MissingApiKey when no key is given", () => {
		expect(() => createNeonApiFromOptions("pushConfig")).toThrow(
			PlatformError,
		);
		try {
			createNeonApiFromOptions("pushConfig");
		} catch (err) {
			expect((err as PlatformError).code).toBe(ErrorCode.MissingApiKey);
			expect((err as PlatformError).message).toContain("pushConfig");
		}
		expect(created).not.toHaveBeenCalled();
	});

	test("throws when the key is whitespace-only", () => {
		expect(() => createNeonApiFromOptions("op", { apiKey: "   " })).toThrow(
			PlatformError,
		);
		expect(created).not.toHaveBeenCalled();
	});

	// The point of the package boundary: an ambient credential must not be picked up.
	// Resolving NEON_API_KEY is the caller's job (see packages/cli).
	test("ignores NEON_API_KEY in the environment", () => {
		vi.stubEnv("NEON_API_KEY", "napi_from_env");
		expect(() => createNeonApiFromOptions("fetchEnv")).toThrow(
			PlatformError,
		);
		expect(created).not.toHaveBeenCalled();
	});
});

describe("createNeonApiFromOptions — host resolution", () => {
	const created = createRealNeonApi as unknown as ReturnType<typeof vi.fn>;

	test("uses the explicit apiHost option", () => {
		createNeonApiFromOptions("op", {
			apiKey: "napi_k",
			apiHost: "https://opt.example/api/v2",
		});
		expect(created).toHaveBeenCalledWith({
			apiKey: "napi_k",
			baseUrl: "https://opt.example/api/v2",
		});
	});

	test("passes no baseUrl when the option is absent (prod default)", () => {
		createNeonApiFromOptions("op", { apiKey: "napi_k" });
		expect(created).toHaveBeenCalledWith({ apiKey: "napi_k" });
	});

	test("normalizes trailing slashes and surrounding whitespace", () => {
		createNeonApiFromOptions("op", {
			apiKey: "napi_k",
			apiHost: "  https://opt.example/api/v2/  ",
		});
		expect(created).toHaveBeenCalledWith({
			apiKey: "napi_k",
			baseUrl: "https://opt.example/api/v2",
		});
	});

	test("treats an empty / whitespace apiHost as unset", () => {
		createNeonApiFromOptions("op", { apiKey: "napi_k", apiHost: "   " });
		expect(created).toHaveBeenCalledWith({ apiKey: "napi_k" });
	});

	test("ignores NEON_API_HOST in the environment", () => {
		vi.stubEnv("NEON_API_HOST", "https://env.example/api/v2");
		createNeonApiFromOptions("op", { apiKey: "napi_k" });
		expect(created).toHaveBeenCalledWith({ apiKey: "napi_k" });
	});
});
