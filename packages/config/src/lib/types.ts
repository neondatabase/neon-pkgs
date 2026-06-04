/**
 * Valid Neon Compute Unit values.
 * Most plans support 0.25, 0.5, 1, 2, 4, 8. Higher values may be available on Business plans.
 */
export type ComputeUnit = 0.25 | 0.5 | 1 | 2 | 4 | 8;

/**
 * Compute settings applied to the read/write endpoint of a branch.
 *
 * Mirrors the subset of {@link https://api-docs.neon.tech/reference/getting-started-with-neon-api Neon endpoint}
 * fields that we expose as IaC primitives. Anything left undefined falls back to the project's
 * `default_endpoint_settings` (which themselves fall back to Neon platform defaults).
 */
export interface ComputeSettings {
	/**
	 * Minimum number of Compute Units. Set to 0.25 for true scale-to-zero.
	 * @example 0.25  // scale-to-zero
	 * @example 1     // always-on with 1 CU minimum
	 */
	autoscalingLimitMinCu?: ComputeUnit;
	/**
	 * Maximum number of Compute Units for autoscaling.
	 * @example 2
	 * @example 8
	 */
	autoscalingLimitMaxCu?: ComputeUnit;
	/**
	 * How long to wait before suspending an idle compute.
	 *
	 * - `false` — never suspend (always-on compute)
	 * - `"5m"` — duration string (supports "30s", "5m", "1h", "7d", etc)
	 * - `300` — custom timeout in seconds (60-604800)
	 * - `undefined` — use Neon platform default (currently 300s / 5 minutes)
	 *
	 * @example false       // never suspend
	 * @example "5m"        // 5 minutes
	 * @example "1h"        // 1 hour
	 * @example 300         // 5 minutes in seconds
	 */
	suspendTimeout?: false | "5m" | "1h" | string | number;
}

/**
 * Read-only descriptor of the branch a {@link Config} policy is being evaluated for — the
 * `branch` argument passed to your `defineConfig((branch) => …)` callback. It describes
 * **which** branch this invocation decides for; it is not a live branch handle and must not
 * be mutated. Switch on its fields and return the desired {@link BranchConfig}.
 */
export interface BranchTarget {
	/** Branch name being evaluated. For `branch dev`, this is the generated branch name. */
	name: string;
	/** Neon branch id when the branch already exists. Undefined during pre-create eval. */
	id?: string;
	/** Whether this branch already exists on Neon. */
	exists: boolean;
	/** Parent branch id from Neon when known. */
	parentId?: string;
	/** Whether Neon marks this branch as the project default. */
	isDefault?: boolean;
	/** Whether Neon currently marks this branch protected. */
	isProtected?: boolean;
	/** Current expiration timestamp from Neon, when set. */
	expiresAt?: string;
}

export interface ServiceToggle {
	/** Defaults to `true` when the service namespace is present. Set `false` to opt out. */
	enabled?: boolean;
}

export interface PostgresConfig {
	computeSettings?: ComputeSettings;
}

/**
 * Supported function runtimes. Mirrors the Neon Functions deploy API `runtime` enum.
 * Only `nodejs24` exists today; kept as a union so adding runtimes later is a
 * non-breaking, type-checked change.
 */
export type FunctionRuntime = "nodejs24";

/**
 * Memory sizes (MiB) accepted by the Neon Functions deploy API. Mirrors the
 * `memory_mib` enum in the spec.
 */
export type FunctionMemoryMib = 256 | 512 | 1024 | 2048 | 4096 | 8192;

/**
 * A single Neon Function deployed to a branch (Preview feature).
 *
 * A function is invoked like a Cloudflare/Vercel handler — its source module
 * `export default { fetch }` or `export async function handler(req): Response`. The
 * `source` path is bundled (esbuild) and uploaded as a deployment; the newest
 * deployment becomes active.
 */
export interface FunctionConfig {
	/**
	 * Branch-unique, lowercase DNS-label used as the path segment in the function's
	 * invocation URL. Immutable once created. 1–40 chars, `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`.
	 * @example "hello-world"
	 */
	slug: string;
	/** Free-form display name. @example "Hello World" */
	name: string;
	/**
	 * Path to the function's entry module, **relative to `neon.ts`** (or absolute). The
	 * module's default export (`{ fetch }`) or `handler` export is the function entry. This
	 * path is resolved against the loaded `neon.ts` location and bundled with esbuild at
	 * deploy time.
	 *
	 * We require a string path rather than an imported handler because a JS function value
	 * carries no reference back to its source file, so esbuild has nothing to bundle from.
	 * @example "./functions/hello-world.ts"
	 */
	source: string;
	/**
	 * Environment variables injected into the deployed function. Every value must be a
	 * defined string — a `process.env.X` that is `undefined` (unset) errors at validation
	 * time rather than silently shipping `undefined`.
	 * @example { RESEND_API_KEY: process.env.RESEND_API_KEY }
	 */
	env?: Record<string, string>;
	/** Runtime to execute the function with. Defaults to `"nodejs24"`. */
	runtime?: FunctionRuntime;
	/** Memory allotted to each invocation, in MiB. Defaults to `512`. */
	memoryMib?: FunctionMemoryMib;
}

