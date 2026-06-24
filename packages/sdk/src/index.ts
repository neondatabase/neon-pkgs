/**
 * `@neon/sdk` — the official TypeScript SDK for the Neon API.
 *
 * Generated from Neon's OpenAPI specification with `@hey-api/openapi-ts` on top of
 * a Fetch-based client. This entry point re-exports the full generated surface:
 *
 * - every endpoint as a standalone, tree-shakeable function (`createProject`,
 *   `listProjects`, `createProjectBranch`, …);
 * - all request/response/error types (`Project`, `Branch`, `CreateProjectData`, …);
 * - the client primitives (`createClient`, `createConfig`) and the default `client`
 *   instance preconfigured for `https://console.neon.tech/api/v2`.
 *
 * @example
 * ```ts
 * import { client, listProjects } from "@neon/sdk";
 *
 * client.setConfig({ auth: () => process.env.NEON_API_KEY });
 *
 * const { data } = await listProjects();
 * console.log(data?.projects);
 * ```
 */

// hey-api's generated entry only re-exports the endpoint functions and types, not
// the client primitives. Surface them here so everything is reachable from the root.
// (`ClientOptions` / `Options` are intentionally not re-exported here — the Neon API
// spec defines its own types with those names, which the `export *` already provides.)
export {
	type Client,
	type Config,
	type CreateClientConfig,
	createClient,
	createConfig,
} from "./client/client/index.js";
export { client } from "./client/client.gen.js";
export * from "./client/index.js";
