/**
 * Valid Neon Compute Unit values.
 * Most plans support 0.25, 0.5, 1, 2, 4, 8. Higher values may be available on Business plans.
 */
export type ComputeUnit = 0.25 | 0.5 | 1 | 2 | 4 | 8;

/** Time units accepted in a {@link DurationString}: seconds, minutes, hours, days, weeks. */
export type DurationUnit = "s" | "m" | "h" | "d" | "w";

/**
 * A Neon duration string: a positive integer **followed by a unit** — `s` (seconds),
 * `m` (minutes), `h` (hours), `d` (days), or `w` (weeks). Used by
 * {@link ComputeSettings.suspendTimeout} and {@link BranchTuning.ttl}.
 *
 * A **unit is required**: a bare numeric string like `"7"` is rejected at the type level. To
 * express a raw number of seconds, pass a `number` (`300`) — not a string (`"300"`). This
 * removes the old ambiguity where `"7"` silently meant 7 *seconds* instead of, say, `"7d"`.
 *
 * @example "5m"  // 5 minutes
 * @example "1h"  // 1 hour
 * @example "7d"  // 7 days
 */
export type DurationString = `${number}${DurationUnit}`;

/**
 * Autocomplete suggestions for {@link ComputeSettings.suspendTimeout}. Every value sits inside
 * the Neon API's allowed scale-to-zero band: **60s–604800s** (1 minute – 1 week). This is *not*
 * a closed set — the field also accepts any other {@link DurationString} or a `number` of
 * seconds; out-of-range values type-check but are rejected at apply time.
 */
type SuspendTimeoutSuggestion =
	| "1m"
	| "5m"
	| "15m"
	| "30m"
	| "1h"
	| "6h"
	| "12h"
	| "1d"
	| "7d";

/**
 * Autocomplete suggestions for {@link BranchTuning.ttl}. Every value sits within the Neon API's
 * branch-expiration limit (**max 30 days** from creation; the Console's own presets are 1h / 1d
 * / 7d). This is *not* a closed set — the field also accepts any other {@link DurationString} or
 * a `number` of seconds; values over 30 days are rejected at apply time.
 */
type TtlSuggestion = "1h" | "6h" | "12h" | "1d" | "3d" | "7d" | "14d" | "30d";

/**
 * Compose a field's duration type: its curated autocomplete `Suggestions` plus the open
 * `DurationString` template (so any `<integer><unit>` string still type-checks) and a `number`
 * of seconds. Intersecting the template arm with `NonNullable<unknown>` stops TypeScript from
 * collapsing the literal suggestions into the template, which is what preserves the autocomplete.
 */
type DurationField<Suggestions extends DurationString> =
	| Suggestions
	| (DurationString & NonNullable<unknown>)
	| number;

/**
 * Compute settings applied to the read/write endpoint of a branch.
 *
 * Mirrors the subset of {@link https://api-docs.neon.tech/reference/getting-started-with-neon-api Neon endpoint}
 * fields that we expose as IaC primitives. Anything left undefined falls back to the project's
 * `default_endpoint_settings` (which themselves fall back to Neon defaults).
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
	 * How long an idle compute waits before suspending (Neon's scale-to-zero). Accepts a
	 * {@link DurationString} (autocompletes common values), a number of seconds, or `false`.
	 *
	 * - `false` — never suspend (always-on compute)
	 * - {@link DurationString} — e.g. `"5m"`; autocompletes the in-range values `"1m"`, `"5m"`,
	 *   `"15m"`, `"30m"`, `"1h"`, `"6h"`, `"12h"`, `"1d"`, `"7d"`, and accepts any other
	 *   `<integer><unit>` (units: `s`, `m`, `h`, `d`, `w`). A **unit is required** — for raw
	 *   seconds pass a `number`, not a string.
	 * - `number` — custom timeout in **seconds**, must be in `60`–`604800` (1 minute to 1 week)
	 * - `undefined` — use the Neon default (currently 300s / 5 minutes)
	 *
	 * Whichever form you use, the resolved timeout must fall in `60`–`604800` seconds (the Neon
	 * API limit); the suggestions are all within that band, anything else is checked at apply.
	 *
	 * @example false  // never suspend (always-on)
	 * @example "5m"   // suspend after 5 minutes idle
	 * @example "1h"   // suspend after 1 hour idle
	 * @example 300    // 5 minutes, expressed in seconds
	 */
	suspendTimeout?: false | DurationField<SuspendTimeoutSuggestion>;
}

