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

/**
 * Object form of a branch-scoped service toggle. `{}` or `{ enabled: true }` enables it;
 * `{ enabled: false }` opts out. Used as the object half of {@link ServiceToggleInput}.
 */
export interface ServiceToggle {
	/** Defaults to `true` when the service namespace is present. Set `false` to opt out. */
	enabled?: boolean;
}

/**
 * How a branch-scoped service (Neon Auth, Data API, AI Gateway) is toggled in a policy.
 *
 * - `true` / `{}` / `{ enabled: true }` — enabled.
 * - `false` / `{ enabled: false }` — disabled.
 * - omitted (`undefined`) — not part of the policy at all.
 *
 * These toggles are **static** (they live in the top-level `defineConfig({ … })` object,
 * not in the per-branch `branch` closure) so the secret set they imply can be derived at
 * the type level — that's what makes `NeonEnv<typeof config>` exact.
 */
export type ServiceToggleInput = boolean | ServiceToggle;

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
 * Local-development settings for a function, used by `neon dev` when it serves every
 * function declared in `neon.ts` (i.e. invoked with no `--source`). Never affects deploy.
 *
 * `port` and `portless` are independent:
 *
 * - `portless: true` — wrap this function's local server with `portless <slug> …` so it gets
 *   a stable `slug.localhost` URL. Portless assigns the port itself (it injects `PORT`), so
 *   `port` is ignored in this mode.
 * - otherwise — serve directly. `port`, when set, is bound exactly (and `neon dev` fails
 *   loudly if it is taken); when omitted a free port is found automatically.
 */
export interface FunctionDevConfig {
	/**
	 * Port the local server binds. Bound exactly (fails if taken) when set; a free port is
	 * found when omitted. Ignored when `portless` is true (portless assigns the port).
	 */
	port?: number;
	/**
	 * Expose this function via `portless` (a stable `slug.localhost` URL). Requires the
	 * `portless` binary on PATH. Portless assigns the port, so `port` is ignored here.
	 */
	portless?: boolean;
}

/**
 * Static definition of a Neon Function (Preview feature). Declares that the function
 * **exists** on every branch; its branch-unique slug is the **record key** in
 * {@link PreviewInput.functions} (not a field here), so slugs are statically enumerable,
 * cannot duplicate, and the `branch` closure can only tune slugs that are declared here.
 *
 * A function is invoked like a Cloudflare/Vercel handler — its source module
 * `export default { fetch }` or `export async function handler(req): Response`. The
 * `source` path is bundled (esbuild) and uploaded as a deployment; the newest deployment
 * becomes active.
 *
 * Deploy tuning (`memoryMib`, `runtime`) is **not** here — it varies per branch and lives
 * in the `branch` closure (see {@link FunctionTuning}).
 */
export interface FunctionDef {
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
	 * Environment variables injected into the deployed function, keyed by the var name the
	 * function reads at runtime. The **keys** are static (preserved at the type level so
	 * `parseEnv(config, "<slug>").function.<key>` is typed); the **values** are arbitrary
	 * strings evaluated when `neon.ts` is loaded (typically `process.env.X`) and uploaded
	 * at `config apply`. Every value must be a defined string — a `process.env.X` that is
	 * `undefined` (unset) errors at validation time rather than silently shipping
	 * `undefined`.
	 * @example { resendApiKey: process.env.RESEND_API_KEY ?? "" }
	 */
	env?: Record<string, string>;
	/**
	 * Local-development settings used by `neon dev` when serving every function from
	 * `neon.ts`. Ignored at deploy time. See {@link FunctionDevConfig}.
	 */
	dev?: FunctionDevConfig;
}

/** Anonymous-access level for a branchable object-storage bucket. */
export type BucketAccessLevel = "private" | "public_read";

/**
 * Static definition of a branchable object-storage bucket (Preview feature). The bucket's
 * name is the **record key** in {@link PreviewInput.buckets}, so names are statically
 * enumerable and cannot duplicate.
 */
export interface BucketDef {
	/**
	 * Anonymous access level. `private` (default) requires authenticated reads/writes;
	 * `public_read` allows anonymous GetObject/HeadObject.
	 */
	access?: BucketAccessLevel;
}

/**
 * Static, branch-scoped **Preview** features. Grouped under `preview` to signal they are
 * backed by Neon `x-stability-level: beta` endpoints and may change before GA. Everything
 * here is existential (it determines what exists on the branch); per-branch tuning lives in
 * the `branch` closure.
 */
