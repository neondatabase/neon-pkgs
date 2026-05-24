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
 * Desired state of a single concrete, persistent branch (e.g. `production`, `staging`).
 *
 * The map key in {@link Config.branches} is the literal branch name on Neon — no wildcards.
 * These entries describe branches `pushConfig` should create-if-missing and update-on-drift.
 * For *ephemeral* branches spun up via `branch()`, see {@link BranchBlueprint} instead.
 */
export interface BranchConfig {
	/**
	 * Parent branch. Resolved against other `branches` keys first, then against literal
	 * branch names on Neon. Defaults to `"production"` (which must be declared as another
	 * `branches` entry or already exist on Neon). The root branch (e.g. `production`) leaves
	 * this unset.
	 */
	parent?: string;
	/**
	 * Whether the branch is marked protected on Neon. Protected branches cannot be deleted
	 * without first removing the flag, and pick up additional safeguards (e.g. password
	 * rotation guards, IP allow-list enforcement). Defaults to `false`.
	 */
	protected?: boolean;
	/**
	 * Optional compute settings for the branch's read-write endpoint. When omitted, the
	 * branch inherits the project-level defaults from the Neon Console.
	 */
	computeSettings?: ComputeSettings;
}

/**
 * Template for *ephemeral* branches spun up via `branch()`. Every blueprint's `pattern`
 * must contain a `*` wildcard — the wildcard is what makes the blueprint a factory rather
 * than a single managed branch. For specific-name branches (e.g. `production`), use
 * {@link BranchConfig} under {@link Config.branches} instead.
 */
export interface BranchBlueprint {
	/**
	 * Branch name pattern. **Must** contain a `*` wildcard. Examples: `"preview-*"`,
	 * `"feat-*"`, `"pr-*-staging"`. The `*` is substituted with `<git-branch>-<mini-id>`
	 * (or just `<mini-id>` when git isn't available) at `branch()` call time.
	 */
	pattern: string;
	/**
	 * Optional time-to-live for the ephemeral child. When set, every branch minted from
	 * this blueprint is scheduled for deletion after the TTL elapses. Accepts simple
	 * duration strings: `30s`, `5m`, `1h`, `7d`, `2w`, or a positive integer (seconds).
	 *
	 * When omitted, branches from this blueprint do not expire — `branch()` becomes a
	 * convenient name-generator but the resulting branch lives on until explicitly deleted.
	 */
	ttl?: string | number;
	/**
	 * Parent branch. Resolved against `branches` keys first, then against literal branch
	 * names on Neon. Defaults to `"production"` (which must be declared as a `branches`
	 * entry or already exist on Neon).
	 */
	parent?: string;
	/**
	 * Optional compute settings applied to every child branch's read-write endpoint. When
	 * omitted, children inherit the project-level defaults from the Neon Console.
	 */
	computeSettings?: ComputeSettings;
}

/**
 * Project-level configuration. `pushConfig` does **not** create projects — bootstrap one
 * via `neonctl link` (or the Neon Console) before pushing — so these fields are pure
 * metadata that push uses for **drift detection** against the remote project.
 *
 * `name` drift is mutable: pass `updateExisting: true` to rename the remote project to
 * match. `region` and `pgVersion` drift are immutable on Neon — they always surface as
 * `ConflictReport` entries, and the only fix is to recreate the project or change your
 * `neon.ts` to match the remote.
 */
export interface ProjectConfig {
	/**
	 * Project name on Neon. Used purely for drift detection (and to label `pullConfig`
	 * output). A mismatch surfaces as a `ConflictReport` unless `updateExisting: true`,
	 * which renames the remote project to match.
	 */
	name: string;
	/**
	 * Cloud region identifier, e.g. `"aws-us-east-1"`. Region is **immutable on Neon** —
	 * if the remote project's region differs from this value, `pushConfig` always reports
	 * a conflict (no flag can override it). Recreate the project to change region.
	 *
	 * Accepts shorthand without the cloud prefix (`"us-east-1"`) which is normalized to
	 * `"aws-us-east-1"` for comparison.
	 */
	region?: string;
	/**
	 * Major Postgres version. Immutable on Neon — a mismatch always surfaces as a
	 * `ConflictReport`. Use Neon's upgrade flow to change Postgres version.
	 */
	pgVersion?: number;
}

