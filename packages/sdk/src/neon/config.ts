import { createClient, createConfig } from "../client/client/index.js";
import type { ResolvedConfig } from "./context.js";
import { resolveTimeoutMs } from "./deadline.js";
import { resolveRetries } from "./retry.js";
import type { WaitForOptions } from "./wait.js";

const DEFAULT_BASE_URL = "https://console.neon.tech/api/v2";

/** Options accepted by {@link createNeonClient}. */
export interface NeonConfig<Throw extends boolean = false> {
	/**
	 * Your Neon API key, or a function returning it (sync or async — handy for refreshing
	 * short-lived tokens). Used as a Bearer credential on every request.
	 */
	apiKey: string | (() => string | Promise<string>);
	/**
	 * When `true`, methods return the resource directly and throw a `NeonError` on failure.
	 * When `false` (default), they return `{ data, error }`. Overridable per call.
	 */
	throwOnError?: Throw;
	/**
	 * When `true`, mutations that kick off provisioning operations poll until those
	 * operations finish before resolving, so the returned resource is ready to use.
	 * Default `false`. Overridable per call.
	 */
	waitForReadiness?: boolean;
	/** Tuning for the readiness poller (interval / timeout). */
	wait?: WaitForOptions;
	/**
	 * Number of automatic retries on always-safe statuses (423/429/503). Default 2.
	 * `0` disables retries. Non-integer, negative, `NaN`, or `Infinity` throws a
	 * `"client"`-kind error at construction.
	 */
	retries?: number;
	/**
	 * Deadline in milliseconds for a single request **and** its retries, after which the
	 * call resolves with a `NeonTimeoutError` and the request is aborted. Overridable per
	 * call.
	 *
	 * Unset by default: calls are unbounded, as they have always been. Set it to bound
	 * them, and pass `Infinity` on a call that needs to opt back out of a client-wide
	 * value — a large `storage.objects.get` download or a `functions.deploy` upload, say.
	 *
	 * Separate from `wait.timeoutMs`, which budgets readiness polling rather than a
	 * request.
	 */
	requestTimeoutMs?: number;
	/** Override the API base URL. Defaults to `https://console.neon.tech/api/v2`. */
	baseUrl?: string;
	/** Custom `fetch` implementation (e.g. for proxies, tests, or non-global runtimes). */
	fetch?: typeof fetch;
	/**
	 * Default organization id. Applied to project creation/listing and as the source org
	 * for transfers when not given explicitly; overridable on every call.
	 */
	orgId?: string;
}

export function resolveConfig(config: NeonConfig<boolean>): ResolvedConfig {
	const apiKey = config.apiKey;
	const auth = typeof apiKey === "function" ? apiKey : () => apiKey;

	const client = createClient(
		createConfig({
			auth,
			baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
			...(config.fetch ? { fetch: config.fetch } : {}),
		}),
	);

	return {
		client,
		throwOnError: config.throwOnError ?? false,
		retries: resolveRetries(config.retries),
		requestTimeoutMs: resolveTimeoutMs(config.requestTimeoutMs),
		waitForReadiness: config.waitForReadiness ?? false,
		waitOptions: config.wait ?? {},
		orgId: config.orgId,
	};
}