/**
 * Read-only descriptor of the branch a {@link Config} policy is being evaluated for — the
 * `branch` argument passed to your `defineConfig({ branch: (branch) => … })` closure. It describes
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

/**
 * Resolve a **static** service toggle (`true` / `false` / `{ enabled?: boolean }` / object /
 * `undefined`) to a type-level boolean. The tuple wrapping (`[T] extends […]`) disables
 * distribution so a union/`undefined` is judged as a single unit:
 *
 * - `false` / `{ enabled: false }` / `undefined` → `false`
 * - `true` / `{ enabled: true }` / any other object (`{}`, `{ enabled?: boolean }`) → `true`
 *   (a present toggle defaults to enabled)
 * - the bare `boolean | … | undefined` (no literal info) → `false`
 *
 * Shared by the {@link Config} static cross-field checks and the `@neon/env`
 * `NeonEnv` namespace derivation, so both read "is this service on?" identically.
 */
export type ServiceEnabled<T> = [T] extends [false]
	? false
	: [T] extends [{ enabled: false }]
		? false
		: [T] extends [undefined]
			? false
			: [T] extends [true]
				? true
				: [T] extends [{ enabled: true }]
					? true
					: [T] extends [object]
						? true
						: false;

export interface PostgresConfig {
	computeSettings?: ComputeSettings;
}

/**
 * Authentication providers a Data API integration can verify JWTs against, as written in
 * `neon.ts`. Friendly authoring values (mapped to the Neon API's `neon_auth` / `external`
 * at the API boundary):
 *
 * - `"neon"` — verify tokens minted by **Neon Auth** on the same branch. Neon supplies the
 *   JWKS URL / provider wiring for you, so the `jwksUrl` / `providerName` / `jwtAudience`
 *   fields are forbidden (a type error) on this variant — and the policy must also enable
 *   top-level `auth` (Neon Auth) so the tokens exist.
 * - `"external"` — verify tokens from a third-party IdP (Clerk, Stytch, Auth0, …). You
 *   provide `jwksUrl` (and optionally `providerName` / `jwtAudience`).
 */
export const DATA_API_AUTH_PROVIDERS = ["neon", "external"] as const;
export type DataApiAuthProvider = (typeof DATA_API_AUTH_PROVIDERS)[number];

/**
 * Reusable runtime settings for a Data API integration (the Neon API `DataAPISettings`,
 * camelCased to match the rest of `neon.ts`). Every field is optional; omitted fields keep
 * the Neon defaults shown below. These are the **only** Data API fields that can change on
 * an already-enabled integration — drift here is reconciled as an *update* (requires
 * `updateExisting` / `--update-existing`); the create-only auth wiring above cannot.
 */
export interface DataApiSettings {
	/** Enable the aggregates feature (`db_aggregates_enabled`). Default `true`. */
	dbAggregatesEnabled?: boolean;
	/** Database role used for anonymous requests (`db_anon_role`). Default `"anonymous"`. */
	dbAnonRole?: string;
	/** Extra schemas appended to the search path (`db_extra_search_path`). */
	dbExtraSearchPath?: string;
	/** Maximum rows returned in a single request (`db_max_rows`). */
	dbMaxRows?: number;
	/** Schemas exposed via the API (`db_schemas`). Default `["public"]`. */
	dbSchemas?: string[];
	/** JWT claim key used for role extraction (`jwt_role_claim_key`). Default `".role"`. */
	jwtRoleClaimKey?: string;
	/** Maximum lifetime of the JWT cache, in seconds (`jwt_cache_max_lifetime`). */
	jwtCacheMaxLifetime?: number;
	/** OpenAPI spec mode (`openapi_mode`). Default `"disabled"`. */
	openapiMode?: "ignore-privileges" | "disabled";
	/** CORS allowed origins (`server_cors_allowed_origins`). */
	serverCorsAllowedOrigins?: string;
	/** Emit server-timing headers (`server_timing_enabled`). */
	serverTimingEnabled?: boolean;
}

