import { decodeBase64UrlStrict } from "./crypto.js";
import { ENVELOPE_ALG, type EnvelopeKey, envelopeSuite } from "./envelope.js";

const KEYS_PATH = "/.well-known/neon-realtime-keys";
const MAX_CACHE_SECONDS = 600;
// A branch without a key gets one when Neon provisions it. Check again soon.
const NO_KEY_CACHE_SECONDS = 60;
// The keys endpoint lives on the branch's Realtime VM, and a fetch can start
// one: replica start, slot bootstrap and the proxy take longer than 10 s.
const FETCH_TIMEOUT_MS = 30_000;
// While a VM starts, the router and worker answer 502-504. Retry once.
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAY_MS = 1_000;
const KID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
// Switch to a key up to a minute after its use_since, so a client clock ahead
// of the proxy's never seals to a key the proxy doesn't open yet. The proxy
// keeps the previous key open for at least 15 minutes after the switch.
const SWITCH_LATENESS_MS = 60_000;

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

/** A listed key and the time, in seconds since the epoch, to seal to it from. */
export interface RealtimeListedKey {
	readonly key: ResolvedKey;
	readonly useSince: number;
}

/**
 * The branch's usable keys, never empty, or `undefined` when the branch
 * definitely publishes none: the endpoint answers 400 (a proxy from before v3)
 * or 404, or lists no keys.
 */
export type RealtimeKeySet = readonly RealtimeListedKey[] | undefined;

/** The key to seal to now, or `undefined` when the branch publishes none. */
export type RealtimeKeyLookup = ResolvedKey | undefined;

