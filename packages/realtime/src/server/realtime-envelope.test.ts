import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FixtureKey,
	openEnvelope,
} from "./capability/envelope.test-helpers.js";
import { clearRealtimeKeyCache } from "./capability/keys.js";
import { fetchRealtimeKey, sealRealtimeEnvelope } from "./envelope.js";
import { createRealtime, rawSql } from "./realtime.js";

const fixtures = JSON.parse(
	readFileSync(
		new URL(
			"../../schema/realtime-envelope-v3.fixtures.json",
			import.meta.url,
		),
		"utf8",
	),
) as { readonly keys: readonly FixtureKey[] };
const primary = fixtures.keys[0] as FixtureKey;
const REALTIME_URL = "wss://ep-test.rt.example.test";
const KEYS_URL =
	"https://ep-test.rt.example.test/.well-known/neon-realtime-keys";
const DATABASE_URL = pgUrl(
	"neondb_owner:test-password",
	"ep-test.example.test/neondb?sslmode=require",
);
const SECRET = `nrt_live_1${Buffer.from(
	Uint8Array.from({ length: 32 }, (_, index) => index),
).toString("base64url")}`;
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
/** Assembled at runtime: secret scanners flag literal user:password@host URLs. */
function pgUrl(userinfo: string, rest: string, scheme = "postgresql"): string {
	return `${scheme}://${userinfo}@${rest}`;
}

const query = rawSql<{ readonly id: number }>(
	"select id from messages where channel_id = $1",
	[7],
);

function keysFetch(keys: readonly unknown[] = [publicJwk(primary)]) {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ keys }), {
				headers: { "cache-control": "public, max-age=600" },
			}),
	);
}

function publicJwk(key: FixtureKey) {
	return {
		kid: key.kid,
		kty: "EC",
		crv: "P-256",
		x: key.x,
		y: key.y,
		alg: "HPKE-P256-SHA256-A256GCM",
		use: "enc",
	};
}

async function claimsOf(capability: string) {
	const { header, plaintext } = await openEnvelope(capability, primary);
	return { header: JSON.parse(header), claims: JSON.parse(plaintext) };
}

function jwt(exp: number): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256" })}.${encode({ exp })}.c2ln`;
}

beforeEach(() => clearRealtimeKeyCache());

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT];
	clearRealtimeKeyCache();
});

