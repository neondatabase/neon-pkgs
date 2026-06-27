/**
 * `@neondatabase/config/v1` — the v1 public API for Config-as-Code on the Neon Platform.
 *
 * Usage in `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neondatabase/config/v1";
 *
 * export default defineConfig({
 *   // Static: what *exists* on every branch (drives the typed env).
 *   auth: true,
 *   // Dynamic: per-branch tuning only — cannot add/remove services.
 *   branch: (branch) => ({
 *     protected: branch.name === "main",
 *     ...(branch.name === "main" ? {} : { parent: "main", ttl: "7d" }),
 *   }),
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
	isPlatformError,
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
	dataApiConfigSchema,
	dataApiInputSchema,
	dataApiSettingsSchema,
	functionDefSchema,
	functionTuningSchema,
	hooksSchema,
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
	isPlatformError,
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
	dataApi: dataApiConfigSchema,
	dataApiInput: dataApiInputSchema,
	dataApiSettings: dataApiSettingsSchema,
	function: functionDefSchema,
	functionTuning: functionTuningSchema,
	hooks: hooksSchema,
	postgres: postgresConfigSchema,
	preview: previewInputSchema,
	service: serviceToggleSchema,
	serviceInput: serviceToggleInputSchema,
} as const;

// ─── Lower-level adapters ──────────────────────────────────────────────────────
export { createNeonApiFromOptions, resolveApiKey } from "./lib/auth.js";
// ─── Branch-name helper (pure; shared with the CLI's git → Neon mapping) ──────
export type { ToNeonBranchNameOptions } from "./lib/branch-name.js";
export { toNeonBranchName } from "./lib/branch-name.js";
// ─── Credentials (pure scope derivation; Preview) ─────────────────────────────
export type { CredentialFeatureFlags } from "./lib/credentials.js";
export {
	credentialScopesSatisfied,
	deriveCredentialScopes,
} from "./lib/credentials.js";
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
// ─── Resolved-env types (canonical home; re-exported by @neondatabase/env) ────
export type {
	FunctionSlugOf,
	NeonAiGatewayEnv,
	NeonAuthEnv,
	NeonBranchEnv,
	NeonDataApiEnv,
	NeonEnv,
	NeonFunctionEnv,
	NeonPostgresEnv,
	NeonStorageEnv,
} from "./lib/env.js";
// ─── Errors ────────────────────────────────────────────────────────────────────
export {
	ConfigLoadError,
	ConfigValidationError,
	ErrorCode,
	isPlatformError,
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
	CreateCredentialInput,
	CreateProjectInput,
	DeployFunctionInput,
	EnableDataApiInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBranchStorageSnapshot,
	NeonBucketSnapshot,
	NeonCredentialMeta,
	NeonCredentialSecret,
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
export type {
	AppliedChange,
	BranchTarget,
	BranchTuning,
	BranchTuningFn,
	BucketAccessLevel,
	BucketDef,
	CheckoutAfterContext,
	CheckoutBeforeContext,
	CheckoutBeforeResult,
	CheckoutHooks,
	ComputeSettings,
	ComputeUnit,
	Config,
	ConflictReport,
	CredentialPrincipalType,
	CredentialScope,
	DataApiAuthProvider,
	DataApiConfig,
	DataApiExternalAuthConfig,
	DataApiInput,
	DataApiNeonAuthConfig,
	DataApiSettings,
	DeployAfterContext,
	DeployBeforeContext,
	DeployHooks,
	DurationString,
	DurationUnit,
	FunctionDef,
	FunctionDevConfig,
	FunctionRuntime,
	FunctionTuning,
	GitContext,
	Hook,
	HookBranch,
	Hooks,
	PostgresConfig,
	PreviewInput,
	PreviewTuning,
	PushResult,
	ResolvedBranchConfig,
	ResolvedBucketConfig,
	ResolvedDataApiConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceEnabled,
	ServiceToggle,
	ServiceToggleInput,
	ShellHook,
} from "./lib/types.js";
// ─── Config types (used in neon.ts and in operation return values) ────────────
export { DATA_API_AUTH_PROVIDERS } from "./lib/types.js";
