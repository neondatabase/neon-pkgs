import { normalizeRegion } from "./define-config.js";
import type {
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import { matchPattern } from "./patterns.js";
import type {
	ComputeSettings,
	ConflictReport,
	ResolvedBranchBlueprint,
	ResolvedBranchConfig,
	ResolvedConfig,
} from "./types.js";

/**
 * A planned action to perform a single mutation against the Neon API. The diff engine
 * produces a list of these for `pushConfig` to execute (or report).
 */
export type PlanStep =
	| {
			kind: "create-project";
			name: string;
			regionId: string;
			pgVersion?: number;
			orgId?: string;
			defaultEndpointSettings?: ComputeSettings;
	  }
	| {
			kind: "update-project";
			projectId: string;
			defaultEndpointSettings: ComputeSettings;
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
	  };

export interface RemoteState {
	project: NeonProjectSnapshot;
	branches: NeonBranchSnapshot[];
	endpoints: NeonEndpointSnapshot[];
}

export interface DiffOptions {
	/** Allow updating existing specific-name branches' settings/TTL. Default: `false`. */
	updateExisting: boolean;
	/** Allow updating existing branches matched by a wildcard pattern. Default: `false`. */
	applyExisting: boolean;
}

export interface DiffResult {
	plan: PlanStep[];
	conflicts: ConflictReport[];
	skippedWildcardBranches: Array<{ pattern: string; branches: string[] }>;
}

/**
 * Diff a desired configuration against a remote snapshot. Pure function.
 *
 * - Region mismatches and unauthorized project rename are always conflicts (Neon does not
 *   support changing them post-create, regardless of `updateExisting`).
 * - `config.branches` entries always create-if-missing. Updating an existing branch's
 *   settings / `protected` flag requires `updateExisting: true`.
 * - `config.branchBlueprints` entries never create. They only update existing matching
 *   branches when `applyExisting: true` is set; otherwise matching branches are reported
 *   under `skippedWildcardBranches`.
 */
export function diffConfig(
	config: ResolvedConfig,
	remote: RemoteState,
	options: DiffOptions,
): DiffResult {
	const conflicts: ConflictReport[] = [];
	const plan: PlanStep[] = [];
	const skippedWildcardBranches: DiffResult["skippedWildcardBranches"] = [];

	// --- Project diff ---
	const desiredName = config.project.name;
	if (remote.project.name !== desiredName) {
		conflicts.push({
			kind: "project",
			identifier: remote.project.id,
			field: "name",
			current: remote.project.name,
			desired: desiredName,
			reason: "Project name on Neon differs from local config. Rename via the Neon console or update your config.",
		});
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

	// Track which existing branches are claimed by any blueprint so we don't double-warn.
	const claimedByWildcard = new Set<string>();

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

	for (const blueprint of config.branchBlueprints) {
		diffWildcardBlueprint({
			blueprint,
			remote,
			options,
			plan,
			conflicts,
			skippedWildcardBranches,
			claimedByWildcard,
			endpointsByBranchId,
		});
	}

	return { plan, conflicts, skippedWildcardBranches };
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

interface WildcardBlueprintArgs {
	blueprint: ResolvedBranchBlueprint;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
	skippedWildcardBranches: DiffResult["skippedWildcardBranches"];
	claimedByWildcard: Set<string>;
	endpointsByBranchId: Map<string, NeonEndpointSnapshot>;
}

function diffWildcardBlueprint(args: WildcardBlueprintArgs): void {
	const {
		blueprint,
		remote,
		options,
		plan,
		conflicts,
		skippedWildcardBranches,
		claimedByWildcard,
		endpointsByBranchId,
	} = args;

	const matching = remote.branches.filter(
		(b) =>
			matchPattern(blueprint.pattern, b.name) &&
			!b.isDefault &&
			!claimedByWildcard.has(b.name),
	);

	if (matching.length === 0) return;
	for (const m of matching) claimedByWildcard.add(m.name);

	if (!options.applyExisting) {
		skippedWildcardBranches.push({
			pattern: blueprint.pattern,
			branches: matching.map((b) => b.name),
		});
		return;
	}

	for (const branch of matching) {
		if (blueprint.computeSettings) {
			const endpoint = endpointsByBranchId.get(branch.id);
			if (!endpoint) {
				conflicts.push({
					kind: "branch",
					identifier: branch.name,
					field: "endpoint",
					current: undefined,
					desired: blueprint.computeSettings,
					reason: "Branch has no read-write endpoint; cannot apply compute settings.",
				});
				continue;
			}
			const drift = computeDriftBetween(
				blueprint.computeSettings,
				endpoint,
			);
			if (drift) {
				plan.push({
					kind: "update-endpoint",
					projectId: remote.project.id,
					branchName: branch.name,
					endpointId: endpoint.id,
					settings: blueprint.computeSettings,
				});
			}
		}

		const desiredExpiresAt =
			blueprint.ttlSeconds !== undefined
				? ttlSecondsToExpiresAt(blueprint.ttlSeconds)
				: null;
		const currentExpiresAt = branch.expiresAt ?? null;
		if (!expiresAtEqual(currentExpiresAt, desiredExpiresAt)) {
			plan.push({
				kind: "update-branch-ttl",
				projectId: remote.project.id,
				branchId: branch.id,
				branchName: branch.name,
				expiresAt: desiredExpiresAt,
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

function expiresAtEqual(a: string | null, b: string | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
	// Treat differences smaller than 5 seconds as equal so a pull-then-push cycle is idempotent.
	return Math.abs(ta - tb) < 5_000;
}

function ttlSecondsToExpiresAt(ttlSeconds: number): string {
	return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}
