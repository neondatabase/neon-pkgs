/**
 * `@neondatabase/platform/v1` — the v1 public API for the Neon Platform IaC / Config-as-Code
 * package.
 *
 * Usage in `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/platform/v1";
 *
 * export default defineConfig({
 *   project: { name: "my-app", region: "aws-us-east-1" },
 *   branchBlueprints: {
 *     production: { computeSettings: { autoscalingLimitMaxCu: 2 } },
 *     preview:    { pattern: "preview-*", ttl: "1h", parent: "production" },
 *   },
 * });
 * ```
 */

export {
	type NeonctlCredentials,
	readNeonctlCredentials,
	resolveApiKey,
} from "./lib/auth.js";
export { defineConfig } from "./lib/define-config.js";
export {
	ConfigLoadError,
	ConfigValidationError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushConflictError,
} from "./lib/errors.js";
export {
	type BranchRef,
	type LoadContextOptions,
	loadContext,
	loadContextWithBranch,
	type NeonContext,
} from "./lib/load-context.js";
export {
	DEFAULT_DATABASE_URL_KEY,
	DEFAULT_DATABASE_URL_UNPOOLED_KEY,
	type LoadEnvOptions,
	loadEnv,
} from "./lib/load-env.js";
export {
	DEFAULT_CONFIG_FILENAMES,
	type LoadConfigOptions,
	loadConfigFromFile,
} from "./lib/loader.js";
export type {
	CreateBranchInput,
	CreateProjectInput,
	GetConnectionUriInput,
	NeonApi,
	NeonBranchSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
	UpdateBranchInput,
} from "./lib/neon-api.js";
export { createRealNeonApi } from "./lib/neon-api-real.js";
export { type PullConfigOptions, pullConfig } from "./lib/pull-config.js";
export { type PushConfigOptions, pushConfig } from "./lib/push-config.js";
export {
	branchBlueprintSchema,
	computeSettingsSchema,
	configSchema,
	projectConfigSchema,
} from "./lib/schema.js";
export type {
	AppliedChange,
	BranchBlueprint,
	ComputeSettings,
	Config,
	ConflictReport,
	ProjectConfig,
	PushResult,
	ResolvedBranchBlueprint,
	ResolvedConfig,
} from "./lib/types.js";
