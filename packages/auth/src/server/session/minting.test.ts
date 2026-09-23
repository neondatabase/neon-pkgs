import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type {
	BetterAuthSession,
	BetterAuthUser,
} from "@/core/better-auth-types";
import type { RequireSessionData } from "@/server/types";
import {
	mintSessionDataFromResponse,
	mintSessionDataFromToken,
} from "./minting";

const TEST_SECRET = "test-secret-at-least-32-characters-long!";
const TEST_BASE_URL = "https://auth.example.com";
const TEST_USER_ID = "user-123";
const TEST_EMAIL = "test@example.com";
const TEST_COOKIE_CONFIG = {
	secret: TEST_SECRET,
	sessionDataTtl: 300,
};

const createTestSessionData = (
	expiresAt: Date = new Date(Date.now() + 3_600_000),
): RequireSessionData => {
	return {
		session: {
			id: "session-123",
			userId: TEST_USER_ID,
			token: "opaque-token-abc",
			expiresAt,
			createdAt: new Date(),
			updatedAt: new Date(),
			ipAddress: "127.0.0.1",
			userAgent: "test-agent",
		} as BetterAuthSession,
		user: {
			id: TEST_USER_ID,
			email: TEST_EMAIL,
			emailVerified: true,
			name: "Test User",
			image: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as BetterAuthUser,
	};
};

// MSW server setup
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("mintSessionDataFromResponse", () => {
	test("returns null when no Set-Cookie headers present", async () => {
		const headers = new Headers();

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).toBe(null);
	});

	test("returns null when Set-Cookie headers present but no session_token", async () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "other-cookie=value; Path=/; HttpOnly");
		headers.append("Set-Cookie", "another=123; Path=/");

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).toBe(null);
	});

	test("mints session_data cookie when session_token is present", async () => {
		const sessionData = createTestSessionData();

		// Mock /get-session endpoint
		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=new-token-value; Path=/; HttpOnly; Secure; SameSite=Lax",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
		expect(result).toContain("HttpOnly");
		expect(result).toContain("Secure");
		expect(result).toContain("SameSite=Lax");
	});

	test("includes domain in cookie when domain is specified", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=new-token-value; Path=/; HttpOnly",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			{
				...TEST_COOKIE_CONFIG,
				domain: ".example.com",
			},
		);

		expect(result).not.toBe(null);
		expect(result).toContain("Domain=.example.com");
	});

	test("uses SameSite=Strict when explicitly configured", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=valid-token; Path=/; HttpOnly";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			{
				...TEST_COOKIE_CONFIG,
				sameSite: "strict",
			},
		);

		expect(result).not.toBe(null);
		expect(result).toContain("SameSite=Strict");
	});

	test("returns null when upstream fetch fails", async () => {
		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(
					{ error: "Unauthorized" },
					{ status: 401 },
				);
			}),
		);

		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=invalid-token; Path=/; HttpOnly",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).toBe(null);
	});

	test("handles multiple Set-Cookie headers with session_token", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const headers = new Headers();
		headers.append("Set-Cookie", "other-cookie=value; Path=/");
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=new-token-value; Path=/; HttpOnly; Secure",
		);
		headers.append("Set-Cookie", "another=123; Path=/");

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
	});

	// Andras FIX 2 (correctness): the legacy substring scans false-matched any
	// cookie whose name *contained* `session_token` or any cookie whose VALUE
	// contained `max-age=0`. Exact-name + parsed `maxAge`/`expires` matching is
	// mandatory. The tests below cover both classes of regression.
	test("ignores unrelated cookies that contain the substring `session_token` in their name", async () => {
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			"analytics_session_token_ref=abc; Path=/; HttpOnly; Max-Age=3600",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).toBe(null);
	});

	test("does NOT treat a live session_token as deletion when value contains `max-age=0`", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const headers = new Headers();
		// Value literally contains `max-age=0` (e.g. as part of an encoded
		// payload) but the real attribute is `Max-Age=3600` — must mint, not delete.
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=encoded%3Bmax-age%3D0%3Bstuff; Path=/; HttpOnly; Secure; Max-Age=3600",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
		// A deletion cookie is empty (`name=`) — make sure we did not emit that.
		expect(result).not.toMatch(/__Secure-neon-auth\.local\.session_data=;/);
		expect(result).not.toMatch(
			/__Secure-neon-auth\.local\.session_data=\s*;/,
		);
	});

	test("emits deletion cookie when session_token has Max-Age=0 (real sign-out)", async () => {
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=; Path=/; HttpOnly; Secure; Max-Age=0",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
		expect(result).toContain("Max-Age=0");
	});

	test("emits deletion cookie when session_token has past Expires", async () => {
		const headers = new Headers();
		headers.append(
			"Set-Cookie",
			"__Secure-neon-auth.session_token=; Path=/; HttpOnly; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
		);

		const result = await mintSessionDataFromResponse(
			headers,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
		expect(result).toContain("Max-Age=0");
	});
});

