import type { Client } from "../client/client/index.js";
import { type NeonConfig, resolveConfig } from "./config.js";
import { RequestContext } from "./context.js";
import { ApiKeys, Regions, User } from "./resources/account.js";
import { AiGateway } from "./resources/ai-gateway.js";
import { Auth } from "./resources/auth.js";
import { Branches } from "./resources/branches.js";
import { Consumption } from "./resources/consumption.js";
import { Credentials } from "./resources/credentials.js";
import { Functions } from "./resources/functions.js";
import { Logs } from "./resources/logs.js";
import { Operations } from "./resources/operations.js";
import { Postgres } from "./resources/postgres.js";
import { Projects } from "./resources/projects.js";
import { Snapshots } from "./resources/snapshots.js";
import { Storage } from "./resources/storage.js";

/**
 * The ergonomic Neon client. Resource namespaces wrap the raw operations with auth-once,
 * retries, the `{ data, error }` envelope, optional readiness polling, and typed errors.
 * Drop to the raw layer any time via `.client`.
 *
 * `projects` and `branches` are top-level; the Postgres data plane (compute endpoints,
 * roles, databases, the Data API, connection strings) is grouped under `postgres` so
 * future top-level namespaces (e.g. functions, object storage) stay unambiguous.
 */
export interface NeonClient<DThrow extends boolean> {
	readonly projects: Projects<DThrow>;
	readonly branches: Branches<DThrow>;
	readonly postgres: Postgres<DThrow>;
	readonly storage: Storage<DThrow>;
	readonly functions: Functions<DThrow>;
	readonly credentials: Credentials<DThrow>;
	readonly aiGateway: AiGateway<DThrow>;
	readonly logs: Logs<DThrow>;
	readonly snapshots: Snapshots<DThrow>;
	readonly operations: Operations<DThrow>;
	readonly auth: Auth<DThrow>;
	readonly consumption: Consumption;
	readonly apiKeys: ApiKeys<DThrow>;
	readonly regions: Regions;
	readonly user: User<DThrow>;
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
		postgres: new Postgres<Throw>(ctx),
		storage: new Storage<Throw>(ctx),
		functions: new Functions<Throw>(ctx),
		credentials: new Credentials<Throw>(ctx),
		aiGateway: new AiGateway<Throw>(ctx),
		logs: new Logs<Throw>(ctx),
		snapshots: new Snapshots<Throw>(ctx),
		operations: new Operations<Throw>(ctx),
		auth: new Auth<Throw>(ctx),
		consumption: new Consumption(ctx),
		apiKeys: new ApiKeys<Throw>(ctx),
		regions: new Regions(ctx),
		user: new User<Throw>(ctx),
		client: ctx.client,
	};
}
