import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOAuth } from "./index";
import type { FakeAuthServer } from "./testing/fake-auth-server";
import { startFakeAuthServer } from "./testing/fake-auth-server";

const AUDIENCE = "http://api.test/mcp";

let auth: FakeAuthServer;
beforeEach(async () => {
	auth = await startFakeAuthServer();
});
afterEach(() => auth.close());

const make = (extra = {}) => createOAuth({ baseUrl: auth.issuer, ...extra });
const opts = { audience: AUDIENCE };
const withClient = () =>
	createOAuth({
		baseUrl: auth.issuer,
		clientId: "c1",
		redirectUri: "http://localhost:3000/callback",
		cookies: { secret: "x".repeat(32) },
	});

describe("discovery", () => {
	it("shares one in-flight fetch between concurrent callers", async () => {
		auth.setDiscoveryDelay(50);
		const rs = make();
		const [a, b] = await Promise.all([
			rs.getDiscovery(),
			rs.getDiscovery(),
		]);
		expect(auth.hits.discovery).toBe(1);
		expect(a).toBe(b);
	});

	it("serves from cache until the TTL passes", async () => {
		const rs = make({ discovery: { ttlMs: 40 } });
		await rs.getDiscovery();
		await rs.getDiscovery();
		expect(auth.hits.discovery).toBe(1);
		await new Promise((r) => setTimeout(r, 60));
		await rs.getDiscovery();
		expect(auth.hits.discovery).toBe(2);
	});

	it("rejects a document whose issuer differs from the configured one", async () => {
		auth.setReportedIssuer("https://evil.example/auth");
		await expect(make().getDiscovery()).rejects.toThrow(/issuer mismatch/);
	});

	it("does not cache a failure beyond the backoff window", async () => {
		auth.setDiscoveryStatus(500);
		const rs = make({ discovery: { failureBackoffMs: 30 } });
		await expect(rs.getDiscovery()).rejects.toThrow(/500/);
		await expect(rs.getDiscovery()).rejects.toThrow(/500/);
		expect(auth.hits.discovery).toBe(1); // second call answered from the negative cache
		auth.setDiscoveryStatus(200);
		await new Promise((r) => setTimeout(r, 50));
		await expect(rs.getDiscovery()).resolves.toMatchObject({
			issuer: auth.issuer,
		});
	});
});

describe("verifyAccessToken", () => {
	it("accepts a valid EdDSA token and maps its claims", async () => {
		const result = await make().verifyAccessToken(await auth.sign(), opts);
		if (!result.ok) throw new Error("expected a valid token");
		expect(result.auth).toMatchObject({
			sub: "user-1",
			clientId: "client-1",
			scopes: ["openid", "profile"],
			audience: [AUDIENCE],
		});
		expect(result.auth.expiresAt).toBeGreaterThan(Date.now() / 1000);
		expect(result.auth.claims.iss).toBe(auth.issuer);
	});

	it("builds the key set once across verifications", async () => {
		const rs = make();
		await rs.verifyAccessToken(await auth.sign(), opts);
		await rs.verifyAccessToken(await auth.sign(), opts);
		expect(auth.hits.jwks).toBe(1);
	});

	it("rejects a token minted for another audience", async () => {
		const token = await auth.sign({}, { aud: "http://other.test/api" });
		await expect(
			make().verifyAccessToken(token, opts),
		).resolves.toMatchObject({
			ok: false,
			reason: "invalid_token",
			code: "invalid_audience",
		});
	});

	it("rejects an expired token", async () => {
		const token = await auth.sign(
			{},
			{ exp: Math.floor(Date.now() / 1000) - 120 },
		);
		await expect(
			make().verifyAccessToken(token, opts),
		).resolves.toMatchObject({ ok: false, code: "expired" });
	});

	it("honors clockTolerance", async () => {
		const token = await auth.sign(
			{},
			{ exp: Math.floor(Date.now() / 1000) - 5 },
		);
		await expect(
			make({ clockTolerance: 30 }).verifyAccessToken(token, opts),
		).resolves.toMatchObject({ ok: true });
	});

	it("rejects a validly signed token from another issuer", async () => {
		const token = await auth.sign({}, { iss: "https://evil.example/auth" });
		await expect(
			make().verifyAccessToken(token, opts),
		).resolves.toMatchObject({ ok: false, code: "invalid_issuer" });
	});

	it("rejects garbage", async () => {
		await expect(
			make().verifyAccessToken("not-a-jwt", opts),
		).resolves.toMatchObject({ ok: false, code: "invalid_token" });
	});
});