describe("mintSessionDataFromToken", () => {
	test("mints session_data cookie from valid session_token", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, ({ request }) => {
				const cookie = request.headers.get("Cookie");
				expect(cookie).toContain(
					"__Secure-neon-auth.session_token=valid-token",
				);
				return HttpResponse.json(sessionData);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=valid-token; Path=/; HttpOnly; Secure";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
		expect(result).toContain("HttpOnly");
		expect(result).toContain("Secure");
	});

	test("includes domain in cookie when domain is specified", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=valid-token; Path=/; HttpOnly";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			{
				...TEST_COOKIE_CONFIG,
				domain: ".example.com",
			},
		);

		expect(result).not.toBe(null);
		expect(result).toContain("Domain=.example.com");
	});

	test("returns null when upstream fetch fails", async () => {
		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(
					{ error: "Unauthorized" },
					{ status: 401 },
				);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=invalid-token; Path=/; HttpOnly";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).toBe(null);
	});

	test("returns null when session_token is malformed", async () => {
		// No mock needed - should fail before fetch
		const sessionTokenCookie = "malformed-cookie-without-equals";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).toBe(null);
	});

	test("handles session_token with special characters in value", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, ({ request }) => {
				const cookie = request.headers.get("Cookie");
				expect(cookie).toContain(
					"__Secure-neon-auth.session_token=token-with-special=chars==",
				);
				return HttpResponse.json(sessionData);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=token-with-special=chars==; Path=/; HttpOnly";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(result).not.toBe(null);
		expect(result).toContain("__Secure-neon-auth.local.session_data=");
	});

	test("uses default TTL when sessionDataTtl not specified", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=valid-token; Path=/; HttpOnly";

		const result = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			{
				secret: TEST_SECRET,
				// sessionDataTtl omitted - should use default (300)
			},
		);

		expect(result).not.toBe(null);
		// Should have Max-Age set (default 300 seconds)
		expect(result).toContain("Max-Age=");
	});

	test("verifies minted cookie can be validated", async () => {
		const sessionData = createTestSessionData();

		server.use(
			http.get(`${TEST_BASE_URL}/get-session`, () => {
				return HttpResponse.json(sessionData);
			}),
		);

		const sessionTokenCookie =
			"__Secure-neon-auth.session_token=valid-token; Path=/; HttpOnly";

		const cookieString = await mintSessionDataFromToken(
			sessionTokenCookie,
			TEST_BASE_URL,
			TEST_COOKIE_CONFIG,
		);

		expect(cookieString).not.toBe(null);

		// Extract JWT value from Set-Cookie string
		const match = cookieString?.match(
			/__Secure-neon-auth\.local\.session_data=([^;]+)/,
		);
		expect(match).not.toBe(null);

		// biome-ignore lint/style/noNonNullAssertion: `expect(match).not.toBe(null)` above already fails the test if this is absent; downstream `.split()` needs a definite string.
		const jwtValue = match![1];
		expect(jwtValue).toBeTruthy();
		expect(jwtValue.split(".")).toHaveLength(3); // Valid JWT format
	});
});
