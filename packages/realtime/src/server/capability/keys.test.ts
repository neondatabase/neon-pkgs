import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureKey } from "./envelope.test-helpers.js";
import {
	cachedRealtimeKey,
	clearRealtimeKeyCache,
	type RealtimeFetch,
	realtimeKeysUrl,
} from "./keys.js";

const fixtures = JSON.parse(
	readFileSync(
		new URL(
			"../../../schema/realtime-envelope-v3.fixtures.json",
			import.meta.url,
		),
		"utf8",
	),
) as { readonly keys: readonly FixtureKey[] };
const [primary, secondary] = fixtures.keys as [FixtureKey, FixtureKey];
const KEYS_URL =
	"https://ep-test.rt.example.test/.well-known/neon-realtime-keys";

function jwk(key: FixtureKey, overrides: Record<string, unknown> = {}) {
	return {
		kid: key.kid,
		kty: "EC",
		crv: "P-256",
		x: key.x,
		y: key.y,
		alg: "HPKE-P256-SHA256-A256GCM",
		use: "enc",
		...overrides,
	};
}

function keysResponse(
	keys: readonly unknown[],
	cacheControl: string | null = "public, max-age=600",
	status = 200,
): Response {
	return new Response(JSON.stringify({ keys }), {
		status,
		headers: {
			"content-type": "application/json",
			...(cacheControl === null ? {} : { "cache-control": cacheControl }),
		},
	});
}

function fetchReturning(
	...responses: (() => Response)[]
): RealtimeFetch & ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => {
		const next = responses.length > 1 ? responses.shift() : responses[0];
		if (!next) throw new Error("no response");
		return next();
	});
	return fetchMock as RealtimeFetch & typeof fetchMock;
}

async function keyFrom(fetchImpl: RealtimeFetch) {
	const key = await cachedRealtimeKey(KEYS_URL, fetchImpl);
	if (!key) throw new Error("expected a key");
	return key;
}

