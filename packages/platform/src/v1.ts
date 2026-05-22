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
export type {
	CreateBranchInput,
	CreateProjectInput,
	NeonApi,
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
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
