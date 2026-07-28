import { createClient, createConfig } from "../client/client/index.js";
import type { ResolvedConfig } from "./context.js";
import { assertUsablePathParams } from "./path-params.js";
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
	/** Number of automatic retries on always-safe statuses (423/429/503). Default 2. */
	retries?: number;
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
			// The ergonomic resources call the generated operations directly rather than
			// through `wrapRaw`, so this is the only hook that covers every request.
			requestValidator: async (data) => {
				assertUsablePathParams(data);
				return data;
			},
			...(config.fetch ? { fetch: config.fetch } : {}),
		}),
	);

	return {
		client,
		throwOnError: config.throwOnError ?? false,
		retries: config.retries ?? 2,
		waitForReadiness: config.waitForReadiness ?? false,
		waitOptions: config.wait ?? {},
		orgId: config.orgId,
	};
}
