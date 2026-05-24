import { normalizeRegion } from "./define-config.js";
import type {
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonDataApiSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import type {
	ComputeSettings,
	ConflictReport,
	ResolvedBranchConfig,
	ResolvedConfig,
} from "./types.js";

/**
 * A planned action to perform a single mutation against the Neon API. The diff engine
 * produces a list of these for `pushConfig` to execute (or report).
 */
export type PlanStep =
	| {
			kind: "rename-project";
			projectId: string;
			fromName: string;
			toName: string;
	  }
	| {
			kind: "create-branch";
			/** Source key in `branches` or `branchBlueprints` that drove the creation. */
			sourceKey: string;
			branchName: string;
			parentBranchName: string;
			parentBranchId?: string;
			expiresAt?: string;
			protected?: boolean;
			computeSettings?: ComputeSettings;
	  }
	| {
			kind: "update-branch-ttl";
			projectId: string;
			branchId: string;
			branchName: string;
			expiresAt: string | null;
	  }
	| {
			kind: "update-branch-protected";
			projectId: string;
			branchId: string;
			branchName: string;
			protected: boolean;
	  }
	| {
			kind: "update-endpoint";
			projectId: string;
			branchName: string;
			endpointId: string;
			settings: ComputeSettings;
	  }
	| {
			kind: "enable-auth";
			projectId: string;
			branchId: string;
			branchName: string;
			databaseName?: string;
	  }
	| {
			kind: "enable-data-api";
			projectId: string;
			branchId: string;
			branchName: string;
			databaseName: string;
	  };

/**
 * The current state of the project's `config.features` integrations on the branch the
 * features should target — typically the project's default / root concrete branch.
 *
 * `auth` / `dataApi` are `null` when the integration is not enabled on that branch.
 * `branchId` / `branchName` are the branch the diff will target if a feature has to be
 * enabled. `databaseName` is the database the Data API integration would attach to.
 *
 * Optional altogether: when `config.features` is empty / undefined, push doesn't fetch
 * the feature snapshot at all and passes `undefined`.
 */
export interface RemoteFeatureState {
	branchId: string;
	branchName: string;
	databaseName: string;
	auth: NeonAuthSnapshot | null;
	dataApi: NeonDataApiSnapshot | null;
}

export interface RemoteState {
	project: NeonProjectSnapshot;
	branches: NeonBranchSnapshot[];
	endpoints: NeonEndpointSnapshot[];
	features?: RemoteFeatureState;
}

export interface DiffOptions {
	/**
	 * Apply settings / `protected` / TTL drift on `config.branches` entries — and a
	 * project rename — as plan steps instead of reporting them as conflicts.
	 * Immutable project fields (region, pgVersion) always remain conflicts regardless.
	 * Default: `false`.
	 */
	updateExisting: boolean;
}

export interface DiffResult {
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

/**
 * Diff a desired configuration against a remote snapshot. Pure function.
 *
 * - Region and Postgres major version mismatches are **always** conflicts (Neon does not
 *   support changing them post-create — no flag can override this).
 * - Project name drift is mutable: planned as a `rename-project` step when
 *   `updateExisting: true`, reported as a conflict otherwise.
 * - `config.branches` entries always create-if-missing. Updating an existing branch's
 *   settings / `protected` flag requires `updateExisting: true`.
 * - `config.branchBlueprints` entries are **never** consulted by `diffConfig` — blueprints
 *   are creation-only and consumed by `branch()`. `pushConfig` deliberately leaves live
 *   blueprint-matched branches alone.
 */
export function diffConfig(
	config: ResolvedConfig,
	remote: RemoteState,
	options: DiffOptions,
): DiffResult {
	const conflicts: ConflictReport[] = [];
	const plan: PlanStep[] = [];

	// --- Project diff ---
	const desiredName = config.project.name;
	if (remote.project.name !== desiredName) {
		if (options.updateExisting) {
			plan.push({
				kind: "rename-project",
				projectId: remote.project.id,
				fromName: remote.project.name,
				toName: desiredName,
			});
		} else {
			conflicts.push({
				kind: "project",
				identifier: remote.project.id,
				field: "name",
				current: remote.project.name,
				desired: desiredName,
				reason: "Project name on Neon differs from local config. Pass `updateExisting: true` to rename, or update your config to match.",
			});
		}
	}

	if (config.project.region !== undefined) {
		const desiredRegion = normalizeRegion(config.project.region);
		if (remote.project.regionId !== desiredRegion) {
			conflicts.push({
				kind: "project",
				identifier: remote.project.id,
				field: "region",
				current: remote.project.regionId,
				desired: desiredRegion,
				reason: "Region is immutable on Neon. Recreate the project to change region.",
			});
		}
	}

	if (
		config.project.pgVersion !== undefined &&
		remote.project.pgVersion !== config.project.pgVersion
	) {
		conflicts.push({
			kind: "project",
			identifier: remote.project.id,
			field: "pgVersion",
			current: remote.project.pgVersion,
			desired: config.project.pgVersion,
			reason: "Postgres major version cannot be changed via push. Use Neon's upgrade flow.",
		});
	}

	// --- Branch diff ---
	const branchesByName = new Map(
		remote.branches.map((b) => [b.name, b] as const),
	);
	const endpointsByBranchId = new Map<string, NeonEndpointSnapshot>();
	for (const ep of remote.endpoints) {
		if (ep.type === "read_write") endpointsByBranchId.set(ep.branchId, ep);
	}

	for (const branch of config.branches) {
		diffBranchConfig({
			branch,
			branchesByName,
			endpointsByBranchId,
			config,
			remote,
			options,
			plan,
			conflicts,
		});
	}

	diffFeatures({ config, remote, plan });

	return { plan, conflicts };
}

/**
 * Plan the integrations driven by `config.features`. Currently only additive — when a
 * feature flag is `true` and the integration isn't yet enabled on the targeted branch,
 * we emit an `enable-*` plan step. When the flag is `false` (or absent) we leave any
 * existing integration alone — disabling is destructive (auth integrations create
 * `neon_auth.*` schemas, data API exposes a public REST endpoint), so the user has to
 * tear those down via the Neon console explicitly.
 */
function diffFeatures(args: {
	config: ResolvedConfig;
	remote: RemoteState;
	plan: PlanStep[];
}): void {
	const { config, remote, plan } = args;
	const features = config.features;
	if (!features) return;
	const state = remote.features;
	if (!state) return;
	if (features.auth === true && !state.auth) {
		const step: PlanStep = {
			kind: "enable-auth",
			projectId: remote.project.id,
			branchId: state.branchId,
			branchName: state.branchName,
		};
		if (state.databaseName) step.databaseName = state.databaseName;
		plan.push(step);
	}
	if (features.dataApi === true && !state.dataApi) {
		plan.push({
			kind: "enable-data-api",
			projectId: remote.project.id,
			branchId: state.branchId,
			branchName: state.branchName,
			databaseName: state.databaseName,
		});
	}
}

interface BranchConfigArgs {
	branch: ResolvedBranchConfig;
	branchesByName: Map<string, NeonBranchSnapshot>;
	endpointsByBranchId: Map<string, NeonEndpointSnapshot>;
	config: ResolvedConfig;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

function diffBranchConfig(args: BranchConfigArgs): void {
	const {
		branch,
		branchesByName,
		endpointsByBranchId,
		config,
		remote,
		options,
		plan,
		conflicts,
	} = args;
	const branchName = branch.name;
	const existing = branchesByName.get(branchName);

	if (!existing) {
		// Create the branch (always allowed for concrete `branches` entries).
		const parentName = resolveBranchParentName(branch, config);
		const parentBranch = parentName
			? branchesByName.get(parentName)
			: undefined;
		if (parentName && !parentBranch && parentName !== branchName) {
			// Parent isn't on Neon and isn't being created earlier in this push (we don't
			// reorder ahead of time in v1). Surface as a conflict so the user fixes their
			// config rather than silently failing at apply time.
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "parent",
				current: undefined,
				desired: parentName,
				reason: `Parent branch '${parentName}' does not exist on Neon. Create it first or remove the parent reference.`,
			});
			return;
		}

		const step: PlanStep = {
			kind: "create-branch",
			sourceKey: branch.key,
			branchName,
			parentBranchName:
				parentName ?? findDefaultBranchName(remote) ?? branchName,
		};
		if (parentBranch) step.parentBranchId = parentBranch.id;
		if (branch.protected) step.protected = true;
		if (branch.computeSettings)
			step.computeSettings = branch.computeSettings;
		plan.push(step);
		return;
	}

	// Branch exists. Check for setting drifts.
	if (branch.computeSettings) {
		const endpoint = endpointsByBranchId.get(existing.id);
		if (!endpoint) {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "endpoint",
				current: undefined,
				desired: branch.computeSettings,
				reason: "Branch has no read-write endpoint; cannot apply compute settings.",
			});
		} else {
			const drift = computeDriftBetween(branch.computeSettings, endpoint);
			if (drift) {
				if (options.updateExisting) {
					plan.push({
						kind: "update-endpoint",
						projectId: remote.project.id,
						branchName,
						endpointId: endpoint.id,
						settings: branch.computeSettings,
					});
				} else {
					conflicts.push({
						kind: "branch",
						identifier: branchName,
						field: "computeSettings",
						current: drift.current,
						desired: drift.desired,
						reason: "Existing branch has different compute settings. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
					});
				}
			}
		}
	}

	// `protected` drift.
	if (branch.protected !== existing.protected) {
		if (options.updateExisting) {
			plan.push({
				kind: "update-branch-protected",
				projectId: remote.project.id,
				branchId: existing.id,
				branchName,
				protected: branch.protected,
			});
		} else {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "protected",
				current: existing.protected,
				desired: branch.protected,
				reason: "Existing branch has a different `protected` flag. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
			});
		}
	}
}

