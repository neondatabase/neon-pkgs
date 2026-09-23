/**
 * Public-surface fixture test for `@neon/auth/server`.
 *
 * Locks in the toolkit's public API. Adding/removing exports requires updating
 * this snapshot AND the CHANGELOG (beta versioning policy). The test imports
 * via the internal `@/server` alias so we exercise the *source*, not the
 * bundled output — that way we'd notice unintended public-surface shifts
 * before they reach `dist/`.
 *
 * What this test does NOT verify:
 * - That `package.json` `exports` actually expose `./server` (covered by the
 *   pack + install dry-run in the verification harness).
 * - That `dist/server/index.js` includes every symbol (covered by the build
 *   step + tsdown's own export validation).
 */
import { describe, expect, test } from "vitest";
import * as ServerToolkit from "@/server";

describe("@neon/auth/server public surface", () => {
	test("exports the expected named symbols", () => {
		const names = Object.keys(ServerToolkit).toSorted();
		expect(names).toMatchInlineSnapshot(`
			[
			  "DEFAULT_AUTH_SKIP_ROUTES",
			  "NEON_AUTH_COOKIE_PREFIX",
			  "NEON_AUTH_HEADER_MIDDLEWARE_NAME",
			  "NEON_AUTH_NETWORK_ERROR_CODES",
			  "NEON_AUTH_SERVER_PROXY_HEADER",
			  "NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME",
			  "NEON_AUTH_SESSION_COOKIE_NAME",
			  "NEON_AUTH_SESSION_DATA_COOKIE_NAME",
			  "checkSessionRequired",
			  "classifyFetchFailure",
			  "createAuthServer",
			  "extractNeonAuthCookies",
			  "handleAuthProxyRequest",
			  "handleAuthRequest",
			  "handleAuthResponse",
			  "parseCookieValue",
			  "parseSessionData",
			  "parseSetCookies",
			  "processAuthMiddleware",
			  "resolveNeonAuthLogging",
			  "serializeSetCookie",
			  "shouldProtectRoute",
			  "validateCookieConfig",
			  "validateSessionData",
			]
		`);
	});

	test("every exported value has the expected JS kind", () => {
		// Functions
		expect(typeof ServerToolkit.createAuthServer).toBe("function");
		expect(typeof ServerToolkit.handleAuthProxyRequest).toBe("function");
		expect(typeof ServerToolkit.handleAuthRequest).toBe("function");
		expect(typeof ServerToolkit.handleAuthResponse).toBe("function");
		expect(typeof ServerToolkit.processAuthMiddleware).toBe("function");
		expect(typeof ServerToolkit.shouldProtectRoute).toBe("function");
		expect(typeof ServerToolkit.checkSessionRequired).toBe("function");
		expect(typeof ServerToolkit.validateCookieConfig).toBe("function");
		expect(typeof ServerToolkit.resolveNeonAuthLogging).toBe("function");
		expect(typeof ServerToolkit.classifyFetchFailure).toBe("function");
		expect(typeof ServerToolkit.parseSessionData).toBe("function");
		expect(typeof ServerToolkit.validateSessionData).toBe("function");
		expect(typeof ServerToolkit.parseSetCookies).toBe("function");
		expect(typeof ServerToolkit.serializeSetCookie).toBe("function");
		expect(typeof ServerToolkit.parseCookieValue).toBe("function");
		expect(typeof ServerToolkit.extractNeonAuthCookies).toBe("function");

		// Constants
		expect(typeof ServerToolkit.NEON_AUTH_SERVER_PROXY_HEADER).toBe(
			"string",
		);
		expect(typeof ServerToolkit.NEON_AUTH_HEADER_MIDDLEWARE_NAME).toBe(
			"string",
		);
		expect(typeof ServerToolkit.NEON_AUTH_COOKIE_PREFIX).toBe("string");
		expect(typeof ServerToolkit.NEON_AUTH_SESSION_COOKIE_NAME).toBe(
			"string",
		);
		expect(typeof ServerToolkit.NEON_AUTH_SESSION_DATA_COOKIE_NAME).toBe(
			"string",
		);
		expect(
			typeof ServerToolkit.NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME,
		).toBe("string");
		expect(Array.isArray(ServerToolkit.DEFAULT_AUTH_SKIP_ROUTES)).toBe(
			true,
		);
		expect(Array.isArray(ServerToolkit.NEON_AUTH_NETWORK_ERROR_CODES)).toBe(
			true,
		);
	});

	test("createAuthServer accepts a minimal RequestContext factory and returns a server proxy", () => {
		const server = ServerToolkit.createAuthServer({
			baseUrl: "https://auth.example.com",
			context: () => ({
				getCookies: () => "",
				setCookie: () => {},
				getHeader: () => null,
				getOrigin: () => "https://app.example.com",
				getFramework: () => "test-adapter",
			}),
			cookieSecret: "x".repeat(32),
		});
		// The proxy lazily exposes Better Auth server methods; getSession is the
		// canonical smoke test.
		expect(typeof server.getSession).toBe("function");
	});
});
