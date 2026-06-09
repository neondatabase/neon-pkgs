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
 * This is the **authoring** surface — `defineConfig`, types, schemas, the pure diff engine,
 * and the Neon API adapter. It is intentionally free of heavy/native dependencies so that
 * importing it from `neon.ts` stays cheap and bundler-safe.
 *
 * The imperative operations (`inspect` / `plan` / `apply`, `pushConfig` / `pullConfig`) and
 * function bundling/deploy live in **`@neondatabase/config-runtime`**, which depends on this
 * package and pulls in `esbuild`. Import that from your CLI / CI, not from `neon.ts`:
 * ```ts
 * import config from "../neon";
 * import { inspect, plan, apply } from "@neondatabase/config-runtime/v1";
 * ```
 *
 * Surface guidelines:
 * - Top-level: `defineConfig` / `resolveConfig`, the pure `diffConfig` engine, the
 *   `createRealNeonApi` adapter + `NeonApi` types, the config loader, the `PlatformError`
 *   base class + `ErrorCode` enum, and the config types used in `neon.ts`.
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
	branchTuningSchema,
	bucketDefSchema,
	computeSettingsSchema,
	configInputSchema,
	functionDefSchema,
	functionTuningSchema,
	postgresConfigSchema,
	previewInputSchema,
	serviceToggleInputSchema,
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
	config: configInputSchema,
	branchTuning: branchTuningSchema,
	bucket: bucketDefSchema,
	computeSettings: computeSettingsSchema,
	function: functionDefSchema,
	functionTuning: functionTuningSchema,
	postgres: postgresConfigSchema,
	preview: previewInputSchema,
	service: serviceToggleSchema,
	serviceInput: serviceToggleInputSchema,
} as const;

// ─── Lower-level adapters ──────────────────────────────────────────────────────
export { createNeonApiFromOptions, resolveApiKey } from "./lib/auth.js";
export { defineConfig, resolveConfig } from "./lib/define-config.js";
// ─── Diff engine (pure; consumed by @neondatabase/config-runtime) ─────────────
export type {
	DiffOptions,
	DiffResult,
	PlanStep,
	RemotePreviewState,
	RemoteServiceState,
	RemoteState,
} from "./lib/diff.js";
export { diffConfig } from "./lib/diff.js";
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
// ─── Config types (used in neon.ts and in operation return values) ────────────
export type {
	AppliedChange,
	BranchTarget,
	BranchTuning,
	BranchTuningFn,
	BucketAccessLevel,
	BucketDef,
	ComputeSettings,
	Config,
	ConflictReport,
	FunctionDef,
	FunctionDevConfig,
	FunctionRuntime,
	FunctionTuning,
	PostgresConfig,
	PreviewInput,
	PreviewTuning,
	PushResult,
	ResolvedBranchConfig,
	ResolvedBucketConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceToggle,
	ServiceToggleInput,
} from "./lib/types.js";
