import { decodeBase64UrlStrict } from "./crypto.js";
import { ENVELOPE_ALG, type EnvelopeKey, envelopeSuite } from "./envelope.js";

const KEYS_PATH = "/.well-known/neon-realtime-keys";
const MAX_CACHE_SECONDS = 600;
// A branch without a key gets one when Neon provisions it. Check again soon.
const NO_KEY_CACHE_SECONDS = 60;
const FETCH_TIMEOUT_MS = 10_000;
const KID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;

/** Fetch implementation used for the keys endpoint. */
export type RealtimeFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

/** Public half of a branch's current Realtime key, as JWK coordinates. */
export interface RealtimePublicKey {
	/** Key ID, 16 bytes in base64url. */
	readonly kid: string;
	/** P-256 x coordinate, 32 bytes in base64url. */
	readonly x: string;
	/** P-256 y coordinate, 32 bytes in base64url. */
	readonly y: string;
}

interface ResolvedKey extends EnvelopeKey {
	readonly jwk: RealtimePublicKey;
}

/**
 * The branch's key, or `undefined` when the branch definitely publishes none:
 * the endpoint answers 404, as a proxy from before v3 does, or lists no keys.
 */
export type RealtimeKeyLookup = ResolvedKey | undefined;

interface CacheEntry {
	value?: RealtimeKeyLookup;
	expiresAt: number;
	pending?: Promise<RealtimeKeyLookup>;
}

// Shared per keys URL, so apps that create the SDK per request still fetch the
// key at most once per cache period.
const cache = new Map<string, CacheEntry>();

/** @internal Tests only. */
export function clearRealtimeKeyCache(): void {
	cache.clear();
}

/**
 * The keys endpoint on the Realtime host: `wss://` becomes `https://` and
 * `ws://` becomes `http://`, keeping the host and port.
 */
export function realtimeKeysUrl(realtimeUrl: string): string {
	let url: URL;
	try {
		url = new URL(realtimeUrl);
	} catch {
		throw new Error("Invalid Realtime URL");
	}
	if (url.protocol === "wss:") url.protocol = "https:";
	else if (url.protocol === "ws:") url.protocol = "http:";
	else if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Invalid Realtime URL");
	}
	url.username = "";
	url.password = "";
	url.pathname = KEYS_PATH;
	url.search = "";
	url.hash = "";
	return url.href;
}

/**
 * Return the branch key, cached as the endpoint's Cache-Control allows, or
 * `undefined` when the branch publishes no key, cached for 60 s. Throws when
 * the answer can't be trusted either way.
 */
export async function cachedRealtimeKey(
	keysUrl: string,
	fetchImpl?: RealtimeFetch,
	clock: () => number = Date.now,
): Promise<RealtimeKeyLookup> {
	let entry = cache.get(keysUrl);
	if (entry && entry.expiresAt > 0 && clock() < entry.expiresAt) {
		return entry.value;
	}
	if (entry?.pending) return entry.pending;
	entry ??= { expiresAt: 0 };
	cache.set(keysUrl, entry);
	const current = entry;
	const pending = loadRealtimeKey(keysUrl, fetchImpl).then(
		({ key, cacheSeconds }) => {
			current.pending = undefined;
			current.value = key;
			current.expiresAt =
				cacheSeconds > 0 ? clock() + cacheSeconds * 1_000 : 0;
			return key;
		},
		(error: unknown) => {
			current.pending = undefined;
			current.value = undefined;
			current.expiresAt = 0;
			throw error;
		},
	);
	current.pending = pending;
	return pending;
}

/** The error when a branch publishes no key and no secret is configured. */
export function noRealtimeKeyError(keysUrl: string): Error {
	return new Error(
		`This branch has no Realtime key yet: ${keysUrl} publishes none`,
	);
}

/**
 * Fetch the endpoint once, without the cache.
 *
 * - A key: `key` is set, cached per Cache-Control.
 * - No key (404, or an empty list): `key` is undefined, cached for 60 s.
 * - Anything else (network error, timeout, other status, a body that is not
 *   a key list, or entries none of which is usable) throws, so the caller
 *   never takes a broken endpoint for a branch without keys.
 */
