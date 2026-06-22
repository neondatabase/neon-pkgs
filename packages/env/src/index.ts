/**
 * `@neondatabase/env` — resolve and inject Neon connection strings for the branch
 * selected by your `neon.ts` policy.
 *
 * - `fetchEnv(config)` — async; resolves the branch + calls the Neon API for live
 *   connection strings. Use in build scripts / top-level await.
 * - `parseEnv(config)` — sync; reads already-injected `process.env` and validates it.
 *   Use in app bootstrap (Drizzle config, Next.js, Vite, …).
 * - `toEntries(env)` — project a resolved env into `{ KEY: value }` pairs.
 *
 * The branch policy type (`Config`) and `defineConfig` come from `@neondatabase/config`.
 */

export type {
	FetchEnvOptions,
	FilteredNeonEnv,
	FunctionSlugOf,
	NeonAiGatewayEnv,
	NeonAuthEnv,
	NeonBranchEnv,
	NeonDataApiEnv,
	NeonEnv,
	NeonFunctionEnv,
	NeonPostgresEnv,
	NeonStorageEnv,
	SelectableEnvKey,
} from "./lib/env.js";
export {
	fetchEnv,
	NEON_ENV_VAR_KEYS,
	parseEnv,
	toEntries,
} from "./lib/env.js";

// The branch policy type (`Config`) and `defineConfig` live in `@neondatabase/config`.
// Import them from there directly:
//   import { defineConfig } from "@neondatabase/config/v1";
// They are intentionally not re-exported here to keep this package's surface focused on
// env resolution and to avoid coupling the two packages' type-declaration bundles.
