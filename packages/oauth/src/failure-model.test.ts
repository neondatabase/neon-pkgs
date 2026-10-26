// One rule per layer, asserted per operation:
//   misconfiguration        -> OAuthConfigError at creation
//   auth server unreachable -> AuthServerUnavailableError (HTTP 503), never "signed out"
//   expected auth outcomes  -> returned { ok: false, reason } (HTTP 401 / 403)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { seal } from "./client/cookies";
import {
	AuthServerUnavailableError,
	createOAuth,
	OAuthConfigError,
	OAuthError,
} from "./index";
import type { FakeAuthServer } from "./testing/fake-auth-server";
import { GOOD_CODE, startFakeAuthServer } from "./testing/fake-auth-server";

vi.mock("openid-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("openid-client")>();
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
const AUD = "http://api.test/mcp";

let fake: FakeAuthServer;
beforeEach(async () => {
	fake = await startFakeAuthServer();
});
afterEach(() => fake.close());

const make = (extra = {}) =>
	createOAuth({
		baseUrl: fake.issuer,
		resource: AUD,
		clientId: "c1",
		redirectUri: REDIRECT,
		cookies: { secret: SECRET },
		...extra,
	});

const now = () => Math.floor(Date.now() / 1000);
const user = {
	id: "u",
	email: "e",
	emailVerified: true,
	name: "n",
};
const session = (extra = {}) => ({
	accessToken: "a",
	refreshToken: "refresh-0",
	expiresAt: now() - 10,
	user,
	...extra,
});
const withCookie = (value: string) =>
	new Request("http://localhost:3000/x", {
		headers: { cookie: `neon_auth_session=${value}` },
	});
const sessionRequest = async (s: object, maxAge = 600) =>
	withCookie(await seal(s, SECRET, "session", maxAge));
const anon = () => new Request("http://localhost:3000/x");

describe("misconfiguration throws OAuthConfigError at creation", () => {
	it.each([
		["missing baseUrl", () => createOAuth({} as never)],
		["relative baseUrl", () => createOAuth({ baseUrl: "/auth" })],
		[
			"partial client settings",
			() =>
				createOAuth({
					baseUrl: "http://x.test/a",
					clientId: "c",
				} as never),
		],
		[
			"short cookie secret",
			() =>
				createOAuth({
					baseUrl: "http://x.test/a",
					clientId: "c",
					redirectUri: REDIRECT,
					cookies: { secret: "short" },
				}),
		],
		[
			"relative redirectUri",
			() =>
				createOAuth({
					baseUrl: "http://x.test/a",
					clientId: "c",
					redirectUri: "/cb",
					cookies: { secret: SECRET },
				}),
		],
		[
			"requireBearerAuth without audience",
			() =>
				createOAuth({ baseUrl: "http://x.test/a" }).requireBearerAuth(),
		],
		[
			"mcp with a non-URL resource",
			() =>
				createOAuth({ baseUrl: "http://x.test/a" }).mcp({
					resource: "not a url",
				}),
		],
	])("%s", (_name, create) => {
		let error: unknown;
		try {
			create();
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(OAuthConfigError);
		expect(error).toBeInstanceOf(OAuthError);
	});
});

describe("auth server unreachable throws AuthServerUnavailableError", () => {
	beforeEach(() => fake.setDiscoveryStatus(500));

	it.each<[string, (o: ReturnType<typeof make>) => Promise<unknown>]>([
		["getDiscovery", (o) => o.getDiscovery()],
		[
			"verifyAccessToken",
			async (o) => o.verifyAccessToken("t.t.t", { audience: AUD }),
		],
		[
			"mcp.verifyAccessToken",
			async (o) => o.mcp({ resource: AUD }).verifyAccessToken("t.t.t"),
		],
		["client.startLogin", (o) => o.client.startLogin()],
		[
			"client.finishLogin",
			(o) =>
				o.client.finishLogin(new URL(`${REDIRECT}?code=c&state=s`), {
					state: "s",
					codeVerifier: "v",
				}),
		],
		[
			"client.getAccessToken (refresh)",
			async (o) =>
				o.client.getAccessToken(await sessionRequest(session())),
		],
		[
			"client.withAccessToken (refresh)",
			async (o) =>
				o.client.withAccessToken(
					await sessionRequest(session()),
					() => new Response(),
				),
		],
	])("%s", async (_name, run) => {
		await expect(run(make())).rejects.toBeInstanceOf(
			AuthServerUnavailableError,
		);
	});

	it("is an OAuthError", async () => {
		await expect(make().getDiscovery()).rejects.toBeInstanceOf(OAuthError);
	});
});

describe("token endpoint or JWKS unreachable", () => {
	it("refresh against a failing token endpoint throws, not refresh_failed", async () => {
		fake.setTokenStatus(503);
		await expect(
			make().client.getAccessToken(await sessionRequest(session())),
		).rejects.toBeInstanceOf(AuthServerUnavailableError);
	});

	it("an unreachable JWKS endpoint throws, not invalid_token", async () => {
		fake.setJwksStatus(500);
		await expect(
			make().verifyAccessToken(await fake.sign({}, { aud: AUD }), {
				audience: AUD,
			}),
		).rejects.toBeInstanceOf(AuthServerUnavailableError);
	});
});

describe("userinfo is required to finish a sign-in", () => {
	const attempt = { state: "s", codeVerifier: "v" };
	const callbackUrl = new URL(`${REDIRECT}?code=${GOOD_CODE}&state=s`);

	async function callbackRequest() {
		const tx = await seal({ ...attempt, returnTo: "/" }, SECRET, "tx", 600);
		return new Request(
			`http://localhost:3000/auth/callback?code=${GOOD_CODE}&state=s`,
			{ headers: { cookie: `neon_auth_session_tx=${tx}` } },
		);
	}

	it("success: user.id is the ID token sub, profile comes from userinfo", async () => {
		fake.setIdTokenSub("sub-from-id-token");
		fake.setUserinfoClaims({
			sub: "sub-from-id-token",
			email: "a@b.test",
			email_verified: true,
			name: "Ann",
			picture: "https://img.test/a.png",
		});
		const result = await make().client.finishLogin(callbackUrl, attempt);
		expect(result).toMatchObject({
			ok: true,
			session: {
				user: {
					id: "sub-from-id-token",
					email: "a@b.test",
					emailVerified: true,
					name: "Ann",
					image: "https://img.test/a.png",
				},
			},
		});
	});

	it("optional profile fields stay absent instead of becoming empty strings", async () => {
		fake.setUserinfoClaims({ sub: "user-1" });
		const result = await make().client.finishLogin(callbackUrl, attempt);
		expect(result.ok && result.session.user).toEqual({ id: "user-1" });
	});

	it.each([
		500,
		503,
		"drop",
	] as const)("userinfo %s: finishLogin throws AuthServerUnavailableError", async (status) => {
		fake.setUserinfoStatus(status);
		await expect(
			make().client.finishLogin(callbackUrl, attempt),
		).rejects.toBeInstanceOf(AuthServerUnavailableError);
	});

	it("userinfo 5xx: callback answers 503, calls onError, sets no session cookie", async () => {
		const onError = vi.fn();
		fake.setUserinfoStatus(503);
		const res = await make({ onError }).client.handlers.callback(
			await callbackRequest(),
		);
		expect(res.status).toBe(503);
		expect(onError).toHaveBeenCalledWith(
			expect.any(AuthServerUnavailableError),
			expect.any(Request),
		);
		expect(res.headers.get("set-cookie") ?? "").not.toContain(
			"neon_auth_session=",
		);
	});

	it("userinfo 401: finishLogin returns userinfo_rejected; callback answers 400 with no session cookie", async () => {
		fake.setUserinfoStatus(401);
		const { client } = make();
		expect(await client.finishLogin(callbackUrl, attempt)).toEqual({
			ok: false,
			reason: "userinfo_rejected",
		});
		const res = await client.handlers.callback(await callbackRequest());
		expect(res.status).toBe(400);
		expect(res.headers.get("set-cookie") ?? "").not.toContain(
			"neon_auth_session=",
		);
	});

	it.each([
		[["email"], "openid email"],
		[["email", "openid"], "openid email"],
	])("scopes %j always request openid and sign-in succeeds", async (scopes, expected) => {
		const { client } = make({ scopes });
		const { url } = await client.startLogin();
		expect(url.searchParams.get("scope")).toBe(expected);
		fake.setUserinfoClaims({ sub: "sub-1", email: "a@b.test" });
		fake.setIdTokenSub("sub-1");
		expect(await client.finishLogin(callbackUrl, attempt)).toMatchObject({
			ok: true,
		});
	});

	it("userinfo sub that differs from the ID token sub is rejected", async () => {
		fake.setUserinfoClaims({ sub: "someone-else", email: "x@y.test" });
		expect(await make().client.finishLogin(callbackUrl, attempt)).toEqual({
			ok: false,
			reason: "userinfo_rejected",
		});
	});
});

describe("expected outcomes are returned values", () => {
	it("getSession / getUser", async () => {
		const { client } = make();
		expect(await client.getSession(anon())).toEqual({
			ok: false,
			reason: "no_session",
		});
		expect(await client.getSession(withCookie("garbage"))).toEqual({
			ok: false,
			reason: "invalid_session",
		});
		const other = await seal(session(), "y".repeat(32), "session", 600);
		expect(await client.getSession(withCookie(other))).toEqual({
			ok: false,
			reason: "invalid_session",
		});
		expect(
			await client.getSession(await sessionRequest(session(), -10)),
		).toEqual({
			ok: false,
			reason: "expired",
		});
		expect(
			await client.getSession(await sessionRequest(session())),
		).toEqual({
			ok: true,
			session: session({ expiresAt: expect.any(Number) }),
		});
		expect(await client.getUser(anon())).toEqual({
			ok: false,
			reason: "no_session",
		});
		expect(await client.getUser(await sessionRequest(session()))).toEqual({
			ok: true,
			user,
		});
	});

	it("getAccessToken / withAccessToken", async () => {
		const { client } = make();
		expect(await client.getAccessToken(anon())).toEqual({
			ok: false,
			reason: "no_session",
		});
		expect(
			await client.getAccessToken(
				await sessionRequest(session({ refreshToken: undefined })),
			),
		).toEqual({ ok: false, reason: "refresh_unavailable" });
		await client.getAccessToken(await sessionRequest(session()));
		const replay = await sessionRequest(session());
		expect(await client.getAccessToken(replay)).toEqual({
			ok: false,
			reason: "refresh_failed",
		});
		expect(
			await client.withAccessToken(replay, () => new Response()),
		).toEqual({
			ok: false,
			reason: "refresh_failed",
		});
	});

	it("verifyAccessToken returns invalid_token with a code instead of throwing", async () => {
		const o = make();
		expect(
			await o.verifyAccessToken("garbage", { audience: AUD }),
		).toMatchObject({
			ok: false,
			reason: "invalid_token",
			code: "invalid_token",
		});
		expect(
			await o.verifyAccessToken(
				await fake.sign({}, { aud: "http://other" }),
				{ audience: AUD },
			),
		).toMatchObject({ ok: false, code: "invalid_audience" });
		expect(
			await o.verifyAccessToken(
				await fake.sign({}, { aud: AUD, sub: null }),
				{ audience: AUD },
			),
		).toMatchObject({ ok: false, code: "missing_sub" });
		expect(
			await o.verifyAccessToken(await fake.sign({}, { aud: AUD }), {
				audience: AUD,
			}),
		).toMatchObject({ ok: true, auth: { sub: "user-1" } });
		expect(
			await o.mcp({ resource: AUD }).verifyAccessToken("garbage"),
		).toMatchObject({
			ok: false,
			code: "invalid_token",
		});
	});

	it("finishLogin returns a failure for a forged state or a rejected code", async () => {
		const { client } = make();
		const attempt = { state: "s", codeVerifier: "v" };
		expect(
			await client.finishLogin(
				new URL(`${REDIRECT}?code=c&state=forged`),
				attempt,
			),
		).toEqual({ ok: false, reason: "invalid_callback" });
		expect(
			await client.finishLogin(
				new URL(`${REDIRECT}?error=access_denied&state=s`),
				attempt,
			),
		).toEqual({ ok: false, reason: "invalid_callback" });
		expect(
			await client.finishLogin(
				new URL(`${REDIRECT}?code=c&state=s`),
				attempt,
			),
		).toEqual({ ok: false, reason: "token_rejected" });
	});
});

describe("HTTP layer always responds", () => {
	it("bearer guard: 401 / 403 / 503, and onError sees the cause", async () => {
		const onError = vi.fn();
		const o = make();
		const guard = o.requireBearerAuth({
			requiredScopes: ["admin"],
			onError,
		});
		const bearer = (t: string) =>
			new Request(AUD, { headers: { authorization: `Bearer ${t}` } });

		const missing = (await guard(new Request(AUD))) as Response;
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toMatch(
			/^Bearer error="invalid_token"/,
		);
		const forbidden = (await guard(
			bearer(await fake.sign({}, { aud: AUD })),
		)) as Response;
		expect(forbidden.status).toBe(403);
		expect(onError).not.toHaveBeenCalled();

		fake.setDiscoveryStatus(500);
		const down = make({ discovery: { failureBackoffMs: 0 } });
		const unavailable = (await down.requireBearerAuth({ onError })(
			bearer("t.t.t"),
		)) as Response;
		expect(unavailable.status).toBe(503);
		expect(onError).toHaveBeenCalledWith(
			expect.any(AuthServerUnavailableError),
			expect.any(Request),
		);
	});

	it("login / callback handlers answer 503 when the server is down and call onError", async () => {
		const onError = vi.fn();
		fake.setDiscoveryStatus(500);
		const { client } = make({ onError });
		const login = await client.handlers.login(
			new Request("http://localhost:3000/auth/login"),
		);
		expect(login.status).toBe(503);
		const tx = await seal(
			{ state: "s", codeVerifier: "v", returnTo: "/" },
			SECRET,
			"tx",
			600,
		);
		const callback = await client.handlers.callback(
			new Request("http://localhost:3000/auth/callback?code=c&state=s", {
				headers: { cookie: `neon_auth_session_tx=${tx}` },
			}),
		);
		expect(callback.status).toBe(503);
		expect(onError).toHaveBeenCalledTimes(2);
	});

	it("callback handler answers 400 for a forged state", async () => {
		const { client } = make();
		const tx = await seal(
			{ state: "s", codeVerifier: "v", returnTo: "/" },
			SECRET,
			"tx",
			600,
		);
		const res = await client.handlers.callback(
			new Request(
				"http://localhost:3000/auth/callback?code=c&state=forged",
				{
					headers: { cookie: `neon_auth_session_tx=${tx}` },
				},
			),
		);
		expect(res.status).toBe(400);
	});
});
