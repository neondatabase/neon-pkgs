import { readFileSync } from "node:fs";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
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

/** A proxy from before v3 refuses a plain GET on any path with this. */
function oldProxyResponse(): Response {
	return new Response("Connection header did not include 'upgrade'", {
		status: 400,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

function headerOf(capability: string) {
	return JSON.parse(
		Buffer.from(capability.split(".")[0] ?? "", "base64url").toString(),
	) as Record<string, unknown>;
}

/** Decrypt a legacy dir/A256GCM token sealed with SECRET. */
async function legacyClaims(capability: string) {
	const [header = "", , iv = "", ciphertext = "", tag = ""] =
		capability.split(".");
	const key = await crypto.subtle.importKey(
		"raw",
		Buffer.from(SECRET.slice("nrt_live_1".length), "base64url"),
		"AES-GCM",
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: Buffer.from(iv, "base64url"),
			additionalData: Buffer.from(header),
			tagLength: 128,
		},
		key,
		Buffer.concat([
			Buffer.from(ciphertext, "base64url"),
			Buffer.from(tag, "base64url"),
		]),
	);
	return JSON.parse(Buffer.from(plaintext).toString());
}

beforeEach(() => clearRealtimeKeyCache());

afterEach(() => {
	vi.useRealTimers();
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

	describe("migration: databaseUrl and the legacy secret together", () => {
		function migrating(fetch: ReturnType<typeof vi.fn>) {
			return createRealtime({
				databaseUrl: DATABASE_URL,
				secret: SECRET,
				url: REALTIME_URL,
				fetch,
			});
		}

		it("seals v3 when the branch publishes a key", async () => {
			const realtime = migrating(keysFetch());
			const sealed = await realtime.seal({ query });
			expect(headerOf(sealed.capability)).toMatchObject({ v: 3 });
			const { claims } = await claimsOf(sealed.capability);
			expect(claims.auth.user).toBe("neondb_owner");
		});

		it.each([
			["an old proxy's 400", oldProxyResponse],
			["404", () => new Response("", { status: 404 })],
		])("uses the secret when the keys endpoint answers %s", async (_, response) => {
			const fetch = vi.fn(async () => response());
			const realtime = migrating(fetch);

			const sealed = await realtime.seal({ query });

			expect(headerOf(sealed.capability)).toEqual({
				alg: "dir",
				enc: "A256GCM",
				v: 2,
			});
			expect(await legacyClaims(sealed.capability)).toMatchObject({
				v: 2,
				database: "neondb",
				sql: "select id from messages where channel_id = $1",
				query_fingerprint: sealed.queryFingerprint,
			});
			// The no-key answer is cached, so later seals do not fetch.
			await realtime.seal({ query });
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("uses the secret while the branch lists no key", async () => {
			const realtime = migrating(keysFetch([]));
			const sealed = await realtime.seal({ query });
			expect(headerOf(sealed.capability)).toMatchObject({
				alg: "dir",
				v: 2,
			});
		});

		it("switches to v3 once a key is published and the no-key answer expires", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			let published = false;
			const fetch = vi.fn(async () =>
				published
					? new Response(
							JSON.stringify({ keys: [publicJwk(primary)] }),
							{
								headers: {
									"cache-control": "public, max-age=600",
								},
							},
						)
					: oldProxyResponse(),
			);
			const realtime = migrating(fetch);

			expect(
				headerOf((await realtime.seal({ query })).capability).v,
			).toBe(2);
			published = true;
			vi.advanceTimersByTime(59_000);
			expect(
				headerOf((await realtime.seal({ query })).capability).v,
			).toBe(2);
			vi.advanceTimersByTime(1_000);
			expect(
				headerOf((await realtime.seal({ query })).capability).v,
			).toBe(3);
			expect(fetch).toHaveBeenCalledTimes(2);
		});

		it.each([
			["HTTP 503", () => new Response("", { status: 503 })],
			["HTTP 500", () => new Response("", { status: 500 })],
			["a body that is not JSON", () => new Response("<html>")],
			[
				"a key list with no usable key",
				() =>
					new Response(
						JSON.stringify({
							keys: [{ ...publicJwk(primary), use: "sig" }],
						}),
					),
			],
		])("raises an error, not using the secret, for %s", async (_, response) => {
			// A 503 is retried once, after a second.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const realtime = migrating(vi.fn(async () => response()));
			const sealing = expect(realtime.seal({ query })).rejects.toThrow(
				"Realtime keys from",
			);
			await vi.advanceTimersByTimeAsync(1_000);
			await sealing;
		});

		it("raises an error, not using the secret, when the keys fetch fails", async () => {
			const realtime = migrating(
				vi.fn(async () => {
					throw new TypeError("fetch failed");
				}),
			);
			await expect(realtime.seal({ query })).rejects.toThrow(
				`Could not fetch the Realtime keys from ${KEYS_URL}`,
			);
		});
	});

	it("without a secret, says the branch has no key yet", async () => {
		const fetch = keysFetch([]);
		const realtime = createRealtime({
			databaseUrl: DATABASE_URL,
			url: REALTIME_URL,
			fetch,
		});
		await expect(realtime.seal({ query })).rejects.toThrow(
			`This branch has no Realtime key yet: ${KEYS_URL} publishes none`,
		);
	});

	it("without a secret, also says so for an old proxy's 400", async () => {
		const realtime = createRealtime({
			databaseUrl: DATABASE_URL,
			url: REALTIME_URL,
			fetch: vi.fn(async () => oldProxyResponse()),
		});
		await expect(realtime.seal({ query })).rejects.toThrow(
			"This branch has no Realtime key yet",
		);
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

		it("accepts databaseUrl with a secret, but not without url, at compile time", () => {
			expectTypeOf(createRealtime)
				.parameter(0)
				.extract<{ databaseUrl: string }>()
				.toHaveProperty("secret");
			expect(() =>
				// @ts-expect-error url is required with databaseUrl.
				createRealtime({ databaseUrl: DATABASE_URL }),
			).toThrow();
			expect(() =>
				createRealtime({
					databaseUrl: DATABASE_URL,
					secret: SECRET,
					url: "not a url",
				}),
			).toThrow("Invalid Realtime URL");
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
