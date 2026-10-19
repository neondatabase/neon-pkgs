import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOAuth } from "../index";
import type { FakeAuthServer } from "../testing/fake-auth-server";
import { startFakeAuthServer } from "../testing/fake-auth-server";
import { OAuthConfigError } from "../verify/errors";
import { seal } from "./cookies";

// The fake authorization server speaks plain HTTP; openid-client only allows that when opted in per Configuration.
vi.mock("openid-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("openid-client")>();
	// A Proxy keeps `new` working while opting each instance in to plain HTTP.
	const Configuration = new Proxy(actual.Configuration, {
		construct(target, args) {
			const config = Reflect.construct(target, args);
			actual.allowInsecureRequests(config);
			return config;
		},
	});
	return { ...actual, Configuration };
});

const SECRET = "x".repeat(32);
const REDIRECT = "http://localhost:3000/auth/callback";

let fake: FakeAuthServer;
beforeEach(async () => {
	fake = await startFakeAuthServer();
});
afterEach(() => fake.close());

const make = () =>
	createOAuth({
		baseUrl: fake.issuer,
		clientId: "c1",
		redirectUri: REDIRECT,
		cookies: { secret: SECRET },
	}).client;

async function requestWithSession(session: object): Promise<Request> {
	const value = await seal(session, SECRET, "session", 600);
	return new Request("http://localhost:3000/api", {
		headers: { cookie: `neon_auth_session=${value}` },
	});
}

const user = {
	id: "user-1",
	email: "u@example.com",
	emailVerified: true,
	name: "U",
};
const now = () => Math.floor(Date.now() / 1000);
const expired = (extra = {}) => ({
	accessToken: "old-access",
	refreshToken: "refresh-0",
	expiresAt: now() - 10,
	user,
	...extra,
});

describe("shared discovery", () => {
	it("serves the verifier, mcp and the client from one discovery fetch", async () => {
		fake.setDiscoveryDelay(30);
		const oauth = createOAuth({
			baseUrl: fake.issuer,
			clientId: "c1",
			redirectUri: REDIRECT,
			cookies: { secret: SECRET },
		});
		await Promise.all([
			oauth.verifyAccessToken(await fake.sign(), {
				audience: "http://api.test/mcp",
			}),
			oauth
				.mcp({ resource: "http://api.test/mcp" })
				.verifyAccessToken(await fake.sign()),
			oauth.client.startLogin(),
		]);
		expect(fake.hits.discovery).toBe(1);
		expect(fake.hits.jwks).toBe(1);
	});
});

describe("getAccessToken refresh", () => {
	it("coalesces concurrent refreshes of the same refresh token into one token request", async () => {
		fake.setTokenDelay(50);
		const client = make();
		const request = await requestWithSession(expired());
		const results = await Promise.all([
			client.getAccessToken(request),
			client.getAccessToken(request),
			client.getAccessToken(request),
		]);
		expect(fake.hits.token).toBe(1);
		expect(results.map((r) => r.ok)).toEqual([true, true, true]);
		expect(new Set(results.map((r) => r.ok && r.accessToken)).size).toBe(1);
	});

	it("refreshes again once the shared refresh has settled", async () => {
		const client = make();
		const first = await client.getAccessToken(
			await requestWithSession(expired()),
		);
		expect(first.ok).toBe(true);
		const second = await client.getAccessToken(
			await requestWithSession(expired({ refreshToken: "refresh-1" })),
		);
		expect(second.ok).toBe(true);
		expect(fake.hits.token).toBe(2);
	});

	it("returns the refreshed session cookie, which carries the rotated refresh token", async () => {
		const client = make();
		const result = await client.getAccessToken(
			await requestWithSession(expired()),
		);
		if (!result.ok) throw new Error("expected a refreshed token");
		expect(result.setCookie).toMatch(/^neon_auth_session=/);
		const next = new Request("http://localhost:3000/api", {
			headers: { cookie: (result.setCookie as string).split(";")[0] },
		});
		const found = await client.getSession(next);
		if (!found.ok) throw new Error("expected a session");
		expect(found.session.refreshToken).toBe("refresh-1");
		expect(found.session.accessToken).toBe(result.accessToken);
	});
});

describe("getAccessToken results", () => {
	it("returns the stored token without a cookie while it is fresh", async () => {
		const request = await requestWithSession(
			expired({ expiresAt: now() + 600 }),
		);
		expect(await make().getAccessToken(request)).toEqual({
			ok: true,
			accessToken: "old-access",
		});
		expect(fake.hits.token).toBe(0);
	});

	it("reports no_session without a readable cookie", async () => {
		expect(
			await make().getAccessToken(
				new Request("http://localhost:3000/api"),
			),
		).toEqual({ ok: false, reason: "no_session" });
	});

	it("reports refresh_unavailable when an expired session has no refresh token", async () => {
		const request = await requestWithSession(
			expired({ refreshToken: undefined }),
		);
		expect(await make().getAccessToken(request)).toEqual({
			ok: false,
			reason: "refresh_unavailable",
		});
	});

	it("reports refresh_failed when the token endpoint rejects the refresh", async () => {
		const client = make();
		await client.getAccessToken(await requestWithSession(expired()));
		const replay = await requestWithSession(expired());
		expect(await client.getAccessToken(replay)).toEqual({
			ok: false,
			reason: "refresh_failed",
		});
	});
});

