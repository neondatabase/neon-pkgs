import { normalizeRegion } from "./define-config.js";
import type {
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import { isWildcardPattern, matchPattern } from "./patterns.js";
import type {
	ComputeSettings,
	ConflictReport,
	ResolvedBranchBlueprint,
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
			blueprintKey: string;
			branchName: string;
			parentBranchName: string;
			parentBranchId?: string;
			expiresAt?: string;
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
 * - Per the design, **specific-name** blueprints (no wildcard) always create-if-missing.
 *   Updating an existing branch's settings requires `updateExisting: true`.
 * - **Wildcard** blueprints never create. They only update existing matching branches when
 *   `applyExisting: true` is set; otherwise matching branches are reported under
 *   `skippedWildcardBranches`.
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

	for (const blueprint of config.branchBlueprints) {
		if (isWildcardPattern(blueprint.pattern)) {
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
			continue;
		}

		diffSpecificBlueprint({
			blueprint,
			branchesByName,
			endpointsByBranchId,
			config,
			remote,
			options,
			plan,
			conflicts,
		});
	}

	return { plan, conflicts, skippedWildcardBranches };
}

interface SpecificBlueprintArgs {
	blueprint: ResolvedBranchBlueprint;
	branchesByName: Map<string, NeonBranchSnapshot>;
	endpointsByBranchId: Map<string, NeonEndpointSnapshot>;
	config: ResolvedConfig;
	remote: RemoteState;
	options: DiffOptions;
	plan: PlanStep[];
	conflicts: ConflictReport[];
}

function diffSpecificBlueprint(args: SpecificBlueprintArgs): void {
	const {
		blueprint,
		branchesByName,
		endpointsByBranchId,
		config,
		remote,
		options,
		plan,
		conflicts,
	} = args;
	const branchName = blueprint.pattern;
	const existing = branchesByName.get(branchName);

	if (!existing) {
		// Create the branch (always allowed for specific-name blueprints).
		const parentName = resolveParentBranchName(blueprint, config);
		const parentBranch = parentName
			? branchesByName.get(parentName)
			: undefined;
		if (parentName && !parentBranch && parentName !== branchName) {
			// Parent isn't in this push (and isn't itself being created — we don't reorder ahead of time
			// in v1). Report as a conflict so the user fixes their config rather than silently failing
			// at apply time.
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
			blueprintKey: blueprint.key,
			branchName,
			parentBranchName:
				parentName ?? findDefaultBranchName(remote) ?? branchName,
		};
		if (parentBranch) step.parentBranchId = parentBranch.id;
		if (blueprint.ttlSeconds !== undefined)
			step.expiresAt = ttlSecondsToExpiresAt(blueprint.ttlSeconds);
		if (blueprint.computeSettings)
			step.computeSettings = blueprint.computeSettings;
		plan.push(step);
		return;
	}

	// Branch exists. Check for setting drifts.
	if (blueprint.computeSettings) {
		const endpoint = endpointsByBranchId.get(existing.id);
		if (!endpoint) {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "endpoint",
				current: undefined,
				desired: blueprint.computeSettings,
				reason: "Branch has no read-write endpoint; cannot apply compute settings.",
			});
		} else {
			const drift = computeDriftBetween(
				blueprint.computeSettings,
				endpoint,
			);
			if (drift) {
				if (options.updateExisting) {
					plan.push({
						kind: "update-endpoint",
						projectId: remote.project.id,
						branchName,
						endpointId: endpoint.id,
						settings: blueprint.computeSettings,
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

	// TTL drift.
	const desiredExpiresAt =
		blueprint.ttlSeconds !== undefined
			? ttlSecondsToExpiresAt(blueprint.ttlSeconds)
			: null;
	const currentExpiresAt = existing.expiresAt ?? null;
	if (!expiresAtEqual(currentExpiresAt, desiredExpiresAt)) {
		if (options.updateExisting) {
			plan.push({
				kind: "update-branch-ttl",
				projectId: remote.project.id,
				branchId: existing.id,
				branchName,
				expiresAt: desiredExpiresAt,
			});
		} else {
			conflicts.push({
				kind: "branch",
				identifier: branchName,
				field: "ttl",
				current: currentExpiresAt,
				desired: desiredExpiresAt,
				reason: "Existing branch has a different TTL. Pass `updateExisting: true` (SDK) or `--update-existing` (CLI) to apply.",
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

function resolveParentBranchName(
	blueprint: ResolvedBranchBlueprint,
	config: ResolvedConfig,
): string | undefined {
	const parent = blueprint.parent;
	if (!parent) return undefined;
	const resolved = config.branchBlueprints.find((b) => b.key === parent);
	if (resolved) return resolved.pattern;
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
		desired.suspendTimeoutSeconds !== undefined &&
		desired.suspendTimeoutSeconds !== endpoint.suspendTimeoutSeconds
	) {
		currentDrift.suspendTimeoutSeconds = endpoint.suspendTimeoutSeconds;
		desiredDrift.suspendTimeoutSeconds = desired.suspendTimeoutSeconds;
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
