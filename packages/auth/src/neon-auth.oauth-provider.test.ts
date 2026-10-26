import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	expectTypeOf,
	test,
	vi,
} from "vitest";
import { NeonAuthAdapterCore } from "./core/adapter-core";
import { BETTER_AUTH_METHODS_CACHE } from "./core/better-auth-methods";
import { createAuthClient } from "./neon-auth";
import {
	type LocalBetterAuth,
	startLocalBetterAuth,
} from "./test/local-better-auth";
import type { BetterAuthInstance } from "./types";

class PluginIdsAdapter extends NeonAuthAdapterCore {
	getBetterAuthInstance(): BetterAuthInstance {
		return {} as BetterAuthInstance;
	}

	pluginIds() {
		return this.betterAuthOptions.plugins.map((plugin) => plugin.id);
	}
}

describe("oauth2 client types", () => {
	test("the default client exposes oauth2", () => {
		const auth = createAuthClient("https://auth.example.com");
		expectTypeOf(auth).toHaveProperty("oauth2");
		expectTypeOf(auth.oauth2).toHaveProperty("consent");
		expectTypeOf(auth.oauth2).toHaveProperty("publicClient");
	});

	test("the oauth-provider client plugin is configured by default", () => {
		const adapter = new PluginIdsAdapter({
			baseURL: "https://auth.example.com",
		});
		expect(adapter.pluginIds()).toContain("oauth-provider-client");
	});
});

describe("oauth2 client against Better Auth with the OAuth provider", () => {
	let local: LocalBetterAuth;

	beforeAll(async () => {
		local = await startLocalBetterAuth();
	});

	afterAll(async () => {
		await local.close();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		BETTER_AUTH_METHODS_CACHE.clearSessionCache();
	});

	const signedOut = { status: 401 };
	// The provider verifies `sig` before anything else, so a forged one is
	// rejected as invalid input rather than as a missing session.
	const forgedSignature = { status: 400, code: "validation_failed" };

	const cachedSession = () => {
		const now = new Date();
		return {
			session: {
				id: "s1",
				userId: "u1",
				token: "tok",
				expiresAt: new Date(Date.now() + 3_600_000),
				createdAt: now,
				updatedAt: now,
			},
			user: {
				id: "u1",
				email: "a@b.com",
				name: "A",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		};
	};

	test("consent POSTs to /oauth2/consent", async () => {
		const auth = createAuthClient(local.authUrl);
		await expect(
			auth.oauth2.consent({ accept: true }),
		).rejects.toMatchObject(signedOut);
		const request = local.last();
		expect(`${request.method} ${request.path}`).toBe(
			"POST /api/auth/oauth2/consent",
		);
		expect(request.body).toMatchObject({ accept: true });
	});

	const SIGNED_SEARCH =
		"?client_id=abc&scope=openid%20profile&exp=4102444800&utm=1&sig=s1" +
		"&ba_param=client_id&ba_param=scope&ba_param=exp&ba_param=ba_param";
	// Mirrors the plugin's buildSignedOAuthQuery: signed names plus `sig`, in
	// URL order, with unsigned params (utm) dropped.
	const EXPECTED_OAUTH_QUERY =
		"client_id=abc&scope=openid+profile&exp=4102444800&sig=s1" +
		"&ba_param=client_id&ba_param=scope&ba_param=exp&ba_param=ba_param";

	test("consent carries the signed query of the page as oauth_query", async () => {
		vi.stubGlobal("window", { location: { search: SIGNED_SEARCH } });
		const auth = createAuthClient(local.authUrl);
		await expect(
			auth.oauth2.consent({ accept: true }),
		).rejects.toMatchObject(forgedSignature);
		expect(local.last().body).toMatchObject({
			oauth_query: EXPECTED_OAUTH_QUERY,
		});
	});

	test("sign-in carries the signed query of the page as oauth_query", async () => {
		vi.stubGlobal("window", { location: { search: SIGNED_SEARCH } });
		const auth = createAuthClient(local.authUrl);
		await expect(
			auth.signIn.email({
				email: "a@b.com",
				password: "secret-password",
			}),
		).rejects.toMatchObject(forgedSignature);
		const request = local.last();
		expect(request.path).toBe("/api/auth/sign-in/email");
		expect(request.body).toMatchObject({
			email: "a@b.com",
			oauth_query: EXPECTED_OAUTH_QUERY,
		});
	});

	test("sign-in without a signed query carries no oauth_query", async () => {
		vi.stubGlobal("window", { location: { search: "?utm=1" } });
		const auth = createAuthClient(local.authUrl);
		await expect(
			auth.signIn.email({
				email: "a@b.com",
				password: "secret-password",
			}),
		).rejects.toMatchObject(signedOut);
		const request = local.last();
		expect(request.path).toBe("/api/auth/sign-in/email");
		expect(request.body).toMatchObject({ email: "a@b.com" });
		expect(request.body).not.toHaveProperty("oauth_query");
	});

	test("publicClient GETs /oauth2/public-client with client_id", async () => {
		const auth = createAuthClient(local.authUrl);
		await expect(
			auth.oauth2.publicClient({ query: { client_id: "abc" } }),
		).rejects.toMatchObject(signedOut);
		const request = local.last();
		expect(`${request.method} ${request.path}`).toBe(
			"GET /api/auth/oauth2/public-client",
		);
		expect(request.query.get("client_id")).toBe("abc");
	});

	test("a cached session does not short-circuit /oauth2/token", async () => {
		BETTER_AUTH_METHODS_CACHE.setCachedSession(cachedSession() as never);
		expect(BETTER_AUTH_METHODS_CACHE.getCachedSession()).not.toBeNull();
		const before = local.received.length;

		const auth = createAuthClient(local.authUrl);
		// The token endpoint only accepts form bodies; the 415 shows the request
		// reached it instead of being answered from the session cache.
		await expect(
			auth.$fetch("/oauth2/token", {
				method: "POST",
				body: { grant_type: "authorization_code" },
			}),
		).rejects.toMatchObject({ status: 415 });
		expect(local.received.length).toBe(before + 1);
		expect(local.last().path).toBe("/api/auth/oauth2/token");
	});

	test("a database named oauth2 still serves getSession from the cache", async () => {
		BETTER_AUTH_METHODS_CACHE.setCachedSession(cachedSession() as never);
		const before = local.received.length;

		const auth = createAuthClient(`${local.origin}/oauth2/auth`);
		const result = await auth.getSession();
		expect(local.received.length).toBe(before);
		expect(result.data?.user.id).toBe("u1");
	});
});