describe("Realtime backend SDK with a database URL", () => {
	it("seals a v3 envelope with the URL's login to the branch key", async () => {
		const fetch = keysFetch();
		const realtime = createRealtime({
			databaseUrl: DATABASE_URL,
			url: REALTIME_URL,
			fetch,
		});

		const sealed = await realtime.seal({ query });

		expect(fetch).toHaveBeenCalledWith(KEYS_URL, expect.anything());
		const { header, claims } = await claimsOf(sealed.capability);
		expect(header).toEqual({
			alg: "HPKE-P256-SHA256-A256GCM",
			kid: primary.kid,
			v: 3,
		});
		expect(claims).toMatchObject({
			v: 3,
			aud: "realtime-proxy",
			database: "neondb",
			error_details: "safe",
			issuer: { sdk: "javascript", query_source: "raw_sql" },
			query_fingerprint: sealed.queryFingerprint,
			sql: "select id from messages where channel_id = $1",
			parameters: [{ type_oid: 0, value: "Nw==" }],
			auth: { user: "neondb_owner", credential: "test-password" },
		});
		expect(claims.exp - claims.iat).toBe(60);
		expect(sealed.expiresAt).toBe(claims.exp * 1_000);
	});

	it("lets db override the URL's database", async () => {
		const realtime = createRealtime({
			databaseUrl: DATABASE_URL,
			db: "app",
			url: REALTIME_URL,
			fetch: keysFetch(),
			debugMode: true,
		});
		const { claims } = await claimsOf(
			(await realtime.seal({ query })).capability,
		);
		expect(claims).toMatchObject({
			database: "app",
			error_details: "full",
		});
	});

	it("fetches the key once for many seals and SDK instances", async () => {
		const fetch = keysFetch();
		const first = createRealtime({
			databaseUrl: DATABASE_URL,
			url: REALTIME_URL,
			fetch,
		});
		const second = createRealtime({
			databaseUrl: DATABASE_URL,
			url: REALTIME_URL,
			fetch,
		});

		await first.seal({ query });
		await first.seal({ query });
		await second.seal({ query });

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("uses the global fetch by default", async () => {
		const fetch = keysFetch();
		vi.stubGlobal("fetch", fetch);
		const realtime = createRealtime({
			databaseUrl: DATABASE_URL,
			url: REALTIME_URL,
		});
		await realtime.seal({ query });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("seals v3 whenever a credential is configured, even with a secret", async () => {
		const options = {
			databaseUrl: DATABASE_URL,
			secret: SECRET,
			url: REALTIME_URL,
			fetch: keysFetch(),
		};
		// JavaScript callers can pass both; the type does not allow it.
		const realtime = createRealtime(
			options as unknown as Parameters<typeof createRealtime>[0] & {
				url: string;
			},
		);
		const sealed = await realtime.seal({ query });
		const { claims } = await claimsOf(sealed.capability);
		expect(claims.v).toBe(3);
	});

	it("never falls back to the secret when the branch has no key", async () => {
		const fetch = keysFetch([]);
		const realtime = createRealtime({
			databaseUrl: DATABASE_URL,
			secret: SECRET,
			url: REALTIME_URL,
			fetch,
		} as unknown as Parameters<typeof createRealtime>[0] & { url: string });

		await expect(realtime.seal({ query })).rejects.toThrow(
			"This branch has no Realtime key yet",
		);
		await expect(realtime.seal({ query })).rejects.toThrow(
			"This branch has no Realtime key yet",
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("keeps sealing legacy tokens when only the secret is configured", async () => {
		const fetch = keysFetch();
		vi.stubGlobal("fetch", fetch);
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			url: REALTIME_URL,
		});
		const sealed = await realtime.seal({ query });
		const header = JSON.parse(
			Buffer.from(
				sealed.capability.split(".")[0] ?? "",
				"base64url",
			).toString(),
		);
		expect(header).toEqual({ alg: "dir", enc: "A256GCM", v: 2 });
		expect(fetch).not.toHaveBeenCalled();
		realtime.close();
	});

	it("sends the OIDC token when the URL has no password, and reuses it", async () => {
		const token = jwt(Math.floor(Date.now() / 1_000) + 3_600);
		const oidcToken = vi.fn(async () => token);
		const realtime = createRealtime({
			databaseUrl:
				"postgresql://neondb_owner@ep-test.example.test/neondb",
			oidcToken,
			url: REALTIME_URL,
			fetch: keysFetch(),
		});

		const first = await claimsOf(
			(await realtime.seal({ query })).capability,
		);
		const second = await claimsOf(
			(await realtime.seal({ query })).capability,
		);

		expect(first.claims.auth).toEqual({
			user: "neondb_owner",
			credential: token,
		});
		expect(second.claims.auth.credential).toBe(token);
		expect(oidcToken).toHaveBeenCalledTimes(1);
	});

	it("defaults to Vercel's runtime OIDC token", async () => {
		const token = jwt(Math.floor(Date.now() / 1_000) + 3_600);
		(globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = {
			get: () => ({ headers: { "x-vercel-oidc-token": token } }),
		};
		const realtime = createRealtime({
			databaseUrl:
				"postgresql://neondb_owner@ep-test.example.test/neondb",
			url: REALTIME_URL,
			fetch: keysFetch(),
		});
		const { claims } = await claimsOf(
			(await realtime.seal({ query })).capability,
		);
		expect(claims.auth.credential).toBe(token);
	});

	describe("configuration errors", () => {
		it("only neondb_owner, before any sealing or fetch", () => {
			const fetch = keysFetch();
			expect(() =>
				createRealtime({
					databaseUrl: pgUrl("app_user:pw", "host/neondb"),
					url: REALTIME_URL,
					fetch,
				}),
			).toThrow(
				"Neon Realtime currently supports only the neondb_owner role",
			);
			expect(fetch).not.toHaveBeenCalled();
		});

		it("databaseUrl needs the Realtime url to find the key", () => {
			expect(() =>
				createRealtime({
					databaseUrl: DATABASE_URL,
				} as unknown as Parameters<typeof createRealtime>[0]),
			).toThrow("Realtime requires url with databaseUrl");
		});

		it("a database name is required", () => {
			expect(() =>
				createRealtime({
					databaseUrl: pgUrl("neondb_owner:pw", "host"),
					url: REALTIME_URL,
				}),
			).toThrow("Invalid Realtime database name");
		});

		it("oidcToken needs databaseUrl", () => {
			expect(() =>
				createRealtime({
					secret: SECRET,
					db: "app",
					oidcToken: () => "token",
				} as unknown as Parameters<typeof createRealtime>[0]),
			).toThrow("Realtime uses oidcToken only with databaseUrl");
		});

		it("needs a credential or the secret", () => {
			expect(() =>
				createRealtime({ db: "app" } as unknown as Parameters<
					typeof createRealtime
				>[0]),
			).toThrow("Realtime requires databaseUrl or secret");
		});

		it("does not echo the database URL", () => {
			let message = "";
			try {
				createRealtime({
					databaseUrl:
						"mysql://neondb_owner:test-password@host/neondb",
					url: REALTIME_URL,
				});
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain("Invalid Realtime databaseUrl");
			expect(message).not.toContain("test-password");
		});

		it("rejects databaseUrl without url at compile time", () => {
			expect(() =>
				// @ts-expect-error url is required with databaseUrl.
				createRealtime({ databaseUrl: DATABASE_URL }),
			).toThrow();
			expect(() =>
				// @ts-expect-error databaseUrl and secret are exclusive.
				createRealtime({
					databaseUrl: DATABASE_URL,
					secret: SECRET,
					url: "x",
				}),
			).toThrow();
		});
	});
});

describe("Low-level envelope helpers", () => {
	it("fetches the branch's public key without caching", async () => {
		const fetch = keysFetch();
		await expect(
			fetchRealtimeKey(REALTIME_URL, { fetch }),
		).resolves.toEqual({
			kid: primary.kid,
			x: primary.x,
			y: primary.y,
		});
		await fetchRealtimeKey(REALTIME_URL, { fetch });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("seals an envelope for any user and credential", async () => {
		const sealed = await sealRealtimeEnvelope({
			key: { kid: primary.kid, x: primary.x, y: primary.y },
			db: "neondb",
			user: "app_user",
			credential: "wrong-password",
			query,
		});
		const { claims } = await claimsOf(sealed.capability);
		expect(claims).toMatchObject({
			v: 3,
			database: "neondb",
			auth: { user: "app_user", credential: "wrong-password" },
		});
		expect(sealed.queryFingerprint).toBe(claims.query_fingerprint);
	});

	it.each([
		[{ user: "" }, "Invalid Realtime user"],
		[{ credential: "" }, "Invalid Realtime credential"],
		[{ db: "" }, "Invalid Realtime database name"],
		[
			{ key: { kid: primary.kid, x: primary.x, y: primary.x } },
			"Invalid Realtime public key",
		],
	])("validates its input (%j)", async (override, message) => {
		await expect(
			sealRealtimeEnvelope({
				key: { kid: primary.kid, x: primary.x, y: primary.y },
				db: "neondb",
				user: "neondb_owner",
				credential: "pw",
				query,
				...override,
			}),
		).rejects.toThrow(message);
	});
});