/**
 * Optional Neon-platform features that, when enabled, contribute additional namespaces
 * to the env surface returned by `fetchEnv` / `parseEnv`. Each flag is a literal `true` /
 * `false` (default `false`) — `defineConfig` is declared with a `const` generic so the
 * literal flows through to {@link NeonEnv}'s static type:
 *
 * ```ts
 * const config = defineConfig({
 *   project: { name: "my-app" },
 *   branches: { production: {} },
 *   features: { auth: true },
 * });
 * const env = parseEnv(config);
 * // env.postgres.databaseUrl       — always present
 * // env.auth.publishableClientKey  — present because features.auth is true
 * // env.dataApi                    — type error (features.dataApi is not enabled)
 * ```
 */
export interface FeatureFlags {
	/**
	 * Enable the Neon Auth integration. Adds the `auth` namespace to `NeonEnv`
	 * (`projectId`, `publishableClientKey`, `secretServerKey`, `jwksUrl`).
	 */
	auth?: boolean;
	/**
	 * Enable the Neon Data API. Adds the `dataApi` namespace to `NeonEnv` (`url`).
	 */
	dataApi?: boolean;
}

/**
 * A complete Neon Platform configuration. Built via {@link defineConfig}.
 *
 * The branch surface is split into two intentionally distinct maps:
 *
 * - {@link branches} — concrete, persistent branches managed by `pushConfig`. The map key
 *   is the literal branch name on Neon. Use this for `production`, `staging`, etc.
 * - {@link branchBlueprints} — templates for ephemeral branches spun up via `branch()`.
 *   Every blueprint's `pattern` must contain a `*` wildcard.
 *
 * Listing the *live* branches currently on a project (including ephemeral ones) is **not**
 * part of this config — that's a runtime query exposed by `neonctl branches list`.
 */
export interface Config {
	project: ProjectConfig;
	/**
	 * Concrete branches keyed by their literal name on Neon. Managed by `pushConfig`:
	 * created if missing, settings/TTL/protected drift surfaced (and applied with
	 * `updateExisting: true`).
	 */
	branches?: Record<string, BranchConfig>;
	/**
	 * Templates for *ephemeral* branches spun up via `branch()`. Each entry's `pattern`
	 * must contain a `*` wildcard. `pushConfig` deliberately **never** touches branches
	 * matched by a blueprint — they're owned by the dev / PR that minted them and are
	 * expected to be short-lived. Blueprints are creation-only.
	 */
	branchBlueprints?: Record<string, BranchBlueprint>;
	/**
	 * Optional Neon-platform features. Each enabled feature adds an extra namespace to the
	 * env surface returned by `fetchEnv` / `parseEnv` (e.g. `features.auth: true` → the
	 * `env.auth` namespace becomes statically known).
	 */
	features?: FeatureFlags;
}

/**
 * A concrete-branch config after defaults have been resolved (parent inferred, etc.).
 */
export interface ResolvedBranchConfig {
	/** The map key inside `branches`, which is also the branch name on Neon. */
	key: string;
	/** Branch name on Neon. Equal to `key`. */
	name: string;
	parent?: string;
	protected: boolean;
	computeSettings?: ComputeSettings;
}

/**
 * A blueprint after defaults have been resolved (TTL parsed to seconds, parent inferred).
 */
export interface ResolvedBranchBlueprint
	extends Required<Pick<BranchBlueprint, "pattern">> {
	/** The blueprint key inside `branchBlueprints`. */
	key: string;
	ttlSeconds?: number;
	parent?: string;
	computeSettings?: ComputeSettings;
}

export interface ResolvedConfig {
	project: ProjectConfig;
	branches: ResolvedBranchConfig[];
	branchBlueprints: ResolvedBranchBlueprint[];
	/** Project-level integration flags. Mirrors `Config.features`; pass-through. */
	features?: FeatureFlags;
}

/**
 * One concrete change `pushConfig` made (or, in dry-run, would make) on the remote.
 */
export interface AppliedChange {
	/**
	 * `feature` covers project-wide integrations driven by `config.features` (e.g.
	 * Neon Auth, Data API). The integration itself is enabled per-branch on Neon — the
	 * targeted branch lives in `details.branchName`.
	 */
	kind: "project" | "branch" | "feature";
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
	kind: "project" | "branch";
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
	/**
	 * `true` when `pushConfig` was called with `{ dryRun: true }`. `applied` then records
	 * what **would** be applied on a real push; no API mutations were performed.
	 */
	dryRun: boolean;
	applied: AppliedChange[];
	conflicts: ConflictReport[];
}