export interface PreviewInput {
	/** Enable/disable the AI Gateway on the branch (toggle, like auth / dataApi). */
	aiGateway?: ServiceToggleInput;
	/** Functions to deploy, keyed by branch-unique slug (`^[a-z0-9]{1,20}$`). */
	functions?: Record<string, FunctionDef>;
	/** Object-storage buckets to create, keyed by bucket name. */
	buckets?: Record<string, BucketDef>;
}

/**
 * Per-branch deploy tuning for a single function. Returned (per slug) by the `branch`
 * closure. Deliberately **cannot** change the function's existence, source, name, or env
 * **keys** — only how it is deployed — so the static secret/function set stays sound.
 */
export interface FunctionTuning {
	/** Memory allotted to each invocation, in MiB. Defaults to `512`. */
	memoryMib?: FunctionMemoryMib;
	/** Runtime to execute the function with. Defaults to `"nodejs24"`. */
	runtime?: FunctionRuntime;
}

/**
 * Per-branch tuning of Preview features. Only existing function slugs (those declared in
 * the static {@link PreviewInput.functions}) may be tuned — `Slug` is constrained to the
 * declared keys by {@link BranchTuningFn}.
 */
export interface PreviewTuning<Slug extends string = string> {
	functions?: Partial<Record<Slug, FunctionTuning>>;
}

/**
 * The per-branch tuning object returned by the `branch` closure. It can adjust branch
 * lifecycle (`parent`, `ttl`, `protected`), Postgres compute settings, and per-function
 * deploy tuning — but **cannot** add/remove services or functions. That guarantee is what
 * keeps the static secret set (and therefore `NeonEnv`) exact.
 */
export interface BranchTuning<Slug extends string = string> {
	/** Parent branch name used when creating a new branch. Not a Postgres setting. */
	parent?: string;
	/** Time-to-live applied when creating a new branch, or reconciled on existing branches. */
	ttl?: string | number;
	/** Whether the selected branch should be protected. Undefined means "leave as-is". */
	protected?: boolean;
	postgres?: PostgresConfig;
	preview?: PreviewTuning<Slug>;
}

/** Extract the declared function slugs from a {@link PreviewInput} for closure typing. */
type FunctionSlugsOf<Preview extends PreviewInput | undefined> =
	Preview extends {
		functions: infer F;
	}
		? Extract<keyof F, string>
		: string;

/**
 * Signature of the `branch` closure. Generic over the static {@link PreviewInput} so the
 * `preview.functions` keys it may tune are constrained to the slugs actually declared.
 */
export type BranchTuningFn<
	Preview extends PreviewInput | undefined = PreviewInput | undefined,
> = (branch: BranchTarget) => BranchTuning<FunctionSlugsOf<Preview>>;

/**
 * A validated Neon branch policy — the value `defineConfig({ … })` returns and `neon.ts`
 * default-exports.
 *
 * Split into a **static** existential set (top-level `auth` / `dataApi` GA toggles plus the
 * beta `preview` block) and a **dynamic** per-branch `branch` closure for tuning. The
 * static half is what makes the secret set — and therefore `NeonEnv<typeof config>` and
 * `parseEnv` — exact; the closure can tune but never change what exists.
 *
 * Generic over the three static fields so the type system can read the exact toggle/slug
 * literals; the defaults make the bare `Config` a usable "any policy" type for runtime
 * function signatures.
 */
export interface Config<
	Auth extends ServiceToggleInput | undefined =
		| ServiceToggleInput
		| undefined,
	DataApi extends ServiceToggleInput | undefined =
		| ServiceToggleInput
		| undefined,
	Preview extends PreviewInput | undefined = PreviewInput | undefined,
> {
	/** Neon Auth integration toggle (GA). Static — drives `NeonEnv.auth`. */
	auth?: Auth;
	/** Neon Data API integration toggle (GA). Static — drives `NeonEnv.dataApi`. */
	dataApi?: DataApi;
	/** Beta (Preview) feature set: AI Gateway, functions, buckets. Static. */
	preview?: Preview;
	/** Per-branch tuning closure. Cannot change the static existential set. */
	branch?: BranchTuningFn<Preview>;
}

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
	/**
	 * Local-development settings, passed through untouched from {@link FunctionConfig.dev}
	 * (no defaults applied). Only consumed by `neon dev`; deploy ignores it.
	 */
	dev?: FunctionDevConfig;
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
