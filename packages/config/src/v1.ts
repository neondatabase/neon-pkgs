/**
 * `@neon/config/v1` — the v1 public API for Config-as-Code on Neon.
 *
 * Usage in `neon.ts`:
 * ```ts
 * import { defineConfig } from "@neon/config/v1";
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
 * function bundling/deploy live in **`@neon/config-runtime`**, which depends on this
 * package and pulls in `esbuild`. Import that from your CLI / CI, not from `neon.ts`:
 * ```ts
 * import config from "../neon";
 * import { inspect, plan, apply } from "@neon/config-runtime/v1";
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
	isPartialBranchCreateError,
	isPlatformError,
	MissingContextError,
	PartialBranchCreateError,
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
	isPartialBranchCreateError,
	isPlatformError,
	MissingContextError,
	PartialBranchCreateError,
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
	postgres: postgresConfigSchema,
	preview: previewInputSchema,
	service: serviceToggleSchema,
	serviceInput: serviceToggleInputSchema,
} as const;

// ─── Lower-level adapters ──────────────────────────────────────────────────────
export { createNeonApiFromOptions } from "./lib/auth.js";
// ─── Credentials (pure scope derivation; Preview) ─────────────────────────────
export type { CredentialFeatureFlags } from "./lib/credentials.js";
export {
	credentialScopesSatisfied,
	deriveCredentialScopes,
} from "./lib/credentials.js";
export { defineConfig, resolveConfig } from "./lib/define-config.js";
// ─── Diff engine (pure; consumed by @neon/config-runtime) ─────────────
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
	isPartialBranchCreateError,
	isPlatformError,
	MissingContextError,
	PartialBranchCreateError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "./lib/errors.js";
// ─── External packages (pure; also for a custom FunctionBundler) ──────────────
export {
	externalPackageRoot,
	packagesToStage,
} from "./lib/external-packages.js";
export type {
	FunctionArchiveEntry,
	FunctionSourceEntry,
} from "./lib/function-entries.js";
export {
	FUNCTION_ARCHIVE_ENTRIES,
	FUNCTION_SOURCE_ENTRIES,
	isFunctionArchiveEntry,
	pickFunctionSourceEntry,
} from "./lib/function-entries.js";
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
	DurationString,
	DurationUnit,
	ExternalPackageDef,
	ExternalPackageEntry,
	FunctionBundle,
	FunctionBundler,
	FunctionBundlerInput,
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
	ResolvedDataApiConfig,
	ResolvedExternalPackage,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceEnabled,
	ServiceToggle,
	ServiceToggleInput,
} from "./lib/types.js";
// ─── Config types (used in neon.ts and in operation return values) ────────────
export { DATA_API_AUTH_PROVIDERS } from "./lib/types.js";
