/**
 * `@neondatabase/config/v1` — the v1 public API for Config-as-Code on the Neon Platform.
 *
 * Usage in `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/config/v1";
 *
 * export default defineConfig((branch) => {
 *   if (branch.name === "main") return { protected: true, auth: {} };
 *   return { parent: "main", ttl: "7d" };
 * });
 * ```
 *
 * Then, from a script or another tool (filesystem- and env-agnostic — pass `projectId`
 * and the target branch explicitly):
 * ```ts
 * import config from "../neon";
 * import { inspect, plan, apply } from "@neondatabase/config/v1";
 *
 * const target = { projectId: "patient-art-12345", branchId: "main" };
 * const diff = await plan(config, target);     // dry-run plan, no mutations
 * await apply(config, target);                 // apply the policy to a branch
 * const live = await inspect(target);          // read the branch's live state
 * ```
 *
 * `plan` / `apply` mirror the Terraform mental model. No CLI commands are shipped here,
 * and no `.neon` files or `NEON_*` env vars are read — resolve project/branch in your CLI
 * (e.g. neonctl) and pass them in. This package is functions only.
 *
 * Surface guidelines:
 * - Top-level: the operations callers reach for daily (`inspect`, `plan`, `apply`,
 *   `defineConfig`), plus the lower-level engine (`pushConfig` / `pullConfig`), the
 *   `PlatformError` base class + `ErrorCode` enum, and the types those operations produce.
 * - `errors` namespace: specific `PlatformError` subclasses (`ConfigLoadError`,
 *   `PushConflictError`, …).
 * - `schemas` namespace: the zod schemas underlying `defineConfig`.
 */

import {
	ConfigLoadError,
	ConfigValidationError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "./lib/errors.js";
import {
	branchConfigSchema,
	bucketConfigSchema,
	computeSettingsSchema,
	configSchema,
	functionConfigSchema,
	postgresConfigSchema,
	previewConfigSchema,
	serviceToggleSchema,
} from "./lib/schema.js";

/**
 * Specific `PlatformError` subclasses, grouped for `instanceof` / structured access.
 * Also available as top-level exports.
 */
export const errors = {
	ConfigLoadError,
	ConfigValidationError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} as const;

/** The zod schemas underlying `defineConfig`, grouped under product-friendly names. */
export const schemas = {
	branch: branchConfigSchema,
	bucket: bucketConfigSchema,
	computeSettings: computeSettingsSchema,
	config: configSchema,
	function: functionConfigSchema,
	postgres: postgresConfigSchema,
	preview: previewConfigSchema,
	service: serviceToggleSchema,
} as const;

// ─── Lower-level adapters ──────────────────────────────────────────────────────
export { createNeonApiFromOptions, resolveApiKey } from "./lib/auth.js";
export { defineConfig, resolveConfig } from "./lib/define-config.js";
// ─── Errors ────────────────────────────────────────────────────────────────────
export {
	ConfigLoadError,
	ConfigValidationError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "./lib/errors.js";
export type { LoadConfigOptions } from "./lib/loader.js";
export { loadConfigFromFile } from "./lib/loader.js";
// ─── NeonApi types (needed by callers implementing their own adapters) ────────
export type {
	CreateBranchInput,
	CreateBucketInput,
	CreateProjectInput,
	DeployFunctionInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBucketSnapshot,
	NeonDataApiSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionDeploymentSnapshot,
	NeonFunctionSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
	UpdateBranchInput,
} from "./lib/neon-api.js";
export { createRealNeonApi } from "./lib/neon-api-real.js";
// ─── Operations (intent-revealing entry points) ───────────────────────────────
export type {
	ApplyOptions,
	ConfigOperationOptions,
} from "./lib/operations.js";
export { apply, inspect, plan } from "./lib/operations.js";
// ─── Engine (advanced / programmatic use) ─────────────────────────────────────
export type {
	PullConfigOptions,
	PulledBranchConfig,
	PulledPreview,
} from "./lib/pull-config.js";
export { pullConfig } from "./lib/pull-config.js";
export type {
	PushConfigOptions,
	PushConfirmContext,
} from "./lib/push-config.js";
export { pushConfig } from "./lib/push-config.js";
// ─── Config types (used in neon.ts and in operation return values) ────────────
export type {
	AppliedChange,
	BranchConfig,
	BranchTarget,
	BucketAccessLevel,
	BucketConfig,
	ComputeSettings,
	Config,
	ConflictReport,
	FunctionConfig,
	FunctionMemoryMib,
	FunctionRuntime,
	PostgresConfig,
	PreviewConfig,
	PushResult,
	ResolvedBranchConfig,
	ResolvedBucketConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceToggle,
} from "./lib/types.js";
