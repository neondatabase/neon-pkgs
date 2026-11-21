import { configuredBaseUrl, requireApiKey } from "./env.js";

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

interface ApiRequestInit {
	method?: string;
	body?: unknown;
	query?: Record<string, unknown>;
}

/**
 * Per-call budget for waiting out a 423. Must stay well under the suites' 120 s hook
 * timeout so a stuck lock fails with the real 423 rather than a Vitest timeout.
 */
const CONFLICT_RETRY_DEADLINE_MS = 30_000;

/**
 * Neon rejects a mutation with this 423, without scheduling it, while another operation
 * on the project is running, so resending it is safe.
 */
function isConflictingOperations(err: unknown): boolean {
	if (!(err instanceof ApiError) || err.status !== 423) return false;
	const { body } = err;
	return (
		typeof body === "object" &&
		body !== null &&
		"message" in body &&
		typeof body.message === "string" &&
		body.message.includes("running conflicting operations")
	);
}

/**
 * Retries only the 423 "running conflicting operations" lock, with backoff, until
 * {@link CONFLICT_RETRY_DEADLINE_MS}; then it throws that 423. Every other status throws on
 * the first response.
 */
export async function apiRequest<T>(
	path: string,
	init: ApiRequestInit = {},
): Promise<T> {
	const deadline = Date.now() + CONFLICT_RETRY_DEADLINE_MS;
	let delay = 500;
	while (true) {
		try {
			return await sendRequest<T>(path, init);
		} catch (err) {
			if (
				!isConflictingOperations(err) ||
				Date.now() + delay > deadline
			) {
				throw err;
			}
			console.warn(
				`[e2e api] ${init.method ?? "GET"} ${path} got 423 running conflicting operations; retrying in ${delay} ms`,
			);
			await sleep(delay);
			delay = Math.min(delay * 2, 5_000);
		}
	}
}

async function sendRequest<T>(path: string, init: ApiRequestInit): Promise<T> {
	const url = new URL(`${configuredBaseUrl()}${path}`);
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
