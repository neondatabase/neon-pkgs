// Lightweight loader for the Neon OpenAPI spec, used by `neon api --list` to
// enumerate the available routes. The `neon api <path>` request path does NOT
// depend on this module — it is a pure passthrough — so a stale or unreachable
// spec never blocks a real API call. Listing degrades gracefully: fresh cache →
// live fetch → stale cache → clear error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log } from "../log.js";

/** Public URL of the released Neon OpenAPI v2 spec. */
export const DEFAULT_SPEC_URL = "https://neon.com/api_spec/release/v2.json";

const CACHE_FILE = "openapi-spec.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options",
]);

type Operation = {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
};

type PathItem = Record<string, unknown>;

export type OpenApiSpec = {
	paths?: Record<string, PathItem>;
	servers?: { url: string }[];
	info?: { version?: string };
};

/** A single (method, path) route flattened from the spec. */
export type EndpointInfo = {
	method: string;
	path: string;
	summary?: string;
	operationId?: string;
	tags: string[];
};

type CachedSpec = {
	fetchedAt: number;
	specUrl: string;
	spec: OpenApiSpec;
};

async function fetchSpec(url: string): Promise<OpenApiSpec> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			throw new Error(
				`Failed to fetch OpenAPI spec (${res.status} ${res.statusText})`,
			);
		}
		return (await res.json()) as OpenApiSpec;
	} finally {
		clearTimeout(timer);
	}
}

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
		const spec = await fetchSpec(specUrl);
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

/** Flatten a spec into a sorted list of routes (by path, then method). */
export function getEndpoints(spec: OpenApiSpec): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	for (const [path, item] of Object.entries(spec.paths ?? {})) {
		for (const [method, op] of Object.entries(item)) {
			if (!HTTP_METHODS.has(method.toLowerCase())) {
				continue;
			}
			const operation = (op ?? {}) as Operation;
			endpoints.push({
				method: method.toUpperCase(),
				path,
				summary: operation.summary,
				operationId: operation.operationId,
				tags: operation.tags ?? [],
			});
		}
	}
	endpoints.sort((a, b) =>
		a.path === b.path
			? a.method.localeCompare(b.method)
			: a.path.localeCompare(b.path),
	);
	return endpoints;
}
