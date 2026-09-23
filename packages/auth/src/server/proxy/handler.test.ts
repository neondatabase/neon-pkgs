import { beforeEach, describe, expect, test, vi } from "vitest";
import * as cacheHandler from "../session/cache-handler";
import type { AuthProxyConfig } from "./handler";
import { handleAuthProxyRequest } from "./handler";
import * as request from "./request";
import * as response from "./response";

const TEST_SECRET = "test-secret-at-least-32-characters-long!";
const BASE_URL = "https://auth.example.com";
const TEST_BASE_URL = BASE_URL;

const createTestConfig = (
	overrides?: Partial<AuthProxyConfig>,
): AuthProxyConfig => ({
	request: new Request("https://app.com/api/auth/get-session"),
	path: "get-session",
	baseUrl: BASE_URL,
	cookieSecret: TEST_SECRET,
	...overrides,
});

describe("handleAuthProxyRequest", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	describe("session cache optimization", () => {
		test("returns cached response on cache hit for GET /get-session", async () => {
			const cachedResponse = Response.json({
				session: { id: "session-123" },
				user: { id: "user-123", email: "test@example.com" },
			});

			const trySessionCacheSpy = vi
				.spyOn(cacheHandler, "trySessionCache")
				.mockResolvedValue(cachedResponse);
			const handleAuthRequestSpy = vi.spyOn(request, "handleAuthRequest");

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/get-session", {
					method: "GET",
				}),
				path: "get-session",
			});

			const result = await handleAuthProxyRequest(config);

			expect(trySessionCacheSpy).toHaveBeenCalledWith(
				config.request,
				TEST_BASE_URL,
				{
					secret: TEST_SECRET,
					sessionDataTtl: undefined,
					domain: undefined,
					sameSite: undefined,
				},
				undefined,
			);
			expect(result).toBe(cachedResponse);
			// Should NOT call upstream on cache hit
			expect(handleAuthRequestSpy).not.toHaveBeenCalled();
		});

		test("calls upstream on cache miss for GET /get-session", async () => {
			const trySessionCacheSpy = vi
				.spyOn(cacheHandler, "trySessionCache")
				.mockResolvedValue(null);

			const upstreamResponse = Response.json(
				{ session: {}, user: {} },
				{
					status: 200,
				},
			);
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/get-session", {
					method: "GET",
				}),
				path: "get-session",
			});

			const result = await handleAuthProxyRequest(config);

			expect(trySessionCacheSpy).toHaveBeenCalled();
			expect(result).toBe(processedResponse);
		});

		test("skips cache for POST /get-session", async () => {
			const trySessionCacheSpy = vi.spyOn(
				cacheHandler,
				"trySessionCache",
			);

			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/get-session", {
					method: "POST",
				}),
				path: "get-session",
			});

			await handleAuthProxyRequest(config);

			// Should NOT try cache for POST requests
			expect(trySessionCacheSpy).not.toHaveBeenCalled();
		});

		test("skips cache for non-get-session endpoints", async () => {
			const trySessionCacheSpy = vi.spyOn(
				cacheHandler,
				"trySessionCache",
			);

			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/sign-in/email", {
					method: "POST",
				}),
				path: "sign-in/email",
			});

			await handleAuthProxyRequest(config);

			// Should NOT try cache for non-getSession endpoints
			expect(trySessionCacheSpy).not.toHaveBeenCalled();
		});
	});

	describe("upstream proxy", () => {
		test("calls handleAuthRequest with correct parameters", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			const handleAuthRequestSpy = vi
				.spyOn(request, "handleAuthRequest")
				.mockResolvedValue(upstreamResponse);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const testRequest = new Request(
				"https://app.com/api/auth/sign-in/email",
				{
					method: "POST",
					body: JSON.stringify({
						email: "test@example.com",
						password: "password",
					}),
				},
			);

			const config = createTestConfig({
				request: testRequest,
				path: "sign-in/email",
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthRequestSpy).toHaveBeenCalledWith(
				BASE_URL,
				testRequest,
				"sign-in/email",
				undefined,
			);
		});

		test("calls handleAuthResponse with correct cookie config", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(processedResponse);

			const config = createTestConfig({
				path: "sign-in/email",
				sessionDataTtl: 600,
				domain: ".example.com",
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthResponseSpy).toHaveBeenCalledWith(
				upstreamResponse,
				BASE_URL,
				{
					secret: TEST_SECRET,
					sessionDataTtl: 600,
					domain: ".example.com",
					sameSite: undefined,
				},
				undefined,
			);
		});

		test("returns processed response from handleAuthResponse", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("Processed", {
				status: 200,
			});

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({ path: "sign-out" });

			const result = await handleAuthProxyRequest(config);

			expect(result).toBe(processedResponse);
			expect(await result.text()).toBe("Processed");
		});
	});

	describe("cookie config forwarding", () => {
		test("forwards sessionDataTtl to response handler", async () => {
			vi.spyOn(cacheHandler, "trySessionCache").mockResolvedValue(null);

			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(processedResponse);

			const config = createTestConfig({
				path: "get-session",
				sessionDataTtl: 900,
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthResponseSpy).toHaveBeenCalledWith(
				upstreamResponse,
				BASE_URL,
				expect.objectContaining({
					sessionDataTtl: 900,
				}),
				undefined,
			);
		});

		test("forwards domain to response handler", async () => {
			vi.spyOn(cacheHandler, "trySessionCache").mockResolvedValue(null);

			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(processedResponse);

			const config = createTestConfig({
				path: "get-session",
				domain: ".custom-domain.com",
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthResponseSpy).toHaveBeenCalledWith(
				upstreamResponse,
				BASE_URL,
				expect.objectContaining({
					domain: ".custom-domain.com",
				}),
				undefined,
			);
		});

		test("works without optional config parameters", async () => {
			vi.spyOn(cacheHandler, "trySessionCache").mockResolvedValue(null);

			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(processedResponse);

			const config = createTestConfig({
				path: "get-session",
				// No sessionDataTtl or domain
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthResponseSpy).toHaveBeenCalledWith(
				upstreamResponse,
				BASE_URL,
				{
					secret: TEST_SECRET,
					sessionDataTtl: undefined,
					domain: undefined,
					sameSite: undefined,
				},
				undefined,
			);
		});
	});

	describe("various endpoints", () => {
		test("handles sign-in endpoint", async () => {
			const upstreamResponse = Response.json(
				{ session: {}, user: {} },
				{
					status: 200,
				},
			);
			const processedResponse = new Response("OK", { status: 200 });

			const handleAuthRequestSpy = vi
				.spyOn(request, "handleAuthRequest")
				.mockResolvedValue(upstreamResponse);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/sign-in/email", {
					method: "POST",
				}),
				path: "sign-in/email",
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthRequestSpy).toHaveBeenCalledWith(
				BASE_URL,
				config.request,
				"sign-in/email",
				undefined,
			);
		});

		test("handles sign-out endpoint", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			const processedResponse = new Response("OK", { status: 200 });

			const handleAuthRequestSpy = vi
				.spyOn(request, "handleAuthRequest")
				.mockResolvedValue(upstreamResponse);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/sign-out", {
					method: "POST",
				}),
				path: "sign-out",
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthRequestSpy).toHaveBeenCalledWith(
				BASE_URL,
				config.request,
				"sign-out",
				undefined,
			);
		});

		test("handles update-user endpoint", async () => {
			const upstreamResponse = Response.json(
				{ user: {} },
				{ status: 200 },
			);
			const processedResponse = new Response("OK", { status: 200 });

			const handleAuthRequestSpy = vi
				.spyOn(request, "handleAuthRequest")
				.mockResolvedValue(upstreamResponse);
			vi.spyOn(response, "handleAuthResponse").mockResolvedValue(
				processedResponse,
			);

			const config = createTestConfig({
				request: new Request("https://app.com/api/auth/update-user", {
					method: "POST",
				}),
				path: "update-user",
			});

			await handleAuthProxyRequest(config);

			expect(handleAuthRequestSpy).toHaveBeenCalledWith(
				BASE_URL,
				config.request,
				"update-user",
				undefined,
			);
		});
	});

	// Andras FIX 3 (DX): `AuthProxyConfig.log` must accept either a pre-resolved
	// sink or a partial `NeonAuthLogger` (the same shape adapters expose to
	// their own users), so adapters can forward `config.log` straight through
	// without a TS2322 error.
	describe("logger normalization", () => {
		test("forwards undefined when no log provided (silent downstream)", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(new Response("OK", { status: 200 }));

			await handleAuthProxyRequest(
				createTestConfig({ path: "sign-in/email" }),
			);

			expect(handleAuthResponseSpy).toHaveBeenCalledWith(
				upstreamResponse,
				BASE_URL,
				expect.any(Object),
				undefined,
			);
		});

		test("passes a pre-resolved sink through unchanged", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(new Response("OK", { status: 200 }));

			const preResolved = {
				error: vi.fn(),
				warn: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
			};

			await handleAuthProxyRequest(
				createTestConfig({ path: "sign-in/email", log: preResolved }),
			);

			const forwardedLog = handleAuthResponseSpy.mock.calls[0][3];
			expect(forwardedLog).toBe(preResolved);
		});

		test("normalizes a partial NeonAuthLogger into a resolved sink (all 4 methods callable)", async () => {
			const upstreamResponse = Response.json({}, { status: 200 });
			vi.spyOn(request, "handleAuthRequest").mockResolvedValue(
				upstreamResponse,
			);
			const handleAuthResponseSpy = vi
				.spyOn(response, "handleAuthResponse")
				.mockResolvedValue(new Response("OK", { status: 200 }));

			// Partial logger (only `warn`) — mimics an adapter forwarding the
			// public `log?: NeonAuthLogger` from its own config.
			const partial = { warn: vi.fn() };

			await handleAuthProxyRequest(
				createTestConfig({ path: "sign-in/email", log: partial }),
			);

			const forwardedLog = handleAuthResponseSpy.mock.calls[0][3] as {
				error: (m: string) => void;
				warn: (m: string) => void;
				info: (m: string) => void;
				debug: (m: string) => void;
			};
			expect(forwardedLog).toBeDefined();
			expect(forwardedLog).not.toBe(partial);
			expect(typeof forwardedLog.error).toBe("function");
			expect(typeof forwardedLog.warn).toBe("function");
			expect(typeof forwardedLog.info).toBe("function");
			expect(typeof forwardedLog.debug).toBe("function");
		});
	});
});