/** Fields shared by every {@link DataApiConfig} variant. */
interface DataApiConfigBase {
	/** Defaults to `true` when the `dataApi` namespace is present. Set `false` to opt out. */
	enabled?: boolean;
	/** Reusable runtime settings. Drift here is reconciled as an update. */
	settings?: DataApiSettings;
}

/**
 * Data API verified by **Neon Auth** (`authProvider: "neon"`, the default). The external
 * IdP fields are statically forbidden (`?: never`) because Neon supplies them; declaring any
 * of them is a type error directing you to `authProvider: "external"`.
 */
export interface DataApiNeonAuthConfig extends DataApiConfigBase {
	authProvider?: "neon";
	/** Forbidden with `authProvider: "neon"` — Neon provides the JWKS URL. */
	jwksUrl?: never;
	/** Forbidden with `authProvider: "neon"` — the provider is Neon Auth. */
	providerName?: never;
	/** Forbidden with `authProvider: "neon"` — Neon manages the audience. */
	jwtAudience?: never;
}

/**
 * Data API verified by an **external** IdP (`authProvider: "external"`). You provide the
 * JWKS URL (and optionally a provider label / expected audience).
 */
export interface DataApiExternalAuthConfig extends DataApiConfigBase {
	authProvider: "external";
	/** URL that publishes the IdP's JWKS (JSON Web Key Set). */
	jwksUrl?: string;
	/** Human label for the IdP (e.g. "Clerk", "Stytch", "Auth0"). */
	providerName?: string;
	/**
	 * Expected `aud` claim. ⚠️ This only **rejects** tokens carrying a *different* audience;
	 * tokens with no `aud` claim are still accepted.
	 */
	jwtAudience?: string;
}

/**
 * Object form of the `dataApi` toggle. A discriminated union on {@link DataApiAuthProvider}:
 * the `"neon"` variant forbids the external-IdP fields, the `"external"` variant allows them.
 */
export type DataApiConfig = DataApiNeonAuthConfig | DataApiExternalAuthConfig;

/**
 * How the Data API is toggled in a policy: a bare boolean (like the other service toggles)
 * or the richer {@link DataApiConfig} object. `true` / `{}` / `{ enabled: true }` enable it
 * with Neon defaults; `false` / `{ enabled: false }` opt out.
 */
export type DataApiInput = boolean | DataApiConfig;

/**
 * Supported function runtimes. Mirrors the Neon Functions deploy API `runtime` enum.
 * Only `nodejs24` exists today; kept as a union so adding runtimes later is a
 * non-breaking, type-checked change.
 */
export type FunctionRuntime = "nodejs24";

/**
 * Local-development settings for a function, used by `neon dev` when it serves every
 * function declared in `neon.ts` (i.e. invoked with no `--source`). Never affects deploy.
 */
