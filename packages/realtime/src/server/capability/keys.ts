import { decodeBase64UrlStrict } from "./crypto.js";
import { ENVELOPE_ALG, type EnvelopeKey, envelopeSuite } from "./envelope.js";

const KEYS_PATH = "/.well-known/neon-realtime-keys";
const MAX_CACHE_SECONDS = 600;
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

interface CacheEntry {
	key?: ResolvedKey;
	expiresAt: number;
	pending?: Promise<ResolvedKey>;
}

// Shared per keys URL, so apps that create the SDK per request still fetch the
// key at most once per Cache-Control period.
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

/** Return the branch key, cached as the endpoint's Cache-Control allows. */
export async function cachedRealtimeKey(
	keysUrl: string,
	fetchImpl?: RealtimeFetch,
	clock: () => number = Date.now,
): Promise<ResolvedKey> {
	let entry = cache.get(keysUrl);
	if (entry?.key && clock() < entry.expiresAt) return entry.key;
	if (entry?.pending) return entry.pending;
	entry ??= { expiresAt: 0 };
	cache.set(keysUrl, entry);
	const current = entry;
	const pending = loadRealtimeKey(keysUrl, fetchImpl).then(
		({ key, maxAgeSeconds }) => {
			current.pending = undefined;
			current.key = maxAgeSeconds > 0 ? key : undefined;
			current.expiresAt = clock() + maxAgeSeconds * 1_000;
			return key;
		},
		(error: unknown) => {
			current.pending = undefined;
			throw error;
		},
	);
	current.pending = pending;
	return pending;
}

/** Fetch the endpoint once, without the cache. */
export async function loadRealtimeKey(
	keysUrl: string,
	fetchImpl: RealtimeFetch | undefined,
): Promise<{ readonly key: ResolvedKey; readonly maxAgeSeconds: number }> {
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
	if (!response.ok) {
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
	const key = await firstUsableKey(body);
	if (!key) {
		// Never fall back to the legacy secret: the app configured credentials.
		throw new Error(
			`This branch has no Realtime key yet: ${keysUrl} lists no usable key`,
		);
	}
	return { key, maxAgeSeconds: cacheSeconds(response.headers) };
}

async function firstUsableKey(body: unknown): Promise<ResolvedKey | undefined> {
	if (!isRecord(body) || !Array.isArray(body.keys)) return undefined;
	for (const entry of body.keys) {
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
