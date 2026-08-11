/**
 * `@neon/env` — resolve and inject Neon connection strings for the branch
 * selected by your `neon.ts` policy.
 *
 * - `fetchEnv(config)` — async; resolves the branch + calls the Neon API for live
 *   connection strings. Use in build scripts / top-level await.
 * - `parseEnv(config)` — sync; reads already-injected `process.env` and validates it.
 *   Use in app bootstrap (Drizzle config, Next.js, Vite, etc).
 * - `toEntries(env)` — project a resolved env into `{ KEY: value }` pairs.
 *
 * This is the whole package: one entry point, all of it side-effect-free. It reads no files
 * and no env source of its own, so it is safe to import from an app, a build script, or a
 * `neon.ts` policy.
 *
 * The branch policy type (`Config`) and `defineConfig` come from `@neon/config`.
 */

export type {
	FetchEnvOptions,
	FilteredNeonEnv,
	NeonAiGatewayEnv,
	NeonAuthEnv,
	NeonBranchEnv,
	NeonDataApiEnv,
	NeonEnv,
	NeonPostgresEnv,
	NeonStorageEnv,
	ResolvedNeonEnv,
	SelectableEnvKey,
} from "@neon-internals/env-core/env";
export {
	fetchEnv,
	NEON_ENV_VAR_KEYS,
	toEntries,
} from "@neon-internals/env-core/env";
export type { FunctionSlugOf, NeonFunctionEnv } from "./lib/parse-env.js";
export { parseEnv } from "./lib/parse-env.js";

// The stateful counterpart — `fetchEnvReusingSecrets`, which reads an env source and can mint
// and revoke branch credentials — is deliberately absent. It is implementation shared with the
// `neon` CLI (`@neon-internals/env-core`), not something to hand an application: a library that revokes
// credentials because you imported it is a library you cannot safely embed. It used to be
// published at `@neon/env/runtime`; see CHANGELOG for the removal.

// The branch policy type (`Config`) and `defineConfig` live in `@neon/config`.
// Import them from there directly:
//   import { defineConfig } from "@neon/config/v1";
// They are intentionally not re-exported here to keep this package's surface focused on
// env resolution and to avoid coupling the two packages' type-declaration bundles.