export async function loadRealtimeKey(
	keysUrl: string,
	fetchImpl: RealtimeFetch | undefined,
): Promise<{
	readonly key: RealtimeKeyLookup;
	readonly cacheSeconds: number;
}> {
	const fetchFunction = fetchImpl ?? globalThis.fetch;
	if (typeof fetchFunction !== "function") {
		throw new Error(
			"Realtime needs fetch() to get the branch key. Pass the fetch option.",
		);
	}
	let response: Response;
	try {
		response = await fetchFunction(keysUrl, {
			method: "GET",
			headers: { accept: "application/json" },
			// The SDK caches the key itself, by Cache-Control. A framework's
			// fetch cache could otherwise keep a rotated key indefinitely.
			cache: "no-store",
			...(typeof AbortSignal !== "undefined" &&
			typeof AbortSignal.timeout === "function"
				? { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
				: {}),
		});
	} catch (cause) {
		throw new Error(`Could not fetch the Realtime keys from ${keysUrl}`, {
			cause,
		});
	}
	// A proxy from before v3 has no keys endpoint.
	if (response.status === 404) {
		return { key: undefined, cacheSeconds: NO_KEY_CACHE_SECONDS };
	}
	if (response.status !== 200) {
		throw new Error(
			`Could not fetch the Realtime keys from ${keysUrl}: HTTP ${response.status}`,
		);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		throw new Error(`The Realtime keys from ${keysUrl} are not JSON`, {
			cause,
		});
	}
	if (!isRecord(body) || !Array.isArray(body.keys)) {
		throw new Error(`The Realtime keys from ${keysUrl} are not a key list`);
	}
	if (body.keys.length === 0) {
		return { key: undefined, cacheSeconds: NO_KEY_CACHE_SECONDS };
	}
	const key = await firstUsableKey(body.keys);
	if (!key) {
		throw new Error(
			`The Realtime keys from ${keysUrl} list no key this SDK can use`,
		);
	}
	return { key, cacheSeconds: cacheSeconds(response.headers) };
}

async function firstUsableKey(
	entries: readonly unknown[],
): Promise<ResolvedKey | undefined> {
	for (const entry of entries) {
		const key = await usableKey(entry);
		if (key) return key;
	}
	return undefined;
}

async function usableKey(entry: unknown): Promise<ResolvedKey | undefined> {
	if (
		!isRecord(entry) ||
		entry.kty !== "EC" ||
		entry.crv !== "P-256" ||
		entry.alg !== ENVELOPE_ALG ||
		entry.use !== "enc" ||
		typeof entry.kid !== "string" ||
		!KID_PATTERN.test(entry.kid) ||
		typeof entry.x !== "string" ||
		typeof entry.y !== "string"
	)
		return undefined;
	const jwk = { kid: entry.kid, x: entry.x, y: entry.y };
	try {
		return { ...(await importRealtimePublicKey(jwk)), jwk };
	} catch {
		return undefined;
	}
}

/** Import a public key; rejects coordinates that are not a P-256 point. */
export async function importRealtimePublicKey(
	key: RealtimePublicKey,
): Promise<EnvelopeKey> {
	if (typeof key.kid !== "string" || !KID_PATTERN.test(key.kid)) {
		throw new Error("Invalid Realtime key ID");
	}
	try {
		const x = decodeBase64UrlStrict(key.x);
		const y = decodeBase64UrlStrict(key.y);
		if (x.length !== 32 || y.length !== 32) throw new Error();
		const point = new Uint8Array(65);
		point[0] = 0x04;
		point.set(x, 1);
		point.set(y, 33);
		return {
			kid: key.kid,
			publicKey: await envelopeSuite().kem.deserializePublicKey(point),
		};
	} catch {
		throw new Error("Invalid Realtime public key");
	}
}

/** Honour `max-age` up to 600 s; cache nothing for `no-store` or no header. */
function cacheSeconds(headers: Headers): number {
	const directives = (headers.get("cache-control") ?? "")
		.toLowerCase()
		.split(",")
		.map((directive) => directive.trim());
	if (directives.includes("no-store") || directives.includes("no-cache")) {
		return 0;
	}
	for (const directive of directives) {
		const match = /^max-age=(\d+)$/.exec(directive);
		if (match) return Math.min(Number(match[1]), MAX_CACHE_SECONDS);
	}
	return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
