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

export interface FeatureToggle {
	/** Defaults to `true` when the feature namespace is present. Set `false` to opt out. */
	enabled?: boolean;
}

export interface PostgresConfig {
	computeSettings?: ComputeSettings;
}

export interface BranchConfig {
	/** Parent branch name used when creating a new branch. Not a Postgres setting. */
	parent?: string;
	/** Time-to-live applied when creating a new branch, or reconciled on existing branches. */
	ttl?: string | number;
	/** Whether the selected branch should be protected. Undefined means "leave as-is". */
	protected?: boolean;
	postgres?: PostgresConfig;
	auth?: FeatureToggle;
	dataApi?: FeatureToggle;
}

export type Config = (branch: BranchTarget) => BranchConfig;

export interface ResolvedBranchConfig {
	parent?: string;
	ttlSeconds?: number;
	protected?: boolean;
	postgres?: PostgresConfig;
	authEnabled: boolean;
	dataApiEnabled: boolean;
}

/**
 * One concrete change `pushConfig` made (or, in dry-run, would make) on the remote.
 */
export interface AppliedChange {
	/**
	 * `feature` covers branch-scoped integrations driven by the branch policy (e.g.
	 * Neon Auth, Data API).
	 */
	kind: "branch" | "feature";
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