describe("requireBearerAuth", () => {
	const guard = (
		extra: {
			requiredScopes?: string[];
			resourceMetadataUrl?: string | true;
		} = {},
	) => make().requireBearerAuth({ audience: AUDIENCE, ...extra });
	const req = (authorization?: string) =>
		new Request("http://api.test/mcp", {
			headers: authorization ? { authorization } : {},
		});
	const metadataUrl =
		"http://api.test/.well-known/oauth-protected-resource/mcp";

	it("returns the AuthResult for a valid token", async () => {
		const out = await guard()(req(`Bearer ${await auth.sign()}`));
		expect(out).not.toBeInstanceOf(Response);
		expect(out).toMatchObject({ sub: "user-1" });
	});

	it("answers a missing header with a plain RFC 6750 challenge (no resource_metadata by default)", async () => {
		const res = (await guard()(req())) as Response;
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			'Bearer error="invalid_token", error_description="Missing Authorization header"',
		);
		expect(await res.json()).toEqual({
			error: "invalid_token",
			error_description: "Missing Authorization header",
		});
	});

	it("adds resource_metadata derived from the audience when resourceMetadataUrl is true", async () => {
		const res = (await guard({ resourceMetadataUrl: true })(
			req(),
		)) as Response;
		expect(res.headers.get("www-authenticate")).toBe(
			`Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${metadataUrl}"`,
		);
	});

	it("uses an explicit resourceMetadataUrl verbatim, also on 403", async () => {
		const res = (await guard({
			resourceMetadataUrl: "http://api.test/custom-meta",
			requiredScopes: ["admin"],
		})(req(`Bearer ${await auth.sign()}`))) as Response;
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain(
			', resource_metadata="http://api.test/custom-meta"',
		);
	});

	it("rejects a non-Bearer scheme", async () => {
		const res = (await guard()(req("Basic abc"))) as Response;
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			"expected 'Bearer TOKEN'",
		);
	});

	it("answers insufficient scope with 403", async () => {
		const res = (await guard({ requiredScopes: ["admin"] })(
			req(`Bearer ${await auth.sign()}`),
		)) as Response;
		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain(
			'error="insufficient_scope"',
		);
		expect(res.headers.get("www-authenticate")).toContain('scope="admin"');
	});

	it("answers 503 when the authorization server cannot be reached", async () => {
		auth.setDiscoveryStatus(500);
		const res = (await guard()(
			req(`Bearer ${await auth.sign()}`),
		)) as Response;
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			error: "server_error",
			error_description: "Authorization server unavailable",
		});
	});
});

describe("createOAuth", () => {
	it("normalizes a trailing slash on baseUrl", () => {
		expect(
			createOAuth({ baseUrl: "https://other.test/auth/" }).issuer,
		).toBe("https://other.test/auth");
	});

	it("shares one discovery fetch and one key set between the verifier and mcp", async () => {
		auth.setDiscoveryDelay(30);
		const na = make();
		const token = await auth.sign();
		await Promise.all([
			na.verifyAccessToken(token, opts),
			na.mcp({ resource: AUDIENCE }).verifyAccessToken(token),
		]);
		expect(auth.hits.discovery).toBe(1);
		expect(auth.hits.jwks).toBe(1);
	});

	it("returns the same client instance on every access", () => {
		const na = withClient();
		expect(na.client).toBe(na.client);
	});
});

describe("requireBearerAuth audience", () => {
	it("defaults to the resource passed to createOAuth", async () => {
		const guard = createOAuth({
			baseUrl: auth.issuer,
			resource: AUDIENCE,
		}).requireBearerAuth();
		const ok = await guard(
			new Request(AUDIENCE, {
				headers: {
					authorization: `Bearer ${await auth.sign({}, { aud: AUDIENCE })}`,
				},
			}),
		);
		expect(ok).not.toBeInstanceOf(Response);
		const other = await guard(
			new Request(AUDIENCE, {
				headers: {
					authorization: `Bearer ${await auth.sign({}, { aud: "http://other.test/api" })}`,
				},
			}),
		);
		expect((other as Response).status).toBe(401);
	});

	it("lets an explicit audience override the resource", async () => {
		const guard = createOAuth({
			baseUrl: auth.issuer,
			resource: "http://other.test/api",
		}).requireBearerAuth({ audience: AUDIENCE });
		const ok = await guard(
			new Request(AUDIENCE, {
				headers: {
					authorization: `Bearer ${await auth.sign({}, { aud: AUDIENCE })}`,
				},
			}),
		);
		expect(ok).not.toBeInstanceOf(Response);
	});
});

describe("tokens without identity claims", () => {
	it("rejects a token that has no sub", async () => {
		const token = await auth.sign({}, { aud: AUDIENCE, sub: null });
		await expect(
			make().verifyAccessToken(token, opts),
		).resolves.toMatchObject({ ok: false, code: "missing_sub" });
	});

	it("leaves clientId undefined when the token has no client_id", async () => {
		const token = await auth.sign(
			{ client_id: undefined },
			{ aud: AUDIENCE },
		);
		const result = await make().verifyAccessToken(token, opts);
		if (!result.ok) throw new Error("expected a valid token");
		expect(result.auth.clientId).toBeUndefined();
	});
});

describe("challenge quoting", () => {
	it("escapes quotes and backslashes in quoted-string parameters (RFC 6750)", async () => {
		const guard = make().requireBearerAuth({
			audience: AUDIENCE,
			requiredScopes: ['a"b', "c\\d"],
		});
		const res = (await guard(
			new Request(AUDIENCE, {
				headers: {
					authorization: `Bearer ${await auth.sign({}, { aud: AUDIENCE })}`,
				},
			}),
		)) as Response;
		expect(res.status).toBe(403);
		const header = res.headers.get("www-authenticate");
		expect(header).toContain(
			'error_description="Missing required scope: a\\"b c\\\\d"',
		);
		expect(header).toContain('scope="a\\"b c\\\\d"');
	});
});
