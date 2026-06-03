import {
	type BranchConfig,
	type BucketConfig,
	type ComputeSettings,
	createNeonApiFromOptions,
	ErrorCode,
	type NeonApi,
	type NeonBranchSnapshot,
	type NeonBucketSnapshot,
	type NeonEndpointSnapshot,
	type NeonFunctionSnapshot,
	type NeonProjectSnapshot,
	PlatformError,
} from "@neondatabase/config";

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

/**
 * Live Preview-feature state read back from a branch. Surfaced alongside `config` rather
 * than inside it because functions cannot round-trip: the remote only knows the deployed
 * bundle, not the local `source` path a {@link FunctionConfig} requires, so a pulled
 * function is reported as `{ slug, name }` (no `source`).
 */
export interface PulledPreview {
	buckets: BucketConfig[];
	functions: Array<{ slug: string; name: string }>;
	aiGatewayEnabled: boolean;
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
	/**
	 * Live Preview-feature state, when the branch has any buckets/functions or an enabled
	 * AI Gateway. Omitted entirely when there is nothing to report.
	 */
	preview?: PulledPreview;
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
	const [buckets, functions, aiGatewayEnabled] = await Promise.all([
		api.listBranchBuckets(projectId, branch.id),
		api.listBranchFunctions(projectId, branch.id),
		api.getAiGatewayEnabled(projectId, branch.id),
	]);
	return buildPulledBranchConfig(project, branch, branches, endpoint, {
		buckets,
		functions,
		aiGatewayEnabled,
	});
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
	previewState?: {
		buckets: NeonBucketSnapshot[];
		functions: NeonFunctionSnapshot[];
		aiGatewayEnabled: boolean;
	},
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
	const result: PulledBranchConfig = {
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
	const preview = previewState ? buildPulledPreview(previewState) : undefined;
	if (preview) result.preview = preview;
	return result;
}

/**
 * Reverse-engineer the {@link PulledPreview} from remote snapshots. Returns `undefined` when
 * the branch has no Preview features so the field can be omitted entirely.
 */
function buildPulledPreview(state: {
	buckets: NeonBucketSnapshot[];
	functions: NeonFunctionSnapshot[];
	aiGatewayEnabled: boolean;
}): PulledPreview | undefined {
	if (
		state.buckets.length === 0 &&
		state.functions.length === 0 &&
		!state.aiGatewayEnabled
	) {
		return undefined;
	}
	return {
		buckets: state.buckets.map((b) => ({
			name: b.name,
			access: b.accessLevel,
		})),
		functions: state.functions.map((f) => ({
			slug: f.slug,
			name: f.name,
		})),
		aiGatewayEnabled: state.aiGatewayEnabled,
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
