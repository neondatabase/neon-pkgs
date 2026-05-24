import type { NeonBranchSnapshot, NeonEndpointSnapshot } from "./neon-api.js";
import type {
	ComputeSettings,
	ConflictReport,
	ResolvedBranchConfig,
} from "./types.js";

/**
 * A planned action to perform a single mutation against the Neon API. The diff engine
 * produces a list of these for `pushConfig` to execute (or report).
 */
export type PlanStep =
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

export interface RemoteFeatureState {
	databaseName: string;
	authEnabled: boolean;
	dataApiEnabled: boolean;
}

export interface RemoteState {
	projectId: string;
	branch: NeonBranchSnapshot;
	endpoint?: NeonEndpointSnapshot;
	features: RemoteFeatureState;
}

export interface DiffOptions {
	/**
	 * Apply mutable drift on the selected branch as plan steps instead of conflicts.
	 * Default: `false`.
	 */
	updateExisting: boolean;
}

export interface DiffResult {
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

/**
 * Diff desired branch policy against the selected remote branch. Pure function.
 */
export function diffConfig(
	config: ResolvedBranchConfig,
	remote: RemoteState,
	options: DiffOptions,
): DiffResult {
	const conflicts: ConflictReport[] = [];
	const plan: PlanStep[] = [];
	diffBranchConfig({ config, remote, options, plan, conflicts });
	diffFeatures({ config, remote, plan });
	return { plan, conflicts };
}

/**
 * Plan additive branch-scoped integrations. Disabling remains explicit/manual because
 * teardown is destructive.
 */
function diffFeatures(args: {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	plan: PlanStep[];
}): void {
	const { config, remote, plan } = args;
	const state = remote.features;
	if (config.authEnabled && !state.authEnabled) {
		const step: PlanStep = {
			kind: "enable-auth",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
		};
		if (state.databaseName) step.databaseName = state.databaseName;
		plan.push(step);
	}
	if (config.dataApiEnabled && !state.dataApiEnabled) {
		plan.push({
			kind: "enable-data-api",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			databaseName: state.databaseName,
		});
	}
}

interface BranchConfigArgs {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

function diffBranchConfig(args: BranchConfigArgs): void {
	const { config, remote, options, plan, conflicts } = args;
	const branchName = remote.branch.name;
	const computeSettings = config.postgres?.computeSettings;

	if (computeSettings) {
		const endpoint = remote.endpoint;
		if (!endpoint) {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "endpoint",
				current: undefined,
				desired: computeSettings,
				reason: "Branch has no read-write endpoint; cannot apply compute settings.",
			});
		} else {
			const drift = computeDriftBetween(computeSettings, endpoint);
			if (drift) {
				if (options.updateExisting) {
					plan.push({
						kind: "update-endpoint",
						projectId: remote.projectId,
						branchName,
						endpointId: endpoint.id,
						settings: computeSettings,
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

	if (
		config.protected !== undefined &&
		config.protected !== remote.branch.protected
	) {
		if (options.updateExisting) {
			plan.push({
				kind: "update-branch-protected",
				projectId: remote.projectId,
				branchId: remote.branch.id,
				branchName,
				protected: config.protected,
			});
		} else {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "protected",
				current: remote.branch.protected,
				desired: config.protected,
				reason: "Existing branch has a different `protected` flag. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
			});
		}
	}

	if (config.ttlSeconds !== undefined) {
		const current = remote.branch.expiresAt
			? Math.max(
					0,
					Math.round(
						(Date.parse(remote.branch.expiresAt) - Date.now()) /
							1000,
					),
				)
			: undefined;
		if (
			current === undefined ||
			Math.abs(current - config.ttlSeconds) > 30
		) {
			const expiresAt = new Date(
				Date.now() + config.ttlSeconds * 1000,
			).toISOString();
			if (options.updateExisting) {
				plan.push({
					kind: "update-branch-ttl",
					projectId: remote.projectId,
					branchId: remote.branch.id,
					branchName,
					expiresAt,
				});
			} else {
				conflicts.push({
					kind: "branch",
					identifier: branchName,
					field: "ttl",
					current: remote.branch.expiresAt,
					desired: expiresAt,
					reason: "Existing branch has a different TTL. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
				});
			}
		}
	}
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