beforeEach(() => {
	clearRealtimeKeyCache();
	vi.useFakeTimers({ now: 1_767_225_600_000, toFake: ["Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	clearRealtimeKeyCache();
});

describe("Realtime keys endpoint URL", () => {
	it.each([
		[
			"wss://ep-a.rt.us-east-2.aws.neon.tech",
			"https://ep-a.rt.us-east-2.aws.neon.tech/.well-known/neon-realtime-keys",
		],
		[
			"wss://ep-a.rt.example.test:8443/socket?x=1#y",
			"https://ep-a.rt.example.test:8443/.well-known/neon-realtime-keys",
		],
		[
			"ws://127.0.0.1:3000/",
			"http://127.0.0.1:3000/.well-known/neon-realtime-keys",
		],
		[
			"https://ep-a.rt.example.test/",
			"https://ep-a.rt.example.test/.well-known/neon-realtime-keys",
		],
	])("maps %s to its keys endpoint", (url, expected) => {
		expect(realtimeKeysUrl(url)).toBe(expected);
	});

	it.each(["", "not a url", "ftp://example.test/"])("rejects %j", (url) => {
		expect(() => realtimeKeysUrl(url)).toThrow("Invalid Realtime URL");
	});
});

describe("Realtime key cache", () => {
	it("fetches without the framework's HTTP cache and returns the key", async () => {
		const fetchImpl = fetchReturning(() => keysResponse([jwk(primary)]));

		const key = await keyFrom(fetchImpl);

		expect(key.kid).toBe(primary.kid);
		expect(key.jwk).toEqual({
			kid: primary.kid,
			x: primary.x,
			y: primary.y,
		});
		expect(key.publicKey.type).toBe("public");
		expect(fetchImpl).toHaveBeenCalledWith(
			KEYS_URL,
			expect.objectContaining({
				method: "GET",
				cache: "no-store",
				headers: { accept: "application/json" },
			}),
		);
	});

	it("reuses the key for max-age seconds, then refetches", async () => {
		const fetchImpl = fetchReturning(
			() => keysResponse([jwk(primary)], "public, max-age=600"),
			() => keysResponse([jwk(secondary)], "public, max-age=600"),
		);

		expect((await keyFrom(fetchImpl)).kid).toBe(primary.kid);
		vi.advanceTimersByTime(599_000);
		expect((await keyFrom(fetchImpl)).kid).toBe(primary.kid);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1_000);
		expect((await keyFrom(fetchImpl)).kid).toBe(secondary.kid);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("caps max-age at 600 seconds", async () => {
		const fetchImpl = fetchReturning(() =>
			keysResponse([jwk(primary)], "max-age=86400"),
		);
		await cachedRealtimeKey(KEYS_URL, fetchImpl);
		vi.advanceTimersByTime(600_000);
		await cachedRealtimeKey(KEYS_URL, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it.each([
		["no-store", "no-store"],
		["no-cache", "no-cache, max-age=600"],
		["no Cache-Control", null],
		["max-age=0", "max-age=0"],
	])("caches nothing for %s", async (_, cacheControl) => {
		const fetchImpl = fetchReturning(() =>
			keysResponse([jwk(primary)], cacheControl),
		);
		await cachedRealtimeKey(KEYS_URL, fetchImpl);
		await cachedRealtimeKey(KEYS_URL, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("shares one request between concurrent callers", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl = vi.fn(async () => {
			await gate;
			return keysResponse([jwk(primary)]);
		});

		const pending = Promise.all([
			cachedRealtimeKey(KEYS_URL, fetchImpl),
			cachedRealtimeKey(KEYS_URL, fetchImpl),
			cachedRealtimeKey(KEYS_URL, fetchImpl),
		]);
		release();
		const keys = await pending;

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(new Set(keys).size).toBe(1);
	});

	it("does not cache a failure", async () => {
		const fetchImpl = fetchReturning(
			() => keysResponse([], "public, max-age=600", 503),
			() => keysResponse([jwk(primary)]),
		);
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			`Could not fetch the Realtime keys from ${KEYS_URL}: HTTP 503`,
		);
		expect((await keyFrom(fetchImpl)).kid).toBe(primary.kid);
	});

	it("reports a network failure with its cause", async () => {
		const cause = new TypeError("fetch failed");
		const fetchImpl = vi.fn(async () => {
			throw cause;
		});
		await expect(
			cachedRealtimeKey(KEYS_URL, fetchImpl),
		).rejects.toMatchObject({
			message: `Could not fetch the Realtime keys from ${KEYS_URL}`,
			cause,
		});
	});

	it.each([
		[
			"404, as from a proxy that predates v3",
			() => new Response("", { status: 404 }),
		],
		["an empty list", () => keysResponse([], "no-store")],
	])("reports no key for %s, and caches that for 60 s", async (_, response) => {
		const fetchImpl = fetchReturning(response, () =>
			keysResponse([jwk(primary)]),
		);

		await expect(
			cachedRealtimeKey(KEYS_URL, fetchImpl),
		).resolves.toBeUndefined();
		vi.advanceTimersByTime(59_000);
		await expect(
			cachedRealtimeKey(KEYS_URL, fetchImpl),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		// A key published since then is picked up once the answer expires.
		vi.advanceTimersByTime(1_000);
		expect((await keyFrom(fetchImpl)).kid).toBe(primary.kid);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it.each([
		["the wrong kty", [jwk(primary, { kty: "OKP" })]],
		["the wrong crv", [jwk(primary, { crv: "P-384" })]],
		["the wrong alg", [jwk(primary, { alg: "ECDH-ES" })]],
		["the wrong use", [jwk(primary, { use: "sig" })]],
		["a malformed kid", [jwk(primary, { kid: "short" })]],
		["padded coordinates", [jwk(primary, { x: `${primary.x}=` })]],
		[
			"a point off the curve",
			[
				jwk(primary, {
					y: primary.x === primary.y ? secondary.y : primary.x,
				}),
			],
		],
	])("cannot tell, and throws, for %s", async (_, keys) => {
		const fetchImpl = fetchReturning(() => keysResponse(keys));
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			`The Realtime keys from ${KEYS_URL} list no key this SDK can use`,
		);
	});

	it.each([
		[500, "Internal Server Error"],
		[502, "Bad Gateway"],
		[503, "Service Unavailable"],
		[403, "Forbidden"],
		[405, "Method Not Allowed"],
	])("cannot tell, and throws, for HTTP %i", async (status) => {
		const fetchImpl = fetchReturning(
			() => new Response("", { status }),
			() => keysResponse([jwk(primary)]),
		);
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			`Could not fetch the Realtime keys from ${KEYS_URL}: HTTP ${status}`,
		);
		// Not cached: the next call asks again.
		expect((await keyFrom(fetchImpl)).kid).toBe(primary.kid);
	});

	it.each([
		["a body without keys", { status: "ok" }],
		["keys that are not a list", { keys: {} }],
		["a list body", []],
	])("cannot tell, and throws, for %s", async (_, body) => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(body), { status: 200 }),
		);
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			`The Realtime keys from ${KEYS_URL} are not a key list`,
		);
	});

	it("does not cache a no-key answer past a failure", async () => {
		const fetchImpl = fetchReturning(
			() => new Response("", { status: 404 }),
			() => new Response("", { status: 503 }),
		);
		await cachedRealtimeKey(KEYS_URL, fetchImpl);
		vi.advanceTimersByTime(60_000);
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			"HTTP 503",
		);
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			"HTTP 503",
		);
	});

	it("skips unusable entries and takes the first usable key", async () => {
		const fetchImpl = fetchReturning(() =>
			keysResponse([jwk(primary, { use: "sig" }), jwk(secondary)]),
		);
		expect((await keyFrom(fetchImpl)).kid).toBe(secondary.kid);
	});

	it("rejects a body that is not JSON", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("<html>", { status: 200 }),
		);
		await expect(cachedRealtimeKey(KEYS_URL, fetchImpl)).rejects.toThrow(
			`The Realtime keys from ${KEYS_URL} are not JSON`,
		);
	});
});
