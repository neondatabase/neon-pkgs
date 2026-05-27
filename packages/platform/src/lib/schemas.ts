/**
 * Public surface for the `schemas` namespace exported from `@neondatabase/platform/v1`.
 *
 * This barrel exists so `v1.ts` can do `export * as schemas from "./lib/schemas.js"`
 * without leaking `formatZodIssues` (an internal helper used by `defineConfig` to
 * render zod errors). Callers compose schemas under `schemas.branch`, `schemas.postgres`,
 * etc.
 */
export {
	branchConfigSchema as branch,
	computeSettingsSchema as computeSettings,
	configSchema as config,
	postgresConfigSchema as postgres,
	serviceToggleSchema as service,
} from "./schema.js";
