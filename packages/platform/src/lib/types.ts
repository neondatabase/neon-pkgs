/**
 * Compute settings applied to the read/write endpoint of a branch.
 *
 * Mirrors the subset of {@link https://api-docs.neon.tech/reference/getting-started-with-neon-api Neon endpoint}
 * fields that we expose as IaC primitives. Anything left undefined falls back to the project's
 * `default_endpoint_settings` (which themselves fall back to Neon platform defaults).
 */
export interface ComputeSettings {
	/**
	 * Minimum number of Compute Units. Minimum legal value is 0.25.
	 */
	autoscalingLimitMinCu?: number;
	/**
	 * Maximum number of Compute Units.
	 */
	autoscalingLimitMaxCu?: number;
	/**
	 * Duration of inactivity in seconds before the compute is suspended.
	 *
	 * - `0` means use the Neon default (currently 300s).
	 * - `-1` means never suspend.
	 * - Any positive value between 60 and 604800 sets a custom suspend timeout.
	 */
	suspendTimeoutSeconds?: number;
}

/**
 * A branch blueprint describes the desired state of any branch whose name matches `pattern`.
 *
 * When the blueprint key is used as the pattern (the default) the blueprint targets a single
 * concrete branch. When `pattern` contains `*` characters the blueprint becomes a template that
 * applies to all matching branches.
 */
export interface BranchBlueprint {
	/**
	 * Branch name pattern. Supports `*` wildcards. When omitted, the blueprint key is used.
	 *
	 * Examples: `"production"`, `"preview-*"`, `"feat-*"`.
	 */
	pattern?: string;
	/**
	 * Time-to-live for ephemeral branches. When set, matching branches are scheduled for
	 * deletion after the TTL elapses. Accepts simple duration strings: `30s`, `5m`, `1h`,
	 * `7d`, `2w`, or a positive integer (interpreted as seconds).
	 *
	 * When omitted, the matched branch is not treated as ephemeral and has no expiry.
	 */
	ttl?: string | number;
	/**
	 * Parent branch. Resolved against other blueprint keys first, then against branch names.
	 * Defaults to `"production"` (which must be defined as a blueprint or already exist).
	 */
	parent?: string;
	/**
	 * Optional compute settings. When omitted, the matched branch inherits the project-level
	 * defaults from the Neon Console.
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
 */
export interface Config {
	project: ProjectConfig;
	/**
	 * Branch blueprints keyed by an identifier. When `pattern` is omitted on a blueprint,
	 * the key is used as the pattern.
	 */
	branchBlueprints?: Record<string, BranchBlueprint>;
}

/**
 * A blueprint after defaults have been resolved (key copied into `pattern`, etc.).
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