/** Anonymous-access level for a branchable object-storage bucket. */
export type BucketAccessLevel = "private" | "public_read";

/**
 * A branchable object-storage bucket on a branch (Preview feature).
 */
export interface BucketConfig {
	/** Bucket name, unique within a branch. 1–255 chars. */
	name: string;
	/**
	 * Anonymous access level. `private` (default) requires authenticated reads/writes;
	 * `public_read` allows anonymous GetObject/HeadObject.
	 */
	access?: BucketAccessLevel;
}

/**
 * Branch-scoped Preview features. Grouped under `preview` to signal they are backed by
 * Neon `x-stability-level: beta` endpoints and may change before GA.
 */
export interface PreviewConfig {
	/** Functions to deploy on the branch. */
	functions?: FunctionConfig[];
	/** Object-storage buckets to create on the branch. */
	buckets?: BucketConfig[];
	/** Enable/disable the AI Gateway on the branch (toggle, like auth / dataApi). */
	aiGateway?: ServiceToggle;
}

interface BranchConfigBase {
	/** Parent branch name used when creating a new branch. Not a Postgres setting. */
	parent?: string;
	/** Time-to-live applied when creating a new branch, or reconciled on existing branches. */
	ttl?: string | number;
	/** Whether the selected branch should be protected. Undefined means "leave as-is". */
	protected?: boolean;
	postgres?: PostgresConfig;
	/**
	 * Branch-scoped Preview features (functions, object-storage buckets, AI Gateway).
	 * Backed by Neon `x-stability-level: beta` endpoints — see {@link PreviewConfig}.
	 */
	preview?: PreviewConfig;
}

type BranchServiceConfig =
	| { auth?: never; dataApi?: never }
	| { auth: ServiceToggle; dataApi?: never }
	| { auth?: never; dataApi: ServiceToggle }
	| { auth: ServiceToggle; dataApi: ServiceToggle };

export type BranchConfig = BranchConfigBase & BranchServiceConfig;

export type Config = (branch: BranchTarget) => BranchConfig;

/**
 * A function with all deploy defaults applied. `resolveConfig` fills in `runtime` and
 * `memoryMib` so downstream diff/apply never has to re-derive them.
 */
export interface ResolvedFunctionConfig {
	slug: string;
	name: string;
	source: string;
	env: Record<string, string>;
	runtime: FunctionRuntime;
	memoryMib: FunctionMemoryMib;
}

/** A bucket with its access level defaulted to `private`. */
export interface ResolvedBucketConfig {
	name: string;
	access: BucketAccessLevel;
}

/**
 * Normalized {@link PreviewConfig}. Only present on {@link ResolvedBranchConfig} when the
 * policy returned a `preview` block. `aiGatewayEnabled` follows the same
 * "present-and-not-`false`" semantics as `authEnabled` / `dataApiEnabled`.
 */
export interface ResolvedPreviewConfig {
	functions: ResolvedFunctionConfig[];
	buckets: ResolvedBucketConfig[];
	aiGatewayEnabled: boolean;
}

export interface ResolvedBranchConfig {
	parent?: string;
	ttlSeconds?: number;
	protected?: boolean;
	postgres?: PostgresConfig;
	authEnabled: boolean;
	dataApiEnabled: boolean;
	preview?: ResolvedPreviewConfig;
}

/**
 * One concrete change `pushConfig` made (or, in dry-run, would make) on the remote.
 */
export interface AppliedChange {
	/**
	 * `service` covers branch-scoped integrations driven by the branch policy (e.g.
	 * Neon Auth, Data API).
	 */
	kind: "branch" | "service";
	action: "create" | "update" | "noop";
	identifier: string;
	details?: Record<string, unknown>;
}

/**
 * A diff entry that conflicts with the desired config. `pushConfig` throws
 * {@link PushConflictError} on the first call when conflicts exist; pass
 * `updateExisting: true` to apply mutable drift (settings, `protected`, TTL, project
 * rename). Immutable fields (region, Postgres major version) are always conflicts —
 * recreate the project to change them.
 */
export interface ConflictReport {
	kind: "branch";
	identifier: string;
	field: string;
	current: unknown;
	desired: unknown;
	reason: string;
}

/**
 * Result of a `pushConfig` invocation.
 */
export interface PushResult {
	projectId: string;
	orgId?: string;
	branchId: string;
	branchName: string;
	/**
	 * `true` when `pushConfig` was called with `{ dryRun: true }`. `applied` then records
	 * what **would** be applied on a real push; no API mutations were performed.
	 */
	dryRun: boolean;
	applied: AppliedChange[];
	conflicts: ConflictReport[];
}
