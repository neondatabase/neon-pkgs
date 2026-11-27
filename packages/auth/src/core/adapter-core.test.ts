import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AuthApiError,
	type AuthError,
} from "../adapters/supabase/auth-interface";
import type { BetterAuthInstance } from "../types";
import { FORCE_FETCH_HEADER, NeonAuthAdapterCore } from "./adapter-core";
import type { AuthHttpError } from "./better-auth-helpers";

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
			expect((thrown as AuthHttpError).error).toEqual({
				message: "User already exists",
				code: "USER_ALREADY_EXISTS",
				status: 409,
			});
			expect((thrown as AuthHttpError).statusText).toBe("Conflict");
		});

		test("a non-JSON 502 body yields an empty .error body, statusText and an HTTP message", async () => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(
				new Response("<html>Bad Gateway</html>", {
					status: 502,
					statusText: "Bad Gateway",
					headers: { "Content-Type": "text/html" },
				}),
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

			const error = thrown as AuthHttpError;
			expect(error).toBeInstanceOf(AuthApiError);
			expect(error.error).toEqual({ status: 502 });
			expect(error.statusText).toBe("Bad Gateway");
			expect(error.message).toMatch(/HTTP 502/);
		});

		test.each([
			["a JSON array body", "[1,2]"],
			["a JSON string body", '"oops"'],
		])("%s yields only the raw status in .error", async (_name, payload) => {
			const adapter = new TestAdapter({
				baseURL: "https://auth.example.com",
			});
			const customFetchImpl = adapter.getCustomFetchImpl();

			fetchMock.mockResolvedValueOnce(
				new Response(payload, {
					status: 500,
					statusText: "Internal Server Error",
					headers: { "Content-Type": "application/json" },
				}),
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

			expect((thrown as AuthHttpError).error).toEqual({ status: 500 });
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

describe("NeonAuthAdapterCore get-session verifier cleanup", () => {
	const GET_SESSION_URL = "https://auth.example.com/api/auth/get-session";
	const VERIFIER = "neon_auth_session_verifier";
	let fetchMock: ReturnType<typeof vi.fn>;
	let replaceState: ReturnType<typeof vi.fn>;

	function stubBrowserAt(href: string) {
		replaceState = vi.fn();
		vi.stubGlobal("window", {
			location: { href, search: new URL(href).search },
		});
		vi.stubGlobal("document", {});
		vi.stubGlobal("history", { state: { k: 1 }, replaceState });
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test.each([
		[401, "LINK_SESSION_NOT_FOUND"],
		[403, "LINK_SESSION_MISMATCH"],
		[400, "VERIFICATION_NOT_FOUND"],
	])("strips the verifier from the page URL after a %i get-session", async (status, code) => {
		stubBrowserAt(
			`https://app.example.com/settings?${VERIFIER}=lk.abc&tab=accounts`,
		);
		fetchMock.mockResolvedValueOnce(
			Response.json({ code, message: "link failed" }, { status }),
		);
		const customFetchImpl = new TestAdapter({
			baseURL: "https://auth.example.com",
		}).getCustomFetchImpl();

		await expect(
			customFetchImpl(`${GET_SESSION_URL}?${VERIFIER}=lk.abc`, {
				method: "GET",
			}),
		).rejects.toBeDefined();

		expect(replaceState).toHaveBeenCalledTimes(1);
		expect(replaceState).toHaveBeenCalledWith(
			{ k: 1 },
			"",
			"https://app.example.com/settings?tab=accounts",
		);
	});

	test("strips the verifier after a force-fetched get-session fails", async () => {
		stubBrowserAt(`https://app.example.com/?${VERIFIER}=lk.abc`);
		fetchMock.mockResolvedValueOnce(
			Response.json({ code: "VERIFICATION_NOT_FOUND" }, { status: 400 }),
		);
		const customFetchImpl = new TestAdapter({
			baseURL: "https://auth.example.com",
		}).getCustomFetchImpl();

		await expect(
			customFetchImpl(`${GET_SESSION_URL}?${VERIFIER}=lk.abc`, {
				method: "GET",
				headers: { [FORCE_FETCH_HEADER]: "true" },
			}),
		).rejects.toBeDefined();

		expect(replaceState).toHaveBeenCalledWith(
			{ k: 1 },
			"",
			"https://app.example.com/",
		);
	});

	test("strips the verifier after a successful get-session", async () => {
		stubBrowserAt(`https://app.example.com/dashboard?${VERIFIER}=v1`);
		fetchMock.mockResolvedValueOnce(
			Response.json({ session: null, user: null }, { status: 200 }),
		);
		const customFetchImpl = new TestAdapter({
			baseURL: "https://auth.example.com",
		}).getCustomFetchImpl();

		await customFetchImpl(`${GET_SESSION_URL}?${VERIFIER}=v1`, {
			method: "GET",
		});

		expect(replaceState).toHaveBeenCalledWith(
			{ k: 1 },
			"",
			"https://app.example.com/dashboard",
		);
	});

	test("leaves the page URL alone when the get-session did not carry a verifier", async () => {
		stubBrowserAt(`https://app.example.com/dashboard?${VERIFIER}=v1`);
		fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
		const customFetchImpl = new TestAdapter({
			baseURL: "https://auth.example.com",
		}).getCustomFetchImpl();

		await expect(
			customFetchImpl(`${GET_SESSION_URL}?disableRefresh=true`, {
				method: "GET",
			}),
		).rejects.toBeDefined();

		expect(replaceState).not.toHaveBeenCalled();
	});

	test.each([
		500, 502, 503, 429, 408, 425,
	])("keeps the verifier after a transient %i get-session", async (status) => {
		stubBrowserAt(`https://app.example.com/dashboard?${VERIFIER}=v1`);
		fetchMock.mockResolvedValueOnce(Response.json({}, { status }));
		const customFetchImpl = new TestAdapter({
			baseURL: "https://auth.example.com",
		}).getCustomFetchImpl();

		await expect(
			customFetchImpl(`${GET_SESSION_URL}?${VERIFIER}=v1&s=${status}`, {
				method: "GET",
			}),
		).rejects.toBeDefined();

		expect(replaceState).not.toHaveBeenCalled();
	});

	test.each([
		[
			"a plain-text 401",
			() => new Response("Unauthorized", { status: 401 }),
		],
		["a 401 without a code", () => Response.json({}, { status: 401 })],
		[
			"a 403 with an unrelated code",
			() => Response.json({ code: "FORBIDDEN" }, { status: 403 }),
		],
	])("keeps the verifier after %s", async (label, make) => {
		stubBrowserAt(`https://app.example.com/dashboard?${VERIFIER}=v1`);
		fetchMock.mockResolvedValueOnce(make());
		const customFetchImpl = new TestAdapter({
			baseURL: "https://auth.example.com",
		}).getCustomFetchImpl();

		await expect(
			customFetchImpl(
				`${GET_SESSION_URL}?${VERIFIER}=v1&case=${encodeURIComponent(label)}`,
				{ method: "GET" },
			),
		).rejects.toBeDefined();

		expect(replaceState).not.toHaveBeenCalled();
	});
});
