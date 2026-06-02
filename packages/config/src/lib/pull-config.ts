import { createNeonApiFromOptions } from "./auth.js";
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
	/** Neon branch id (`br-…`). Required. Resolve names to ids before calling. */
	branchId: string;
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
	const project = await api.getProject(projectId);
	const [branches, endpoints] = await Promise.all([
		api.listBranches(projectId),
		api.listEndpoints(projectId),
	]);
	const branch = resolveBranch(options.branchId, branches);
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
	branchId: string,
	branches: NeonBranchSnapshot[],
): NeonBranchSnapshot {
	const match = branches.find((b) => b.id === branchId);
	if (match) return match;
	throw new PlatformError(
		ErrorCode.BranchNotFound,
		[
			`pullConfig: branch id ${JSON.stringify(branchId)} not found on project.`,
			`Available branches: ${branches.map((b) => `${b.name} (${b.id})`).join(", ") || "(none)"}.`,
		].join(" "),
		{
			details: {
				branchId,
				available: branches.map((b) => b.id),
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
