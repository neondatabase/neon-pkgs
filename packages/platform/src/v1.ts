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
 *   branches: {
 *     production: { protected: true, computeSettings: { autoscalingLimitMaxCu: 2 } },
 *     staging:    { parent: "production" },
 *   },
 *   branchBlueprints: {
 *     preview: { pattern: "preview-*", ttl: "1h", parent: "production" },
 *   },
 * });
 * ```
 *
 * Surface guidelines:
 * - Top-level: the operations callers reach for daily (`pullConfig`, `pushConfig`,
 *   `loadEnv`, `branch`, …), the `PlatformError` base class + `ErrorCode` enum for
 *   `instanceof` / code-based error handling, and the types those operations produce or
 *   accept.
 * - `errors` namespace: specific `PlatformError` subclasses (`ConfigLoadError`,
 *   `PushConflictError`, …). Reach for them when you want structured access to
 *   `err.conflicts` / `err.issues` instead of a generic code check.
 * - `schemas` namespace: the zod schemas underlying `defineConfig`. Pull in only when
 *   composing your own validation pipeline on top of ours.
 *
 * Internal helpers (`applyContextFileFields`, `formatContextFile`, `readNeonctlCredentials`,
 * `loadContextWithBranch`, the `Resolved*` types, …) are intentionally **not** exported.
 * They power the public surface and may change without notice.
 */

// ─── Lower-level adapters ──────────────────────────────────────────────────────
export { resolveApiKey } from "./lib/auth.js";
// ─── Option + result types for each operation ─────────────────────────────────
export type {
	BranchContextFile,
	BranchOptions,
	BranchResult,
} from "./lib/branch.js";
// ─── Operations ────────────────────────────────────────────────────────────────
export { branch } from "./lib/branch.js";
export { defineConfig } from "./lib/define-config.js";
// ─── Errors ────────────────────────────────────────────────────────────────────
export { ErrorCode, PlatformError } from "./lib/errors.js";
export * as errors from "./lib/errors-public.js";
export type {
	LoadContextOptions,
	NeonContext,
} from "./lib/load-context.js";
export { loadContext } from "./lib/load-context.js";
export type { LoadEnvOptions } from "./lib/load-env.js";
export { loadEnv } from "./lib/load-env.js";
export type { LoadConfigOptions } from "./lib/loader.js";
export { loadConfigFromFile } from "./lib/loader.js";
// ─── NeonApi types (needed by callers implementing their own adapters) ────────
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
export type { PullConfigOptions } from "./lib/pull-config.js";
export { pullConfig } from "./lib/pull-config.js";
export type { PushConfigOptions } from "./lib/push-config.js";
export { pushConfig } from "./lib/push-config.js";
// ─── Zod schemas ──────────────────────────────────────────────────────────────
export * as schemas from "./lib/schemas.js";
// ─── Config types (used in neon.ts and in pushConfig return values) ───────────
export type {
	BranchBlueprint,
	BranchConfig,
	ComputeSettings,
	Config,
	ProjectConfig,
	PushResult,
} from "./lib/types.js";