describe("withAccessToken", () => {
	const fn = ({
		authorizationHeaders,
	}: {
		authorizationHeaders: { authorization: string };
	}) => Response.json({ sent: authorizationHeaders.authorization });

	it("passes the bearer header and leaves the response alone when nothing was refreshed", async () => {
		const request = await requestWithSession(
			expired({ expiresAt: now() + 600 }),
		);
		const out = await make().withAccessToken(request, fn);
		if (!out.ok) throw new Error("expected ok");
		expect(await out.response.json()).toEqual({
			sent: "Bearer old-access",
		});
		expect(out.response.headers.getSetCookie()).toEqual([]);
	});

	it("appends the refreshed cookie and keeps the callback's own Set-Cookie headers", async () => {
		const out = await make().withAccessToken(
			await requestWithSession(expired()),
			() => {
				const headers = new Headers();
				headers.append("set-cookie", "theirs=1");
				return new Response("ok", { headers });
			},
		);
		if (!out.ok) throw new Error("expected ok");
		const cookies = out.response.headers.getSetCookie();
		expect(cookies[0]).toBe("theirs=1");
		expect(cookies[1]).toMatch(/^neon_auth_session=/);
	});

	it("appends to a response whose headers are immutable", async () => {
		const out = await make().withAccessToken(
			await requestWithSession(expired()),
			() => Response.redirect("http://localhost:3000/next", 302),
		);
		if (!out.ok) throw new Error("expected ok");
		expect(out.response.status).toBe(302);
		expect(out.response.headers.getSetCookie()).toHaveLength(1);
	});

	it("returns the failure without calling fn", async () => {
		let called = false;
		const out = await make().withAccessToken(
			new Request("http://localhost:3000/api"),
			() => {
				called = true;
				return new Response();
			},
		);
		expect(out).toEqual({ ok: false, reason: "no_session" });
		expect(called).toBe(false);
	});
});

describe("returnTo", () => {
	it.each([
		["/dashboard?tab=1", "/dashboard?tab=1"],
		["//evil.example", "/"],
		["/\\evil.example", "/"],
		["https://evil.example", "/"],
		["dashboard", "/"],
	])("logout redirects returnTo %s to %s", async (returnTo, expected) => {
		const res = await make().handlers.logout(
			new Request(
				`http://localhost:3000/auth/logout?returnTo=${encodeURIComponent(returnTo)}`,
			),
		);
		expect(res.headers.get("location")).toBe(expected);
	});
});

describe("URL client_id (Client ID Metadata Document)", () => {
	const CIMD_CLIENT_ID = "https://app.example.com/oauth/client.json";
	const makeCimd = (extra = {}) =>
		createOAuth({
			baseUrl: fake.issuer,
			clientId: CIMD_CLIENT_ID,
			redirectUri: REDIRECT,
			cookies: { secret: SECRET },
			...extra,
		}).client;

	it("sends the URL verbatim as client_id on the authorize request", async () => {
		const { url } = await makeCimd().startLogin();
		expect(url.searchParams.get("client_id")).toBe(CIMD_CLIENT_ID);
	});

	it("throws a config error naming the issuer when the server does not advertise support", async () => {
		fake.setCimdSupported(false);
		const client = makeCimd();
		await expect(client.startLogin()).rejects.toThrow(OAuthConfigError);
		await expect(client.startLogin()).rejects.toThrow(
			/client_id_metadata_document_supported/,
		);
	});

	it("answers the login route with 500 and reports the cause when unsupported", async () => {
		fake.setCimdSupported(false);
		const errors: unknown[] = [];
		const client = makeCimd({ onError: (e: unknown) => errors.push(e) });
		const res = await client.handlers.login(
			new Request("http://localhost:3000/auth/login"),
		);
		expect(res.status).toBe(500);
		expect(errors[0]).toBeInstanceOf(OAuthConfigError);
	});

	it("does not require the field for a pre-registered client_id", async () => {
		fake.setCimdSupported(false);
		await expect(make().startLogin()).resolves.toBeDefined();
	});

	it("rejects a client secret with a URL client_id", () => {
		expect(() => makeCimd({ clientSecret: "s" })).toThrow(OAuthConfigError);
	});
});
