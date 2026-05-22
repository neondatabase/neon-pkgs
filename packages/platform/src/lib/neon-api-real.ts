import {
	type Branch,
	type BranchCreateRequest,
	type BranchCreateRequestEndpointOptions,
	type BranchUpdateRequest,
	createApiClient,
	type DefaultEndpointSettings,
	type Endpoint,
	EndpointType,
	type EndpointUpdateRequest,
	type PgVersion,
	type Project,
	type ProjectCreateRequest,
	type ProjectListItem,
	type ProjectUpdateRequest,
} from "@neondatabase/api-client";
import { PlatformError } from "./errors.js";
import type {
	CreateBranchInput,
	CreateProjectInput,
	NeonApi,
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
	UpdateBranchInput,
} from "./neon-api.js";
import type { ComputeSettings } from "./types.js";

type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Adapt `@neondatabase/api-client` to the narrow {@link NeonApi} façade used by the rest of
 * this package. Constructs are restricted to whole-object read/write of just the fields we
 * model in {@link Config}; anything else stays untouched on the remote.
 */
export function createRealNeonApi(options: {
	apiKey: string;
	baseUrl?: string;
}): NeonApi {
	if (!options.apiKey || options.apiKey.trim() === "") {
		throw new PlatformError(
			"PLATFORM_MISSING_API_KEY",
			"createRealNeonApi requires a non-empty `apiKey`.",
		);
	}

	const client = createApiClient({
		apiKey: options.apiKey,
		...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
	});

	return new RealNeonApi(client);
}

class RealNeonApi implements NeonApi {
	constructor(private readonly client: ApiClient) {}

	async listProjects(filter: {
		orgId?: string;
	}): Promise<NeonProjectSnapshot[]> {
		const projects: ProjectListItem[] = [];
		let cursor: string | undefined;
		while (true) {
			const res = await this.client.listProjects({
				...(filter.orgId ? { org_id: filter.orgId } : {}),
				...(cursor ? { cursor } : {}),
				limit: 100,
			});
			projects.push(...res.data.projects);
			const next = (res.data as { pagination?: { next?: string } })
				.pagination?.next;
			if (!next || next === cursor) break;
			cursor = next;
		}
		return projects.map(projectToSnapshot);
	}

	async getProject(projectId: string): Promise<NeonProjectSnapshot> {
		const res = await this.client.getProject(projectId);
		return projectToSnapshot(res.data.project);
	}

	async createProject(
		input: CreateProjectInput,
	): Promise<NeonProjectSnapshot> {
		const body: ProjectCreateRequest = {
			project: {
				name: input.name,
				region_id: input.regionId,
				...(input.pgVersion !== undefined
					? { pg_version: input.pgVersion as PgVersion }
					: {}),
				...(input.orgId ? { org_id: input.orgId } : {}),
				...(input.defaultEndpointSettings
					? {
							default_endpoint_settings:
								computeSettingsToDefaults(
									input.defaultEndpointSettings,
								),
						}
					: {}),
			},
		};
		const res = await this.client.createProject(body);
		return projectToSnapshot(res.data.project);
	}

	async updateProject(
		projectId: string,
		input: { name?: string; defaultEndpointSettings?: ComputeSettings },
	): Promise<NeonProjectSnapshot> {
		const body: ProjectUpdateRequest = {
			project: {
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.defaultEndpointSettings
					? {
							default_endpoint_settings:
								computeSettingsToDefaults(
									input.defaultEndpointSettings,
								),
						}
					: {}),
			},
		};
		const res = await this.client.updateProject(projectId, body);
		return projectToSnapshot(res.data.project);
	}

	async listBranches(projectId: string): Promise<NeonBranchSnapshot[]> {
		const branches: Branch[] = [];
		let cursor: string | undefined;
		while (true) {
			const res = await this.client.listProjectBranches({
				projectId,
				limit: 100,
				...(cursor ? { cursor } : {}),
			});
			branches.push(...(res.data.branches as Branch[]));
			const next = (res.data as { pagination?: { next?: string } })
				.pagination?.next;
			if (!next || next === cursor) break;
			cursor = next;
		}
		return branches.map(branchToSnapshot);
	}

	async createBranch(
		projectId: string,
		input: CreateBranchInput,
	): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}> {
		const endpointOptions: BranchCreateRequestEndpointOptions | undefined =
			input.computeSettings
				? {
						type: EndpointType.ReadWrite,
						...computeSettingsToEndpointOptions(
							input.computeSettings,
						),
					}
				: { type: EndpointType.ReadWrite };

		const body: BranchCreateRequest = {
			branch: {
				name: input.name,
				...(input.parentId ? { parent_id: input.parentId } : {}),
				...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
			},
			endpoints: [endpointOptions],
		};
		const res = await this.client.createProjectBranch(projectId, body);
		return {
			branch: branchToSnapshot(res.data.branch),
			endpoints: (res.data.endpoints ?? []).map(endpointToSnapshot),
		};
	}

	async updateBranch(
		projectId: string,
		branchId: string,
		input: UpdateBranchInput,
	): Promise<NeonBranchSnapshot> {
		const branch: BranchUpdateRequest["branch"] = {};
		if (input.name !== undefined) branch.name = input.name;
		if (input.expiresAt !== undefined) branch.expires_at = input.expiresAt;
		const res = await this.client.updateProjectBranch(projectId, branchId, {
			branch,
		});
		return branchToSnapshot(res.data.branch);
	}

	async listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]> {
		const res = await this.client.listProjectEndpoints(projectId);
		return (res.data.endpoints as Endpoint[]).map(endpointToSnapshot);
	}

	async updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot> {
		const endpoint: EndpointUpdateRequest["endpoint"] =
			computeSettingsToEndpointOptions(settings);
		const res = await this.client.updateProjectEndpoint(
			projectId,
			endpointId,
			{ endpoint },
		);
		return endpointToSnapshot(res.data.endpoint);
	}
}

