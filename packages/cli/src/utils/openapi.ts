// Spec loader for `neon api --list` and `neon api <path> --describe`.
// `neon api <path>` request mode does not use this module — it is a pure
// passthrough — so a stale or unreachable spec never blocks a real API call.
// Listing and describe degrade gracefully: fresh cache → live fetch → stale
// cache → clear error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	describeEndpoint,
	type EndpointDescription,
	EndpointNotFoundError,
	fetchOpenApiSpec,
	listEndpoints,
	NEON_OPENAPI_SPEC_URL,
	type OpenApiSpec,
} from "@neon/sdk/openapi";

import { log } from "../log.js";

export const DEFAULT_SPEC_URL = NEON_OPENAPI_SPEC_URL;
export { listEndpoints as getEndpoints };

const CACHE_FILE = "openapi-spec.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CachedSpec = {
	fetchedAt: number;
	specUrl: string;
	spec: OpenApiSpec;
};

function readCache(cachePath: string): CachedSpec | null {
	try {
		return JSON.parse(readFileSync(cachePath, "utf8")) as CachedSpec;
	} catch {
		return null;
	}
}

function writeCache(cachePath: string, data: CachedSpec): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(data));
	} catch (err) {
		log.debug("Failed to cache OpenAPI spec: %s", err);
	}
}

/**
 * Load the Neon OpenAPI spec, preferring a fresh on-disk cache, then a live
 * fetch (which refreshes the cache), then a stale cache as a last resort.
 * Returns `null` when no spec can be obtained.
 */
export async function loadSpec(opts: {
	configDir: string;
	specUrl: string;
	refresh: boolean;
}): Promise<OpenApiSpec | null> {
	const { configDir, specUrl, refresh } = opts;
	const cachePath = join(configDir, CACHE_FILE);

	if (!refresh) {
		const cached = readCache(cachePath);
		if (
			cached &&
			cached.specUrl === specUrl &&
			Date.now() - cached.fetchedAt < CACHE_TTL_MS
		) {
			log.debug("Using cached OpenAPI spec from %s", cachePath);
			return cached.spec;
		}
	}

	try {
		log.debug("Fetching OpenAPI spec from %s", specUrl);
		const spec = await fetchOpenApiSpec({ url: specUrl });
		writeCache(cachePath, { fetchedAt: Date.now(), specUrl, spec });
		return spec;
	} catch (err) {
		log.debug("Failed to fetch OpenAPI spec: %s", err);
		const stale = readCache(cachePath);
		if (stale && stale.specUrl === specUrl) {
			log.debug("Falling back to stale cached OpenAPI spec");
			return stale.spec;
		}
		return null;
	}
}

/** `describeEndpoint` with the `neon api` flag to pass next in its errors. */
export function describeOperation(
	spec: OpenApiSpec,
	path: string,
	method: string,
): EndpointDescription {
	try {
		return describeEndpoint(spec, path, method);
	} catch (err) {
		if (!(err instanceof EndpointNotFoundError)) {
			throw err;
		}
		const hint =
			err.available.length > 0
				? `Pass -X ${err.available[0]}.`
				: "Run `neon api --list` to see available routes.";
		throw new Error(`${err.message} ${hint}`);
	}
}
