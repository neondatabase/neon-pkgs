import type {
	NeonBranchSnapshot,
	NeonBucketSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionSnapshot,
} from "./neon-api.js";
import type {
	BucketAccessLevel,
	ComputeSettings,
	ConflictReport,
	ResolvedBranchConfig,
	ResolvedFunctionConfig,
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
	  }
	| {
			kind: "create-bucket";
			projectId: string;
			branchId: string;
			branchName: string;
			bucketName: string;
			accessLevel: BucketAccessLevel;
	  }
	| {
			kind: "create-function";
			projectId: string;
			branchId: string;
			branchName: string;
			fn: ResolvedFunctionConfig;
	  }
	| {
			/**
			 * Deploy (or re-deploy) code to a function. Always planned for every desired
			 * function — deployments are versioned and the newest becomes active, so a push
			 * ships the current source each time. `functionExists` tells `pushConfig` whether
			 * it must create the function first (covered by a preceding `create-function` step).
			 */
			kind: "deploy-function";
			projectId: string;
			branchId: string;
			branchName: string;
			fn: ResolvedFunctionConfig;
	  }
	| {
			kind: "enable-ai-gateway";
			projectId: string;
			branchId: string;
			branchName: string;
	  };

export interface RemoteServiceState {
	databaseName: string;
	authEnabled: boolean;
	dataApiEnabled: boolean;
}

/**
 * Snapshot of the branch's current Preview-feature state. Absent (`undefined`) when the
 * policy has no `preview` block — `pushConfig` only fetches this when needed.
 */
export interface RemotePreviewState {
	buckets: NeonBucketSnapshot[];
	functions: NeonFunctionSnapshot[];
	aiGatewayEnabled: boolean;
}

export interface RemoteState {
	projectId: string;
	branch: NeonBranchSnapshot;
	endpoint?: NeonEndpointSnapshot;
	services: RemoteServiceState;
	preview?: RemotePreviewState;
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
	diffServices({ config, remote, plan });
	diffPreview({ config, remote, plan });
	return { plan, conflicts };
}

/**
 * Plan Preview features (functions, buckets, AI Gateway). Like {@link diffServices}, this
 * is **additive**: it creates desired buckets/functions and enables the AI Gateway, but
 * never deletes buckets/functions or disables the gateway. Teardown is destructive, so it
 * stays explicit/manual — matching the existing auth / dataApi behaviour.
 *
 * Functions are always (re-)deployed: deployments are versioned and the newest becomes
 * active, so each push ships the current source. A `create-function` step precedes the
 * `deploy-function` step when the function does not yet exist remotely.
 */
function diffPreview(args: {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	plan: PlanStep[];
}): void {
	const { config, remote, plan } = args;
	const preview = config.preview;
	if (!preview) return;
	// `remote.preview` is only fetched when the policy has a preview block; treat a missing
	// snapshot as "nothing exists yet" so the diff is still well-defined.
	const state: RemotePreviewState = remote.preview ?? {
		buckets: [],
		functions: [],
		aiGatewayEnabled: false,
	};

	for (const bucket of preview.buckets) {
		if (state.buckets.some((b) => b.name === bucket.name)) continue;
		plan.push({
			kind: "create-bucket",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			bucketName: bucket.name,
			accessLevel: bucket.access,
		});
	}

	for (const fn of preview.functions) {
		const exists = state.functions.some((f) => f.slug === fn.slug);
		if (!exists) {
			plan.push({
				kind: "create-function",
				projectId: remote.projectId,
				branchId: remote.branch.id,
				branchName: remote.branch.name,
				fn,
			});
		}
		plan.push({
			kind: "deploy-function",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
			fn,
		});
	}

	if (preview.aiGatewayEnabled && !state.aiGatewayEnabled) {
		plan.push({
			kind: "enable-ai-gateway",
			projectId: remote.projectId,
			branchId: remote.branch.id,
			branchName: remote.branch.name,
		});
	}
}

/**
 * Plan additive branch-scoped integrations. Disabling remains explicit/manual because
 * teardown is destructive.
 */
function diffServices(args: {
	config: ResolvedBranchConfig;
	remote: RemoteState;
	plan: PlanStep[];
}): void {
	const { config, remote, plan } = args;
	const state = remote.services;
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