export interface FunctionDevConfig {
	/**
	 * Port the local server binds. Bound exactly (and `neon dev` fails loudly if it is taken)
	 * when set; a free port is found automatically when omitted.
	 */
	port?: number;
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
 * Runtime tuning is **not** here — it varies per branch and lives in the `branch` closure
 * (see {@link FunctionTuning}). Memory is fixed by the platform policy for now and is not
 * user-configurable.
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

/**
 * A single capability a branch-scoped service credential may exercise (Preview). A
 * credential is granted a set of these and may only perform the listed actions. Mirrors
 * the Neon API `CredentialScope` enum (`x-stability-level: beta`):
 *
 * - `storage:read` / `storage:write` — object-storage (bucket) access via the S3 key.
 * - `ai_gateway:invoke` — call the AI Gateway with the bearer `api_token`.
 * - `functions:invoke` — invoke Neon Functions with the bearer `api_token`.
 *
 * The set a policy needs is derived from its enabled Preview features (see
 * {@link deriveCredentialScopes}); it is never authored by hand.
 */
export type CredentialScope =
	| "storage:read"
	| "storage:write"
	| "ai_gateway:invoke"
	| "functions:invoke";

/**
 * Who a credential acts as. `user` is the developer/app principal minted for local dev and
 * app bootstrap (`fetchEnv` / `env pull`); `function` is a deployed-function principal
 * (carries a `function_id`). The env tooling only mints `user` credentials today.
 */
export type CredentialPrincipalType = "user" | "function";

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
 * closure. Deliberately **cannot** change the function's existence, source, name, env
 * **keys**, or memory — only runtime selection is currently configurable — so the static
 * secret/function set stays sound.
 */
export interface FunctionTuning {
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
	/**
	 * Branch time-to-live: how long after creation the branch should auto-expire. Applied
	 * when creating a new branch and reconciled on existing branches (when `updateExisting`
	 * is set). Accepts a {@link DurationString} (autocompletes common values) or a number of
	 * seconds. Omit to keep the branch indefinitely.
	 *
	 * - {@link DurationString} — e.g. `"7d"`; autocompletes `"1h"`, `"6h"`, `"12h"`, `"1d"`,
	 *   `"3d"`, `"7d"`, `"14d"`, `"30d"`, and accepts any other `<integer><unit>` (units: `s`,
	 *   `m`, `h`, `d`, `w` — e.g. `"12h"`, `"2w"`). A **unit is required** — `"7"` is rejected;
	 *   for raw seconds pass a `number`.
	 * - `number` — custom TTL in **seconds** (e.g. `3600`)
	 * - `undefined` — no expiry; the branch persists until explicitly deleted
	 *
	 * The Neon API caps branch expiration at **30 days** from creation, so the resolved TTL must
	 * be `> 0` and `<= 30d`; the suggestions stay within that limit and anything longer is
	 * rejected at apply.
	 *
	 * @example "1d"   // ephemeral preview branch: expires a day after creation
	 * @example "7d"   // one-week TTL
	 * @example "30d"  // the maximum the API allows
	 * @example 3600   // 1 hour, expressed in seconds
	 */
	ttl?: DurationField<TtlSuggestion>;
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
	DataApi extends DataApiInput | undefined = DataApiInput | undefined,
	Preview extends PreviewInput | undefined = PreviewInput | undefined,
> {
	/** Neon Auth integration toggle (GA). Static — drives `NeonEnv.auth`. */
	auth?: Auth;
	/**
	 * Neon Data API integration (GA). Static — drives `NeonEnv.dataApi`. A boolean/toggle, or
	 * a {@link DataApiConfig} object selecting the auth provider (`"neon"` / `"external"`) and
	 * runtime {@link DataApiSettings}. With `authProvider: "neon"` the policy must also enable
	 * top-level `auth`.
	 */
	dataApi?: DataApi;
	/** Beta (Preview) feature set: AI Gateway, functions, buckets. Static. */
	preview?: Preview;
	/** Per-branch tuning closure. Cannot change the static existential set. */
	branch?: BranchTuningFn<Preview>;
}

/**
 * A function with all deploy defaults applied. `resolveConfig` fills in `runtime` so
 * downstream diff/apply never has to re-derive it.
 */
export interface ResolvedFunctionConfig {
	slug: string;
	name: string;
	source: string;
	env: Record<string, string>;
	runtime: FunctionRuntime;
	/**
	 * Local-development settings, passed through untouched from {@link FunctionDef.dev}
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
 * Normalized {@link PreviewInput}. Only present on {@link ResolvedBranchConfig} when the
 * policy returned a `preview` block. `aiGatewayEnabled` follows the same
 * "present-and-not-`false`" semantics as `authEnabled` / `dataApiEnabled`.
 */
export interface ResolvedPreviewConfig {
	functions: ResolvedFunctionConfig[];
	buckets: ResolvedBucketConfig[];
	aiGatewayEnabled: boolean;
}

/**
 * Normalized Data API integration. Present on {@link ResolvedBranchConfig} only when the
 * policy enables `dataApi`. `authProvider` always resolves (defaults to `"neon"`); the
 * external-IdP wiring is present only for `"external"`; `settings` carries the camelCase
 * runtime settings (reconciled as an update when they drift).
 */
export interface ResolvedDataApiConfig {
	authProvider: DataApiAuthProvider;
	jwksUrl?: string;
	providerName?: string;
	jwtAudience?: string;
	settings?: DataApiSettings;
}

export interface ResolvedBranchConfig {
	parent?: string;
	ttlSeconds?: number;
	protected?: boolean;
	postgres?: PostgresConfig;
	authEnabled: boolean;
	dataApiEnabled: boolean;
	/**
	 * Resolved Data API integration. Present iff {@link dataApiEnabled} is `true`. Carries the
	 * create-time auth wiring and the updatable {@link DataApiSettings}.
	 */
	dataApi?: ResolvedDataApiConfig;
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
