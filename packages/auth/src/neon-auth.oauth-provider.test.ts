import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	test,
	vi,
} from "vitest";
import { NeonAuthAdapterCore } from "./core/adapter-core";
import { BETTER_AUTH_METHODS_CACHE } from "./core/better-auth-methods";
import { createAuthClient } from "./neon-auth";
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
});

describe("oauth2 client runtime", () => {
	const originalFetch = globalThis.fetch;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn(async () =>
			Response.json({ redirect_uri: "https://rp.example.com/cb" }),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.unstubAllGlobals();
		BETTER_AUTH_METHODS_CACHE.clearSessionCache();
	});

	const lastCall = () => {
		const [url, init] = fetchMock.mock.calls.at(-1) as [
			unknown,
			RequestInit,
		];
		return { url: String(url), init };
	};

	test("the oauth-provider client plugin is configured by default", () => {
		const adapter = new PluginIdsAdapter({
			baseURL: "https://auth.example.com",
		});
		expect(adapter.pluginIds()).toContain("oauth-provider-client");
	});

	test("consent POSTs to /oauth2/consent", async () => {
		const auth = createAuthClient("https://auth.example.com");
		await auth.oauth2.consent({ accept: true });
		const { url, init } = lastCall();
		expect(url).toBe("https://auth.example.com/api/auth/oauth2/consent");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toMatchObject({ accept: true });
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
		const auth = createAuthClient("https://auth.example.com");
		await auth.oauth2.consent({ accept: true });
		const body = JSON.parse(lastCall().init.body as string);
		expect(body.oauth_query).toBe(EXPECTED_OAUTH_QUERY);
	});

	test("sign-in carries the signed query of the page as oauth_query", async () => {
		vi.stubGlobal("window", { location: { search: SIGNED_SEARCH } });
		const auth = createAuthClient("https://auth.example.com");
		await auth.signIn.email({
			email: "a@b.com",
			password: "secret-password",
		});
		const { url, init } = lastCall();
		expect(url).toBe("https://auth.example.com/api/auth/sign-in/email");
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({ email: "a@b.com" });
		expect(body.oauth_query).toBe(EXPECTED_OAUTH_QUERY);
	});

	test("sign-in without a signed query carries no oauth_query", async () => {
		vi.stubGlobal("window", { location: { search: "?utm=1" } });
		const auth = createAuthClient("https://auth.example.com");
		await auth.signIn.email({
			email: "a@b.com",
			password: "secret-password",
		});
		const { url, init } = lastCall();
		expect(url).toBe("https://auth.example.com/api/auth/sign-in/email");
		const body = JSON.parse(init.body as string);
		expect(body).not.toHaveProperty("oauth_query");
		expect(body).toMatchObject({ email: "a@b.com" });
	});

	test("publicClient GETs /oauth2/public-client with client_id", async () => {
		const auth = createAuthClient("https://auth.example.com");
		await auth.oauth2.publicClient({ query: { client_id: "abc" } });
		const { url, init } = lastCall();
		expect(url).toBe(
			"https://auth.example.com/api/auth/oauth2/public-client?client_id=abc",
		);
		expect(init.method).toBe("GET");
	});

	test("a cached session does not short-circuit /oauth2/token", async () => {
		const now = new Date();
		BETTER_AUTH_METHODS_CACHE.setCachedSession({
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
		} as never);
		expect(BETTER_AUTH_METHODS_CACHE.getCachedSession()).not.toBeNull();

		const auth = createAuthClient("https://auth.example.com");
		const result = await auth.$fetch("/oauth2/token", {
			method: "POST",
			body: { grant_type: "authorization_code" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(lastCall().url).toBe(
			"https://auth.example.com/api/auth/oauth2/token",
		);
		expect(result.data).toEqual({
			redirect_uri: "https://rp.example.com/cb",
		});
	});

	test("a database named oauth2 still serves getSession from the cache", async () => {
		const now = new Date();
		const cached = {
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
		BETTER_AUTH_METHODS_CACHE.setCachedSession(cached as never);

		const auth = createAuthClient("https://ep.example.com/oauth2/auth");
		const result = await auth.getSession();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.data?.user.id).toBe("u1");
	});
});
