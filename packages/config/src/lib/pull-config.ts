import { createNeonApiFromOptions } from "./auth.js";
import { type BranchRef, classifyBranchRef } from "./branch-ref.js";
import { ErrorCode, PlatformError } from "./errors.js";
import type {
	NeonApi,
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";
import type { BranchConfig, ComputeSettings } from "./types.js";

export interface PullConfigOptions {
	/** Neon project id (`<project>`). Required — the API addresses branches by project. */
	projectId: string;
	/** Branch selector: a Neon branch id (`br-…`) or a branch name. Required. */
	branch: string;
	/** Neon API key. Falls back to `NEON_API_KEY` / neonctl credentials. */
	apiKey?: string;
	/** Inject a custom NeonApi adapter (primarily for tests). */
	api?: NeonApi;
}

export interface PulledBranchConfig {
	project: {
		id: string;
		name: string;
		region: string;
		pgVersion: number;
		orgId?: string;
	};
	branch: {
		id: string;
		name: string;
		parent?: string;
		isDefault: boolean;
		protected: boolean;
		expiresAt?: string;
	};
	config: BranchConfig;
}

export async function pullConfig(
	options: PullConfigOptions,
): Promise<PulledBranchConfig> {
	const api = options.api ?? createApiFromOptions(options);
	const projectId = options.projectId;
	const branchRef = classifyBranchRef(options.branch);
	const project = await api.getProject(projectId);
	const [branches, endpoints] = await Promise.all([
		api.listBranches(projectId),
		api.listEndpoints(projectId),
	]);
	const branch = resolveBranch(branchRef, branches);
	const endpoint = endpoints.find(
		(ep) => ep.type === "read_write" && ep.branchId === branch.id,
	);
	return buildPulledBranchConfig(project, branch, branches, endpoint);
}

function createApiFromOptions(options: PullConfigOptions): NeonApi {
	return createNeonApiFromOptions("pullConfig", {
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
}

export function buildPulledBranchConfig(
	project: NeonProjectSnapshot,
	branch: NeonBranchSnapshot,
	branches: NeonBranchSnapshot[],
	endpoint: NeonEndpointSnapshot | undefined,
): PulledBranchConfig {
	const parent = branch.parentId
		? branches.find((b) => b.id === branch.parentId)
		: undefined;
	const config: BranchConfig = {};
	if (parent) config.parent = parent.name;
	if (branch.expiresAt) config.ttl = branch.expiresAt;
	if (branch.protected) config.protected = true;
	if (endpoint) {
		const compute = endpointToComputeSettings(endpoint, project);
		if (compute) config.postgres = { computeSettings: compute };
	}
	return {
		project: {
			id: project.id,
			name: project.name,
			region: project.regionId,
			pgVersion: project.pgVersion,
			...(project.orgId ? { orgId: project.orgId } : {}),
		},
		branch: {
			id: branch.id,
			name: branch.name,
			...(parent ? { parent: parent.name } : {}),
			isDefault: branch.isDefault,
			protected: branch.protected,
			...(branch.expiresAt ? { expiresAt: branch.expiresAt } : {}),
		},
		config,
	};
}

function resolveBranch(
	requested: BranchRef,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	const match =
		requested.kind === "id"
			? branches.find((b) => b.id === requested.value)
			: branches.find((b) => b.name === requested.value);
	if (match) return match;
	throw new PlatformError(
		ErrorCode.BranchNotFound,
		[
			`pullConfig: branch ${requested.kind}=${JSON.stringify(requested.value)} not found on project.`,
			`Available branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ") || "(none)"}.`,
		].join(" "),
		{
			details: {
				branch: requested,
				available: branches.map((b) => b.name),
			},
		},
	);
}

function endpointToComputeSettings(
	endpoint: NeonEndpointSnapshot,
	project: NeonProjectSnapshot,
): ComputeSettings | undefined {
	const defaults = project.defaultEndpointSettings;
	const out: ComputeSettings = {};
	if (
		endpoint.autoscalingLimitMinCu !== undefined &&
		endpoint.autoscalingLimitMinCu !== defaults?.autoscalingLimitMinCu
	) {
		out.autoscalingLimitMinCu = endpoint.autoscalingLimitMinCu;
	}
	if (
		endpoint.autoscalingLimitMaxCu !== undefined &&
		endpoint.autoscalingLimitMaxCu !== defaults?.autoscalingLimitMaxCu
	) {
		out.autoscalingLimitMaxCu = endpoint.autoscalingLimitMaxCu;
	}
	if (
		endpoint.suspendTimeout !== undefined &&
		endpoint.suspendTimeout !== defaults?.suspendTimeout
	) {
		out.suspendTimeout = endpoint.suspendTimeout;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
