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
 * Project-level configuration. The `name` is treated as an upsert key. `region` only matters
 * when the project is being created and must not change once the project exists.
 */
export interface ProjectConfig {
	/** Project name. Used as the upsert key for the Neon project. */
	name: string;
	/**
	 * Cloud region identifier, e.g. `"aws-us-east-1"`. Only consulted on project create.
	 * If the remote project exists with a different region, `pushConfig` will surface a
	 * conflict (regions are immutable on Neon).
	 *
	 * Accepts shorthand without the cloud prefix (`"us-east-1"`) which we normalize to
	 * `"aws-us-east-1"` for the API call.
	 */
	region?: string;
	/**
	 * Major Postgres version. When omitted, Neon's default is used at project-create time.
	 */
	pgVersion?: number;
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
	 * Templates for ephemeral branches. Each entry's `pattern` must contain `*`; the
	 * blueprint is consumed by `branch()` to mint new branches and (optionally) by
	 * `pushConfig --apply-existing` to retroactively apply settings to every matching
	 * branch already on Neon.
	 */
	branchBlueprints?: Record<string, BranchBlueprint>;
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
}

/**
 * One concrete change `pushConfig` made (or, in dry-run, would make) on the remote.
 */
export interface AppliedChange {
	kind: "project" | "branch";
	action: "create" | "update" | "noop";
	identifier: string;
	details?: Record<string, unknown>;
}

/**
 * A diff entry that conflicts with the desired config. Reported by `pushConfig` when
 * `applyChanges` is `false` (the default).
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
	applied: AppliedChange[];
	conflicts: ConflictReport[];
	/**
	 * Wildcard branches that were detected but skipped because `applyExisting` was not set.
	 */
	skippedWildcardBranches: Array<{ pattern: string; branches: string[] }>;
}
