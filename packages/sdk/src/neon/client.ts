import type { Client } from "../client/client/index.js";
import { type NeonConfig, resolveConfig } from "./config.js";
import { RequestContext } from "./context.js";
import { Branches } from "./resources/branches.js";
import { Operations } from "./resources/operations.js";
import { Projects } from "./resources/projects.js";

/**
 * The ergonomic Neon client. Resource namespaces (`projects`, `operations`, …) wrap the
 * raw operations with auth-once, retries, the `{ data, error }` envelope, optional
 * readiness polling, and typed errors. Drop to the raw layer any time via `.client`.
 */
export interface NeonClient<DThrow extends boolean> {
	readonly projects: Projects<DThrow>;
	readonly branches: Branches<DThrow>;
	readonly operations: Operations<DThrow>;
	/**
	 * The underlying configured raw client. Pass it to any raw function
	 * (`import { raw } from "@neon/sdk"`) to reuse this client's auth + base URL.
	 */
	readonly client: Client;
}

/**
 * Create an ergonomic Neon client.
 *
 * @example
 * ```ts
 * import { createNeonClient } from "@neon/sdk";
 *
 * const neon = createNeonClient({ apiKey: process.env.NEON_API_KEY! });
 * const { data, error } = await neon.projects.list().all();
 * ```
 */
export function createNeonClient<Throw extends boolean = false>(
	config: NeonConfig<Throw>,
): NeonClient<Throw> {
	const ctx = new RequestContext(resolveConfig(config));
	return {
		projects: new Projects<Throw>(ctx),
		branches: new Branches<Throw>(ctx),
		operations: new Operations<Throw>(ctx),
		client: ctx.client,
	};
}
