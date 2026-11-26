import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { BETTER_AUTH_METHODS_CACHE } from "./core/better-auth-methods";
import { createAuthClient } from "./neon-auth";
import {
	type LocalBetterAuth,
	startLocalBetterAuth,
} from "./test/local-better-auth";

/** Node's fetch keeps no cookies, so the session cookie is carried by hand. */
function stubCookieFetch(origin: string): void {
	const jar = new Map<string, string>();
	const realFetch = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.set("origin", origin);
			if (jar.size > 0) {
				headers.set("cookie", [...jar.values()].join("; "));
			}
			const response = await realFetch(input, { ...init, headers });
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(";")[0] ?? "";
				jar.set(pair.slice(0, pair.indexOf("=")), pair);
			}
			return response;
		},
	);
}

describe("token() against Better Auth with the JWT plugin", () => {
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

	test("returns { token } from /token after getSession() filled the session cache", async () => {
		stubCookieFetch(local.origin);
		const auth = createAuthClient(local.authUrl);
		const signUp = await auth.signUp.email({
			email: "token@example.com",
			password: "secret-password",
			name: "Token",
		});
		expect(signUp.error).toBeNull();

		const session = await auth.getSession();
		expect(session.data?.user.email).toBe("token@example.com");
		expect(BETTER_AUTH_METHODS_CACHE.getCachedSession()).not.toBeNull();
		const before = local.received.length;

		const result = await auth.token();
		expect(local.received.length).toBe(before + 1);
		expect(local.last().path).toBe("/api/auth/token");
		expect(result.data).toEqual({ token: expect.any(String) });
		const [, payload] = (result.data?.token ?? "").split(".");
		expect(
			JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
		).toMatchObject({ sub: session.data?.user.id });
	});
});
