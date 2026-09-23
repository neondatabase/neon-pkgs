import { describe, expect, test } from "vitest";
import { handleAuthResponse } from "./response";

const TEST_SECRET = "test-secret-at-least-32-characters-long!";
const BASE_URL = "https://auth.example.com";
const COOKIE_CONFIG = { secret: TEST_SECRET };
const COOKIE_CONFIG_WITH_DOMAIN = {
	secret: TEST_SECRET,
	domain: ".example.com",
};

// Build a minimal upstream Response with the given Set-Cookie headers.
// Omitting 'session_token' from cookies ensures mintSessionDataFromResponse returns null
// without any network calls, keeping these tests focused on attribute transformation.
function upstreamResponse(
	setCookieHeaders: string[],
	extraHeaders?: Record<string, string>,
): Response {
	const headers = new Headers(extraHeaders);
	for (const c of setCookieHeaders) {
		headers.append("Set-Cookie", c);
	}
	return new Response(null, { status: 200, headers });
}

describe("handleAuthResponse – cookie sanitization", () => {
	test("strips Partitioned flag when no domain is configured", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies).toHaveLength(1);
		expect(cookies[0]).not.toContain("Partitioned");
	});

	test("strips Partitioned flag when domain is configured", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG_WITH_DOMAIN,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).not.toContain("Partitioned");
	});

	test("replaces SameSite=None with SameSite=Lax by default", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).toContain("SameSite=Lax");
		expect(cookies[0]).not.toContain("SameSite=None");
	});

	test("uses cookies.sameSite=lax when configured", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(upstream, BASE_URL, {
			...COOKIE_CONFIG,
			sameSite: "lax",
		});

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).toContain("SameSite=Lax");
		expect(cookies[0]).not.toContain("SameSite=None");
	});

	test("uses cookies.sameSite=strict when configured", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=Lax",
		]);

		const result = await handleAuthResponse(upstream, BASE_URL, {
			...COOKIE_CONFIG,
			sameSite: "strict",
		});

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).toContain("SameSite=Strict");
		expect(cookies[0]).not.toContain("SameSite=Lax");
	});

	test("sets SameSite=Lax when upstream omits SameSite", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=xyz; Path=/; HttpOnly; Secure",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).toContain("SameSite=Lax");
	});

	test("preserves other cookie attributes (HttpOnly, Secure, Path, Max-Age)", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/auth; HttpOnly; Secure; Max-Age=300; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookie = result.headers.getSetCookie()[0];
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("Path=/auth");
		expect(cookie).toContain("Max-Age=300");
	});

	// Andras FIX 1 (security): forwarded cookies must always carry `Secure`, to
	// match `session/minting.ts` and the documented "Secure is always applied"
	// contract. Without Secure, `SameSite=None` cookies are silently dropped.
	test("forces Secure when upstream cookie omits it", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_token=abc; Path=/; HttpOnly; SameSite=Lax",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookie = result.headers.getSetCookie()[0];
		expect(cookie).toContain("Secure");
	});

	test("keeps Secure on SameSite=None cookies (browser would drop them otherwise)", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_token=abc; Path=/; HttpOnly; SameSite=None",
		]);

		const result = await handleAuthResponse(upstream, BASE_URL, {
			...COOKIE_CONFIG,
			sameSite: "none",
		});

		const cookie = result.headers.getSetCookie()[0];
		expect(cookie).toContain("SameSite=None");
		expect(cookie).toContain("Secure");
	});
});

describe("handleAuthResponse – domain handling", () => {
	test("adds Domain attribute when domain is configured", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG_WITH_DOMAIN,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).toContain("Domain=.example.com");
	});

	test("does not add Domain attribute when domain is not configured", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies[0]).not.toContain("Domain=");
	});
});

describe("handleAuthResponse – multiple cookies", () => {
	test("sanitizes all Set-Cookie headers independently", async () => {
		const upstream = upstreamResponse([
			"__Secure-neon-auth.session_challange=abc; Path=/; Secure; SameSite=None; Partitioned",
			"__Secure-neon-auth.other=xyz; Path=/; Secure; SameSite=None; Partitioned",
		]);

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		const cookies = result.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		for (const cookie of cookies) {
			expect(cookie).not.toContain("Partitioned");
			expect(cookie).toContain("SameSite=Lax");
		}
	});
});

describe("handleAuthResponse – header allowlist", () => {
	test("proxies allowed headers (content-type, x-neon-ret-request-id)", async () => {
		const upstream = upstreamResponse([], {
			"content-type": "application/json",
			"x-neon-ret-request-id": "req-123",
		});

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		expect(result.headers.get("content-type")).toBe("application/json");
		expect(result.headers.get("x-neon-ret-request-id")).toBe("req-123");
	});

	test("blocks headers not in the allowlist", async () => {
		const upstream = upstreamResponse([], {
			"x-custom-internal-header": "secret",
			authorization: "Bearer token",
		});

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		expect(result.headers.get("x-custom-internal-header")).toBeNull();
		expect(result.headers.get("authorization")).toBeNull();
	});

	// Andras FIX 4: hop-by-hop / framing headers must not be forwarded; the
	// runtime owns framing, and a forwarded stale `content-length` corrupts a
	// re-encoded body.
	test("does not forward hop-by-hop and framing headers (content-length, transfer-encoding, connection)", async () => {
		const upstream = upstreamResponse([], {
			"content-length": "9999",
			"transfer-encoding": "chunked",
			connection: "keep-alive",
		});

		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);

		expect(result.headers.get("content-length")).toBeNull();
		expect(result.headers.get("transfer-encoding")).toBeNull();
		expect(result.headers.get("connection")).toBeNull();
	});
});

describe("handleAuthResponse – response passthrough", () => {
	test("preserves upstream status code", async () => {
		const upstream = new Response(null, { status: 401 });
		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);
		expect(result.status).toBe(401);
	});

	test("emits no Set-Cookie headers when upstream sets none", async () => {
		const upstream = Response.json({ ok: true });
		const result = await handleAuthResponse(
			upstream,
			BASE_URL,
			COOKIE_CONFIG,
		);
		expect(result.headers.getSetCookie()).toHaveLength(0);
	});
});
