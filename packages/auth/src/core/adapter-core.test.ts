import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AuthApiError,
	type AuthError,
} from "../adapters/supabase/auth-interface";
import type { BetterAuthInstance } from "../types";
import { FORCE_FETCH_HEADER, NeonAuthAdapterCore } from "./adapter-core";

/**
 * Test harness that exposes the customFetchImpl from the abstract
 * NeonAuthAdapterCore so we can exercise its error-handling branches.
 */
class TestAdapter extends NeonAuthAdapterCore {
	getBetterAuthInstance(): BetterAuthInstance {
		return {} as BetterAuthInstance;
	}

	getCustomFetchImpl() {
		const fetchOptions = this.betterAuthOptions.fetchOptions as {
			customFetchImpl: (
				url: string | URL | Request,
				init?: RequestInit,
			) => Promise<Response>;
		};
		return fetchOptions.customFetchImpl;
	}
}

const TEST_URL = "https://auth.example.com/api/auth/sign-in/email";

describe("NeonAuthAdapterCore customFetchImpl error normalization", () => {
	const originalFetch = globalThis.fetch;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("main customFetchImpl branch", () => {
		test("throws AuthApiError with .status and .code when upstream returns JSON with code", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(
				Response.json(
					{
						message: "Invalid email or password",
						code: "INVALID_EMAIL_OR_PASSWORD",
					},
					{
						status: 401,
						statusText: "Unauthorized",
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			await expect(
				customFetchImpl(TEST_URL, { method: "POST" }),
			).rejects.toSatisfy((err: unknown) => {
				expect(err).toBeInstanceOf(AuthApiError);
				const apiErr = err as AuthApiError;
				expect(apiErr.status).toBe(401);
				expect(apiErr.code).toBe("invalid_credentials");
				return true;
			});
		});

		test("throws AuthError with a typed .code (not forged from .status) when upstream lacks code", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			// Body with no `code` field. Before the fix, the call site threw
			// `new Error(body.message)` with `.status` monkey-patched on, so
			// `.code` was undefined. After the fix, the helper maps to a typed
			// AuthErrorCode string — never numeric, never the HTTP status.
			fetchMock.mockResolvedValueOnce(
				Response.json(
					{ message: "Something went wrong" },
					{
						status: 418,
						statusText: "I'm a teapot",
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			let thrown: unknown;
			try {
				await customFetchImpl(TEST_URL, { method: "POST" });
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(Error);
			// `.code` is a typed string, never undefined or the stringified status.
			const code = (thrown as AuthError).code;
			expect(typeof code).toBe("string");
			expect(code).not.toBe("418");
			expect(code).not.toBe(String((thrown as AuthError).status));
		});

		test("thrown error is an AuthApiError instance (consumer narrowing works)", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(
				Response.json(
					{ message: "Nope" },
					{
						status: 401,
						statusText: "Unauthorized",
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			try {
				await customFetchImpl(TEST_URL, { method: "POST" });
				throw new Error("customFetchImpl should have thrown");
			} catch (error) {
				// Consumer pattern: `catch (err) { if (err instanceof AuthApiError) ... }`
				if (error instanceof AuthApiError) {
					expect(typeof error.status).toBe("number");
					expect(typeof error.code).toBe("string");
					expect(typeof error.message).toBe("string");
				} else {
					throw new Error(
						`Expected AuthApiError but got: ${error?.constructor?.name ?? typeof error}`,
					);
				}
			}
		});

		test("returns response untouched when upstream is 2xx", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(
				Response.json(
					{ user: { id: "u1" } },
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const result = await customFetchImpl(TEST_URL, { method: "POST" });
			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
		});
	});

	describe("force-fetch branch (X-Force-Fetch header)", () => {
		test("throws AuthApiError with .status and .code on non-2xx", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(
				Response.json(
					{
						message: "User already exists",
						code: "USER_ALREADY_EXISTS",
					},
					{
						status: 409,
						statusText: "Conflict",
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			let thrown: unknown;
			try {
				await customFetchImpl(TEST_URL, {
					method: "POST",
					headers: { [FORCE_FETCH_HEADER]: "1" },
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(AuthApiError);
			expect((thrown as AuthApiError).status).toBe(409);
			expect((thrown as AuthApiError).code).toBe("user_already_exists");
		});

		test("strips X-Force-Fetch header before sending", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(Response.json({}, { status: 200 }));

			await customFetchImpl(TEST_URL, {
				method: "GET",
				headers: { [FORCE_FETCH_HEADER]: "1" },
			});

			const callArgs = fetchMock.mock.calls[0];
			const sentInit = callArgs[1] as RequestInit;
			const sentHeaders = sentInit.headers as Headers;
			expect(sentHeaders.has(FORCE_FETCH_HEADER)).toBe(false);
		});
	});
});
