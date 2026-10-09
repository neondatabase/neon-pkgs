import { describe, expect, test } from "vitest";
import { createAuthClient } from "../src/index";
import {
	NEON_AUTH_LEGACY_SESSION_CHALLENGE_COOKIE_NAME,
	NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME,
	NEON_AUTH_SESSION_COOKIE_NAME,
} from "../src/server/constants";
import { SupabaseAuthAdapter } from "../src/vanilla/adapters";
import {
	authBaseUrl,
	installCookieFetch,
	jwksUrl,
	TEST_PASSWORD,
	uniqueEmail,
} from "./helpers";

/**
 * The unit suite answers every request from MSW, so it can prove the adapter's mapping
 * logic but not that the real service still sends what that logic assumes. This file
 * asserts on the wire itself, which is why it runs against a provisioned branch: the
 * raw `Set-Cookie` attributes, the `set-auth-jwt` handshake, and that the JWT's `kid`
 * actually resolves against the JWKS the Management API reported.
 */

describe("password session against the live service", () => {
	test("signup → session → JWT → sign-out round-trip", async () => {
		const jar = installCookieFetch();
		try {
			const client = createAuthClient(authBaseUrl(), {
				adapter: SupabaseAuthAdapter(),
			});
			const email = uniqueEmail();

			const signUp = await client.signUp({
				email,
				password: TEST_PASSWORD,
			});
			expect(signUp.error).toBeNull();
			// Email verification is off in the provisioning, so signup issues a session
			// immediately — if it does not, that configuration stopped working.
			expect(signUp.data.session).not.toBeNull();

			await client.signOut();
			const signIn = await client.signInWithPassword({
				email,
				password: TEST_PASSWORD,
			});
			expect(signIn.error).toBeNull();
			expect(signIn.data.session).not.toBeNull();
			expect(signIn.data.user?.email).toBe(email);

			const setCookies = jar.recorded.flatMap(
				(entry) => entry.setCookies,
			);
			const cookie = (name: string): string | undefined =>
				setCookies.find((value) => value.startsWith(`${name}=`));

			// The upstream session cookie is partitioned so it survives the iframe-based
			// sign-in flow the popup OAuth path exists for.
			const sessionToken = cookie(NEON_AUTH_SESSION_COOKIE_NAME);
			expect(
				sessionToken,
				`no ${NEON_AUTH_SESSION_COOKIE_NAME} Set-Cookie in ${JSON.stringify(setCookies)}`,
			).toBeDefined();
			// The challenge cookie (or its legacy misspelling) belongs to the OAuth path;
			// password sign-in does not set it, so it is only checked when present.
			const challenge =
				cookie(NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME) ??
				cookie(NEON_AUTH_LEGACY_SESSION_CHALLENGE_COOKIE_NAME);
			for (const value of [sessionToken, challenge]) {
				if (value === undefined) continue;
				expect(value).toMatch(/;\s*Secure/i);
				expect(value).toMatch(/SameSite=None/i);
				expect(value).toMatch(/Partitioned/i);
			}
			expect(sessionToken).toMatch(/;\s*HttpOnly/i);
			expect(
				Number(/Max-Age=(\d+)/i.exec(sessionToken as string)?.[1]),
			).toBeGreaterThan(0);

			// The session token is the JWT the service delivers via the set-auth-jwt
			// response header, not a cookie value — the recorded header is the only
			// proof of where it came from.
			const session = await client.getSession();
			expect(session.data.session).not.toBeNull();
			const accessToken = session.data.session?.access_token;
			expect(accessToken).toBeTruthy();
			const deliveredJwts = jar.recorded
				.map((entry) => entry.authJwt)
				.filter((value): value is string => value !== null);
			expect(
				deliveredJwts.includes(accessToken as string),
				"the session's access_token never arrived via a set-auth-jwt header",
			).toBe(true);
			expect(await client.getJWTToken(false)).toBe(accessToken);

			const claims = await client.getClaims();
			expect(claims.error).toBeNull();
			const { header, claims: payload } = claims.data as {
				header: { kid?: string };
				claims: { exp?: unknown; sub?: unknown };
			};
			// TokenCache derives its TTL by reading a numeric `exp` claim in seconds —
			// anything else breaks caching quietly, so assert it outright.
			expect(
				typeof payload.exp === "number" &&
					payload.exp > Date.now() / 1000,
			).toBe(true);
			expect(
				typeof payload.sub === "string" && payload.sub.length > 0,
			).toBe(true);
			const jwks = (await (await fetch(jwksUrl())).json()) as {
				keys: Array<{ kid?: string }>;
			};
			expect(
				jwks.keys.some((key) => key.kid === header.kid),
				`no key in ${jwksUrl()} matches the JWT kid ${String(header.kid)}`,
			).toBe(true);

			const signOut = await client.signOut();
			expect(signOut.error).toBeNull();
			const after = await client.getSession();
			expect(after.data.session).toBeNull();
		} finally {
			jar.restore();
		}
	});
});
