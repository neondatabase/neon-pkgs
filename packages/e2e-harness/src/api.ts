import { requireApiKey } from "./env.js";

/**
 * The harness talks to the Neon API with plain `fetch` rather than through `@neon/sdk`,
 * on purpose. `@neon/sdk` is one of the packages these suites test, and plumbing built on
 * the subject under test fails in the least useful way: a bug in the SDK would break both
 * the assertion and the teardown that was supposed to clean up after it, leaving real
 * projects behind and a confusing cascade instead of one honest failure.
 *
 * It also keeps the workspace graph acyclic — `@neon/sdk` depends on this package for its
 * own e2e suite.
 */
const DEFAULT_BASE_URL = "https://console.neon.tech/api/v2";

function baseUrl(): string {
	return process.env.NEON_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

/** A non-2xx response. Thrown by {@link apiRequest} so callers can branch on `status`. */
export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown, path: string) {
		super(`Neon API ${status} for ${path}: ${JSON.stringify(body)}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

export function statusOf(err: unknown): number | undefined {
	return err instanceof ApiError ? err.status : undefined;
}

export function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function apiRequest<T>(
	path: string,
	init: {
		method?: string;
		body?: unknown;
		query?: Record<string, unknown>;
	} = {},
): Promise<T> {
	const url = new URL(`${baseUrl()}${path}`);
	for (const [key, value] of Object.entries(init.query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	const response = await fetch(url, {
		method: init.method ?? "GET",
		headers: {
			authorization: `Bearer ${requireApiKey()}`,
			accept: "application/json",
			...(init.body ? { "content-type": "application/json" } : {}),
		},
		...(init.body ? { body: JSON.stringify(init.body) } : {}),
	});
	const text = await response.text();
	const body: unknown = text ? JSON.parse(text) : undefined;
	if (!response.ok) throw new ApiError(response.status, body, path);
	return body as T;
}

/**
 * Some Neon operations are eventually consistent (notably branch creation finishing
 * `init` → `ready`). A small wait avoids racing on subsequent reads.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