function projectToSnapshot(
	project: Project | ProjectListItem,
): NeonProjectSnapshot {
	const defaults = project.default_endpoint_settings;
	const snapshot: NeonProjectSnapshot = {
		id: project.id,
		name: project.name,
		regionId: project.region_id,
		pgVersion: project.pg_version,
	};
	if (project.org_id) snapshot.orgId = project.org_id;
	if (defaults) {
		const compute = defaultsToComputeSettings(defaults);
		if (compute) snapshot.defaultEndpointSettings = compute;
	}
	return snapshot;
}

function branchToSnapshot(branch: Branch): NeonBranchSnapshot {
	const snapshot: NeonBranchSnapshot = {
		id: branch.id,
		name: branch.name,
		isDefault: branch.default,
	};
	if (branch.parent_id) snapshot.parentId = branch.parent_id;
	if (branch.expires_at) snapshot.expiresAt = branch.expires_at;
	return snapshot;
}

function endpointToSnapshot(endpoint: Endpoint): NeonEndpointSnapshot {
	return {
		id: endpoint.id,
		branchId: endpoint.branch_id,
		type:
			endpoint.type === EndpointType.ReadOnly
				? "read_only"
				: "read_write",
		autoscalingLimitMinCu: endpoint.autoscaling_limit_min_cu,
		autoscalingLimitMaxCu: endpoint.autoscaling_limit_max_cu,
		suspendTimeoutSeconds: endpoint.suspend_timeout_seconds,
	};
}

function computeSettingsToDefaults(
	settings: ComputeSettings,
): DefaultEndpointSettings {
	const out: DefaultEndpointSettings = {};
	if (settings.autoscalingLimitMinCu !== undefined)
		out.autoscaling_limit_min_cu = settings.autoscalingLimitMinCu;
	if (settings.autoscalingLimitMaxCu !== undefined)
		out.autoscaling_limit_max_cu = settings.autoscalingLimitMaxCu;
	if (settings.suspendTimeoutSeconds !== undefined)
		out.suspend_timeout_seconds = settings.suspendTimeoutSeconds;
	return out;
}

function computeSettingsToEndpointOptions(settings: ComputeSettings): {
	autoscaling_limit_min_cu?: number;
	autoscaling_limit_max_cu?: number;
	suspend_timeout_seconds?: number;
} {
	const out: {
		autoscaling_limit_min_cu?: number;
		autoscaling_limit_max_cu?: number;
		suspend_timeout_seconds?: number;
	} = {};
	if (settings.autoscalingLimitMinCu !== undefined)
		out.autoscaling_limit_min_cu = settings.autoscalingLimitMinCu;
	if (settings.autoscalingLimitMaxCu !== undefined)
		out.autoscaling_limit_max_cu = settings.autoscalingLimitMaxCu;
	if (settings.suspendTimeoutSeconds !== undefined)
		out.suspend_timeout_seconds = settings.suspendTimeoutSeconds;
	return out;
}

function defaultsToComputeSettings(
	defaults: DefaultEndpointSettings,
): ComputeSettings | undefined {
	const out: ComputeSettings = {};
	if (defaults.autoscaling_limit_min_cu !== undefined)
		out.autoscalingLimitMinCu = defaults.autoscaling_limit_min_cu;
	if (defaults.autoscaling_limit_max_cu !== undefined)
		out.autoscalingLimitMaxCu = defaults.autoscaling_limit_max_cu;
	if (defaults.suspend_timeout_seconds !== undefined)
		out.suspendTimeoutSeconds = defaults.suspend_timeout_seconds;
	return Object.keys(out).length > 0 ? out : undefined;
}
