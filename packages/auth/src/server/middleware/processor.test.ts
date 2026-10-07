import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedNeonAuthLogging } from "../logger";
import * as proxyHandler from "../proxy/handler";
import * as oauth from "./oauth";
import type { AuthMiddlewareConfig } from "./processor";
import { processAuthMiddleware } from "./processor";
import * as routeProtection from "./route-protection";

const TEST_SECRET = "test-secret-at-least-32-characters-long!";
const BASE_URL = "https://auth.example.com";
const LOGIN_URL = "/auth/sign-in";

const createTestConfig = (
	overrides?: Partial<AuthMiddlewareConfig>,
): AuthMiddlewareConfig => ({
	request: new Request("https://app.com/dashboard"),
	pathname: "/dashboard",
	skipRoutes: ["/api/auth", "/public"],
	loginUrl: LOGIN_URL,
	baseUrl: BASE_URL,
	cookieSecret: TEST_SECRET,
	...overrides,
});

describe("processAuthMiddleware", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	describe("login URL handling", () => {
		test("allows access to login URL without session check", async () => {
			const config = createTestConfig({
				request: new Request("https://app.com/auth/sign-in"),
				pathname: LOGIN_URL,
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
		});

		test("allows access to login subpaths", async () => {
			const config = createTestConfig({
				request: new Request("https://app.com/auth/sign-in/email"),
				pathname: "/auth/sign-in/email",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
		});

		test("allows login subpaths when loginUrl has a trailing slash", async () => {
			const config = createTestConfig({
				loginUrl: "/auth/sign-in/",
				request: new Request("https://app.com/auth/sign-in/email"),
				pathname: "/auth/sign-in/email",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
		});

		test("does not allow a local same-path route for an external login URL", async () => {
			const config = createTestConfig({
				loginUrl: "https://identity.example.com/auth/sign-in",
				request: new Request("https://app.com/auth/sign-in"),
				pathname: "/auth/sign-in",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
		});

		test("does not allow sibling paths sharing the login path prefix", async () => {
			const config = createTestConfig({
				request: new Request("https://app.com/auth/sign-in-admin"),
				pathname: "/auth/sign-in-admin",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
		});
	});

	describe("OAuth flow", () => {
		test("redirects with cookies on successful OAuth exchange", async () => {
			const mockRedirectUrl = new URL("https://app.com/dashboard");
			const mockCookies = ["session_token=abc", "session_data=xyz"];

			vi.spyOn(oauth, "exchangeOAuthToken").mockResolvedValue({
				redirectUrl: mockRedirectUrl,
				cookies: mockCookies,
				success: true,
			});

			const config = createTestConfig({
				request: new Request(
					"https://app.com/dashboard?neon_auth_session_verifier=verifier",
					{
						headers: {
							Cookie: "__Secure-neon-auth.session_challange=challenge",
						},
					},
				),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_oauth");
			if (result.action === "redirect_oauth") {
				expect(result.redirectUrl).toBe(mockRedirectUrl);
				expect(result.cookies).toEqual(mockCookies);
			}
		});

		test("continues to session check when OAuth exchange returns null", async () => {
			vi.spyOn(oauth, "exchangeOAuthToken").mockResolvedValue(null);
			vi.spyOn(routeProtection, "checkSessionRequired").mockReturnValue({
				allowed: false,
				requiresRedirect: true,
			});

			const config = createTestConfig();

			const result = await processAuthMiddleware(config);

			// Should continue to session check, not return early
			expect(result.action).toBe("redirect_login");
		});

		test("skips OAuth flow when verification not needed", async () => {
			const exchangeSpy = vi.spyOn(oauth, "exchangeOAuthToken");

			const config = createTestConfig();
			await processAuthMiddleware(config);

			expect(exchangeSpy).not.toHaveBeenCalled();
		});
	});

	describe("session handling", () => {
		test("skips upstream call when session cookie is missing", async () => {
			const handleAuthProxyRequestSpy = vi.spyOn(
				proxyHandler,
				"handleAuthProxyRequest",
			);

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard"),
			});

			await processAuthMiddleware(config);

			// Should NOT call handleAuthProxyRequest when no session cookie
			expect(handleAuthProxyRequestSpy).not.toHaveBeenCalled();
		});

		test("calls handleAuthProxyRequest when session cookie is present", async () => {
			const sessionResponse = Response.json({
				session: { id: "session-123" },
				user: { id: "user-123" },
			});

			const handleAuthProxyRequestSpy = vi
				.spyOn(proxyHandler, "handleAuthProxyRequest")
				.mockResolvedValue(sessionResponse);

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			await processAuthMiddleware(config);

			expect(handleAuthProxyRequestSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					// The lookup uses a normalized GET clone, not the original instance.
					request: expect.any(Request),
					path: "get-session",
					baseUrl: BASE_URL,
					cookieSecret: TEST_SECRET,
					sessionDataTtl: undefined,
					domain: undefined,
					sameSite: undefined,
					log: expect.any(Object),
				}),
			);
		});

		test("normalizes non-GET requests (e.g. Server Action POST) to a GET session lookup", async () => {
			const sessionResponse = Response.json({
				session: { id: "session-123" },
				user: { id: "user-123" },
			});

			const handleAuthProxyRequestSpy = vi
				.spyOn(proxyHandler, "handleAuthProxyRequest")
				.mockResolvedValue(sessionResponse);

			// Simulate a Next.js Server Action: a POST to the current (protected)
			// page, carrying body-framing headers like a real form submission.
			const config = createTestConfig({
				request: new Request("https://app.com/account/settings", {
					method: "POST",
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
						"Content-Type": "multipart/form-data; boundary=----x",
						"Content-Length": "128",
					},
					body: "noop",
				}),
				pathname: "/account/settings",
			});

			const result = await processAuthMiddleware(config);

			// The session lookup must use GET so the upstream get-session call (and
			// cookie-cache fast path) work; otherwise an authenticated user would be
			// redirected to login.
			const passedRequest =
				handleAuthProxyRequestSpy.mock.calls[0][0].request;
			expect(passedRequest.method).toBe("GET");
			// A fresh clone, not the original POST request.
			expect(passedRequest).not.toBe(config.request);
			// Cookies/headers preserved...
			expect(passedRequest.headers.get("Cookie")).toBe(
				"__Secure-neon-auth.session_token=token-value",
			);
			// ...but body-framing headers stripped from the body-less GET.
			expect(passedRequest.headers.get("Content-Type")).toBeNull();
			expect(passedRequest.headers.get("Content-Length")).toBeNull();
			expect(result.action).toBe("allow");
		});

		test("issues a fresh GET lookup request even when the incoming request is GET", async () => {
			const handleAuthProxyRequestSpy = vi
				.spyOn(proxyHandler, "handleAuthProxyRequest")
				.mockResolvedValue(
					Response.json({ session: { id: "s" }, user: { id: "u" } }),
				);

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			await processAuthMiddleware(config);

			// The lookup is always a fresh GET request (uniform regardless of method),
			// never the original instance, with cookies preserved.
			const passedRequest =
				handleAuthProxyRequestSpy.mock.calls[0][0].request;
			expect(passedRequest).not.toBe(config.request);
			expect(passedRequest.method).toBe("GET");
			expect(passedRequest.headers.get("Cookie")).toBe(
				"__Secure-neon-auth.session_token=token-value",
			);
		});

		test("forwards pre-resolved log sink to handleAuthProxyRequest", async () => {
			const mockLog: ResolvedNeonAuthLogging = {
				error: vi.fn(),
				warn: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
			};

			const handleAuthProxyRequestSpy = vi
				.spyOn(proxyHandler, "handleAuthProxyRequest")
				.mockResolvedValue(
					Response.json({ session: null, user: null }),
				);

			vi.spyOn(routeProtection, "checkSessionRequired").mockReturnValue({
				allowed: true,
				requiresRedirect: false,
			});

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
				log: mockLog,
			});

			await processAuthMiddleware(config);

			expect(handleAuthProxyRequestSpy).toHaveBeenCalledWith(
				expect.objectContaining({ log: mockLog }),
			);
		});

		test("passes session data to checkSessionRequired", async () => {
			const sessionData = {
				session: { id: "session-123" },
				user: { id: "user-123", email: "test@example.com" },
			};

			const sessionResponse = Response.json(sessionData);

			vi.spyOn(proxyHandler, "handleAuthProxyRequest").mockResolvedValue(
				sessionResponse,
			);
			const checkSessionRequiredSpy = vi
				.spyOn(routeProtection, "checkSessionRequired")
				.mockReturnValue({ allowed: true, requiresRedirect: false });

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			await processAuthMiddleware(config);

			expect(checkSessionRequiredSpy).toHaveBeenCalledWith(
				"/dashboard",
				["/api/auth", "/public"],
				LOGIN_URL,
				sessionData,
			);
		});

		test("handles failed session response gracefully", async () => {
			const sessionResponse = new Response("Unauthorized", {
				status: 401,
			});

			vi.spyOn(proxyHandler, "handleAuthProxyRequest").mockResolvedValue(
				sessionResponse,
			);
			const checkSessionRequiredSpy = vi
				.spyOn(routeProtection, "checkSessionRequired")
				.mockReturnValue({ allowed: false, requiresRedirect: true });

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			await processAuthMiddleware(config);

			// Should pass null session data on failed response
			expect(checkSessionRequiredSpy).toHaveBeenCalledWith(
				"/dashboard",
				["/api/auth", "/public"],
				LOGIN_URL,
				{ session: null, user: null },
			);
		});

		test("handles JSON parse errors gracefully", async () => {
			const sessionResponse = new Response("Invalid JSON", {
				status: 200,
			});

			vi.spyOn(proxyHandler, "handleAuthProxyRequest").mockResolvedValue(
				sessionResponse,
			);
			const checkSessionRequiredSpy = vi
				.spyOn(routeProtection, "checkSessionRequired")
				.mockReturnValue({ allowed: false, requiresRedirect: true });

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			await processAuthMiddleware(config);

			// Should pass null session data on parse error
			expect(checkSessionRequiredSpy).toHaveBeenCalledWith(
				"/dashboard",
				["/api/auth", "/public"],
				LOGIN_URL,
				{ session: null, user: null },
			);
		});
	});

	describe("route protection", () => {
		beforeEach(() => {
			vi.resetAllMocks();
		});

		test("allows access when session is valid", async () => {
			const sessionData = {
				session: { id: "session-123" },
				user: { id: "user-123" },
			};

			vi.spyOn(proxyHandler, "handleAuthProxyRequest").mockResolvedValue(
				Response.json(sessionData),
			);
			vi.spyOn(routeProtection, "checkSessionRequired").mockReturnValue({
				allowed: true,
				requiresRedirect: false,
			});

			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
		});

		test("adds middleware header on allow", async () => {
			vi.spyOn(proxyHandler, "handleAuthProxyRequest").mockResolvedValue(
				Response.json({}),
			);
			const config = createTestConfig({
				request: new Request("https://app.com/dashboard", {
					headers: {
						Cookie: "__Secure-neon-auth.session_token=token-value",
					},
				}),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
			if (result.action === "allow") {
				expect(result.headers).toEqual({
					"x-neon-auth-middleware": "true",
				});
			}
		});

		test("redirects to login when session required but missing", async () => {
			const config = createTestConfig({
				request: new Request("https://app.com/dashboard"),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
			if (result.action === "redirect_login") {
				expect(result.redirectUrl.pathname).toBe(LOGIN_URL);
				expect(result.redirectUrl.origin).toBe("https://app.com");
			}
		});

		test("preserves request query parameters when redirecting to login", async () => {
			const config = createTestConfig({
				request: new Request(
					"https://app.com/dashboard?neon_auth_session_verifier=verifier&source=oauth&tag=a&tag=b",
				),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
			if (result.action === "redirect_login") {
				expect(result.redirectUrl.pathname).toBe(LOGIN_URL);
				expect(
					result.redirectUrl.searchParams.get(
						"neon_auth_session_verifier",
					),
				).toBe("verifier");
				expect(result.redirectUrl.searchParams.get("source")).toBe(
					"oauth",
				);
				expect(result.redirectUrl.searchParams.getAll("tag")).toEqual([
					"a",
					"b",
				]);
			}
		});

		test("keeps configured login parameters and appends only non-colliding request parameters", async () => {
			const config = createTestConfig({
				loginUrl: "/auth/sign-in?source=configured&campaign=configured",
				request: new Request(
					"https://app.com/dashboard?tag=a&source=request&tag=b&next=%2Faccount",
				),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
			if (result.action === "redirect_login") {
				expect([...result.redirectUrl.searchParams.entries()]).toEqual([
					["source", "configured"],
					["campaign", "configured"],
					["tag", "a"],
					["tag", "b"],
					["next", "/account"],
				]);
			}
		});

		test("does not copy request query parameters to an external login URL", async () => {
			const config = createTestConfig({
				loginUrl:
					"https://identity.example.com/sign-in?source=configured",
				request: new Request(
					"https://app.com/dashboard?neon_auth_session_verifier=secret&source=request&tag=a",
				),
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
			if (result.action === "redirect_login") {
				expect(result.redirectUrl.href).toBe(
					"https://identity.example.com/sign-in?source=configured",
				);
			}
		});

		test("allows the generated login URL when loginUrl contains query parameters", async () => {
			const loginUrl = "/auth/sign-in?source=configured";
			const redirectResult = await processAuthMiddleware(
				createTestConfig({
					loginUrl,
					request: new Request(
						"https://app.com/dashboard?source=request",
					),
				}),
			);

			expect(redirectResult.action).toBe("redirect_login");
			if (redirectResult.action !== "redirect_login") {
				return;
			}

			const loginRequest = new Request(redirectResult.redirectUrl);
			const result = await processAuthMiddleware(
				createTestConfig({
					loginUrl,
					request: loginRequest,
					pathname: new URL(loginRequest.url).pathname,
				}),
			);

			expect(result.action).toBe("allow");
		});

		test("allows access to skip routes without session", async () => {
			const config = createTestConfig({
				request: new Request("https://app.com/public/page"),
				pathname: "/public/page",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
		});

		test("does not skip sibling paths that share a skip route prefix", async () => {
			const config = createTestConfig({
				skipRoutes: ["/auth"],
				request: new Request("https://app.com/auth-admin"),
				pathname: "/auth-admin",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
		});

		test.each([
			["/auth", "/auth"],
			["/auth/", "/auth"],
			["/auth/profile", "/auth"],
			["/auth", "/auth/"],
			["/auth/", "/auth/"],
			["/auth/profile", "/auth/"],
			["/", "/"],
		])("allows pathname %s for skip route %s", async (pathname, skipRoute) => {
			const config = createTestConfig({
				skipRoutes: [skipRoute],
				request: new Request(`https://app.com${pathname}`),
				pathname,
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("allow");
		});

		test("does not treat root skip route as matching every path", async () => {
			const config = createTestConfig({
				skipRoutes: ["/"],
				request: new Request("https://app.com/dashboard"),
				pathname: "/dashboard",
			});

			const result = await processAuthMiddleware(config);

			expect(result.action).toBe("redirect_login");
		});
	});
});
