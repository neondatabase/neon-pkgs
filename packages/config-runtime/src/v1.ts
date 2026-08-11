/**
 * `@neon/config-runtime/v1` — the imperative runtime for Config-as-Code on
 * Neon.
 *
 * `@neon/config` is the **authoring** surface: `defineConfig`, types, and schemas
 * you import from `neon.ts`. It is intentionally free of heavy/native dependencies.
 *
 * This package is the **runtime**: it reads a branch's live state, diffs a policy against
 * it, applies changes, and bundles + deploys Neon Functions. Bundling pulls in `esbuild`
 * (a native binary), so deploy-side consumers (the neonctl CLI, CI scripts) import *this*
 * package — and a `neon.ts` that only imports `defineConfig` never drags esbuild into the
 * user's dependency tree.
 *
 * ```ts
 * import config from "../neon";
 * import { inspect, plan, apply } from "@neon/config-runtime/v1";
 *
 * const target = { projectId: "patient-art-12345", branchId: "main" };
 * const diff = await plan(config, target);     // dry-run plan, no mutations
 * await apply(config, target);                 // apply the policy to a branch
 * const live = await inspect(target);          // read the branch's live state
 * ```
 *
 * `plan` / `apply` mirror the Terraform mental model. No CLI commands are shipped here, and
 * no `.neon` files or `NEON_*` env vars are read — resolve project/branch in your CLI (e.g.
 * neonctl) and pass them in.
 */

export type {
	AppliedChange,
	Config,
	ConflictReport,
	LoadConfigOptions,
	NeonApi,
	PushResult,
} from "@neon/config";
// ─── Re-exports from @neon/config for convenience ─────────────────────
// Runtime callers usually want a few authoring-side symbols alongside the operations
// (the errors `apply`/`pushConfig` throw, the result types they return, and the loader).
// Re-export the common ones so a deploy script can import everything it needs from one
// place, while `neon.ts` keeps importing the lean `@neon/config`.
export {
	ConfigLoadError,
	ConfigValidationError,
	createNeonApiFromOptions,
	createRealNeonApi,
	defineConfig,
	ErrorCode,
	isPartialBranchCreateError,
	isPlatformError,
	loadConfigFromFile,
	MissingContextError,
	PartialBranchCreateError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "@neon/config";
export type { FunctionBundler } from "./lib/function-bundle.js";
// ─── Function bundling (esbuild + zip) ────────────────────────────────────────
export { buildFunctionBundle } from "./lib/function-bundle.js";
// ─── Native dependency staging and detection ──────────────────────────────────
export type { NativeEvidence, NativeFinding } from "./lib/native-detect.js";
export {
	describeNativeFinding,
	findUndeclaredNativePackages,
} from "./lib/native-detect.js";
export type {
	ArchiveLimits,
	NativeTraceDeps,
	NativeTraceResult,
} from "./lib/native-packages.js";
export {
	assertZipWithinLimits,
	DEFAULT_ARCHIVE_LIMITS,
	enforceLimits,
	RUNTIME_TARGET,
	RUNTIME_TARGET_LABEL,
	traceNativePackages,
} from "./lib/native-packages.js";
// ─── Operations (intent-revealing entry points) ───────────────────────────────
export type {
	ApplyOptions,
	ConfigOperationOptions,
	CreateBranchOptions,
	CreateBranchResult,
} from "./lib/operations.js";
export { apply, createBranch, inspect, plan } from "./lib/operations.js";
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