interface CacheEntry {
	value?: RealtimeKeySet;
	expiresAt: number;
	pending?: Promise<RealtimeKeySet>;
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
 * Return the key to seal to now, chosen from the key list cached as the
 * endpoint's Cache-Control allows, or `undefined` when the branch publishes no
 * key, cached for 60 s. Throws when the answer can't be trusted either way.
 */
export async function cachedRealtimeKey(
	keysUrl: string,
	fetchImpl?: RealtimeFetch,
	clock: () => number = Date.now,
): Promise<RealtimeKeyLookup> {
	const keys = await cachedRealtimeKeys(keysUrl, fetchImpl, clock);
	return keys && selectRealtimeKey(keys, clock());
}

async function cachedRealtimeKeys(
	keysUrl: string,
	fetchImpl: RealtimeFetch | undefined,
	clock: () => number,
): Promise<RealtimeKeySet> {
	let entry = cache.get(keysUrl);
	if (entry && entry.expiresAt > 0 && clock() < entry.expiresAt) {
		return entry.value;
	}
	if (entry?.pending) return entry.pending;
	entry ??= { expiresAt: 0 };
	cache.set(keysUrl, entry);
	const current = entry;
	const pending = loadRealtimeKeys(keysUrl, fetchImpl).then(
		({ keys, cacheSeconds }) => {
			current.pending = undefined;
			current.value = keys;
			current.expiresAt =
				cacheSeconds > 0 ? clock() + cacheSeconds * 1_000 : 0;
			return keys;
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
 * The key to seal to at `nowMs`: with `t` a minute before `nowMs`, the key
 * with the latest `useSince` at or before `t`, else the one with the earliest
 * `useSince`. On a tie, the one listed first.
 */
export function selectRealtimeKey(
	keys: readonly RealtimeListedKey[],
	nowMs: number,
): ResolvedKey {
	const t = nowMs - SWITCH_LATENESS_MS;
	let current: RealtimeListedKey | undefined;
	let earliest: RealtimeListedKey | undefined;
	for (const listed of keys) {
		if (
			listed.useSince * 1_000 <= t &&
			(!current || listed.useSince > current.useSince)
		) {
			current = listed;
		}
		if (!earliest || listed.useSince < earliest.useSince) earliest = listed;
	}
	const chosen = current ?? earliest;
	if (!chosen) throw new Error("No Realtime key to choose from");
	return chosen.key;
}

/**
 * Fetch the endpoint once, without the cache.
 *
 * - Keys: `keys` lists the usable ones, cached per Cache-Control.
 * - No key (400 or 404, or an empty list): `keys` is undefined, cached for
 *   60 s.
 * - Anything else (network error, timeout, other status, a body that is not
 *   a key list, or entries none of which is usable) throws, so the caller
 *   never takes a broken endpoint for a branch without keys.
 *
 * Each attempt has 30 s. A timeout or a 502, 503 or 504 is retried once,
 * after 1 s, since the request may be starting the branch's VM.
 */
export async function loadRealtimeKeys(
	keysUrl: string,
	fetchImpl: RealtimeFetch | undefined,
): Promise<{
	readonly keys: RealtimeKeySet;
	readonly cacheSeconds: number;
}> {
	const fetchFunction = fetchImpl ?? globalThis.fetch;
	if (typeof fetchFunction !== "function") {
		throw new Error(
			"Realtime needs fetch() to get the branch key. Pass the fetch option.",
		);
	}
	const response = await fetchWithRetry(keysUrl, fetchFunction);
	// A proxy from before v3 has no keys endpoint. It sends every path to its
	// WebSocket upgrade, which refuses a plain GET with 400. Every v3 proxy
	// answers 200 here, so 400 and 404 both mean the branch has no key.
	if (response.status === 400 || response.status === 404) {
		return { keys: undefined, cacheSeconds: NO_KEY_CACHE_SECONDS };
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
		return { keys: undefined, cacheSeconds: NO_KEY_CACHE_SECONDS };
	}
	const keys = await usableKeys(body.keys);
	if (keys.length === 0) {
		throw new Error(
			`The Realtime keys from ${keysUrl} list no key this SDK can use`,
		);
	}
	return { keys, cacheSeconds: cacheSeconds(response.headers) };
}

async function fetchWithRetry(
	keysUrl: string,
	fetchFunction: RealtimeFetch,
): Promise<Response> {
	for (let attempt = 1; ; attempt += 1) {
		const signal =
			typeof AbortSignal !== "undefined" &&
			typeof AbortSignal.timeout === "function"
				? AbortSignal.timeout(FETCH_TIMEOUT_MS)
				: undefined;
		const retry = attempt === 1;
		let response: Response;
		try {
			response = await fetchFunction(keysUrl, {
				method: "GET",
				headers: { accept: "application/json" },
				// The SDK caches the key itself, by Cache-Control. A framework's
				// fetch cache could otherwise keep a rotated key indefinitely.
				cache: "no-store",
				...(signal ? { signal } : {}),
			});
		} catch (cause) {
			if (retry && isTimeout(cause, signal)) {
				await delay(RETRY_DELAY_MS);
				continue;
			}
			throw new Error(
				`Could not fetch the Realtime keys from ${keysUrl}`,
				{
					cause,
				},
			);
		}
		if (retry && RETRY_STATUSES.has(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			await delay(RETRY_DELAY_MS);
			continue;
		}
		return response;
	}
}

function isTimeout(error: unknown, signal: AbortSignal | undefined): boolean {
	return (
		signal?.aborted === true ||
		(typeof error === "object" &&
			error !== null &&
			(error as { name?: unknown }).name === "TimeoutError")
	);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function usableKeys(
	entries: readonly unknown[],
): Promise<RealtimeListedKey[]> {
	const keys: RealtimeListedKey[] = [];
	for (const entry of entries) {
		const key = await usableKey(entry);
		if (key) keys.push(key);
	}
	return keys;
}

async function usableKey(
	entry: unknown,
): Promise<RealtimeListedKey | undefined> {
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
	// A proxy from before time windows lists one key without use_since.
	const useSince = "use_since" in entry ? entry.use_since : 0;
	if (!Number.isSafeInteger(useSince) || (useSince as number) < 0) {
		return undefined;
	}
	const jwk = { kid: entry.kid, x: entry.x, y: entry.y };
	try {
		return {
			key: { ...(await importRealtimePublicKey(jwk)), jwk },
			useSince: useSince as number,
		};
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