function resolveBranchParentName(
	branch: ResolvedBranchConfig,
	config: ResolvedConfig,
): string | undefined {
	const parent = branch.parent;
	if (!parent) return undefined;
	const fromBranches = config.branches.find((b) => b.key === parent);
	if (fromBranches) return fromBranches.name;
	return parent;
}

function findDefaultBranchName(remote: RemoteState): string | undefined {
	return remote.branches.find((b) => b.isDefault)?.name;
}

function computeDriftBetween(
	desired: ComputeSettings,
	endpoint: NeonEndpointSnapshot,
): {
	current: Partial<ComputeSettings>;
	desired: Partial<ComputeSettings>;
} | null {
	const currentDrift: Partial<ComputeSettings> = {};
	const desiredDrift: Partial<ComputeSettings> = {};
	let drift = false;

	if (
		desired.autoscalingLimitMinCu !== undefined &&
		desired.autoscalingLimitMinCu !== endpoint.autoscalingLimitMinCu
	) {
		currentDrift.autoscalingLimitMinCu = endpoint.autoscalingLimitMinCu;
		desiredDrift.autoscalingLimitMinCu = desired.autoscalingLimitMinCu;
		drift = true;
	}
	if (
		desired.autoscalingLimitMaxCu !== undefined &&
		desired.autoscalingLimitMaxCu !== endpoint.autoscalingLimitMaxCu
	) {
		currentDrift.autoscalingLimitMaxCu = endpoint.autoscalingLimitMaxCu;
		desiredDrift.autoscalingLimitMaxCu = desired.autoscalingLimitMaxCu;
		drift = true;
	}
	if (
		desired.suspendTimeout !== undefined &&
		desired.suspendTimeout !== endpoint.suspendTimeout
	) {
		currentDrift.suspendTimeout = endpoint.suspendTimeout;
		desiredDrift.suspendTimeout = desired.suspendTimeout;
		drift = true;
	}
	return drift ? { current: currentDrift, desired: desiredDrift } : null;
}
