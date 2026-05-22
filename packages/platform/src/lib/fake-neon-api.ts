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

/**
 * In-memory NeonApi implementation used by tests. **Not** exported from `dist/`.
 *
 * Models the subset of Neon's data model that {@link Config} actually exercises:
 *
 * - Each project has a single read-write endpoint per branch (Neon's default), an `orgId`
 *   on the project, default endpoint settings, and a fixed region.
 * - Branches inherit endpoint defaults from the project when no explicit settings are set
 *   at create-time. This mirrors the real Neon platform.
 *
 * The fake records a call log (`history`) so tests can assert on the exact sequence of API
 * operations that `pushConfig` performs.
 */
export class FakeNeonApi implements NeonApi {
	private nextId = 1;
	private readonly projects = new Map<string, NeonProjectSnapshot>();
	private readonly branches = new Map<string, NeonBranchSnapshot[]>();
	private readonly endpoints = new Map<string, NeonEndpointSnapshot[]>();
	readonly history: Array<{ method: string; args: unknown[] }> = [];

	/**
	 * Seed the fake with a fully-formed project (and optionally extra branches), bypassing
	 * the public mutation API. Used by tests that want to assert on diff/update behaviour
	 * without first calling `createProject`.
	 */
	seedProject(input: {
		project: NeonProjectSnapshot;
		branches?: Array<{
			branch: NeonBranchSnapshot;
			endpoint?: Partial<NeonEndpointSnapshot>;
		}>;
	}): void {
		const project = { ...input.project };
		this.projects.set(project.id, project);
		const branches: NeonBranchSnapshot[] = [];
		const endpoints: NeonEndpointSnapshot[] = [];

		for (const entry of input.branches ?? []) {
			branches.push({ ...entry.branch });
			endpoints.push(
				this.makeEndpoint(entry.branch.id, entry.endpoint, project),
			);
		}

		if (branches.length === 0) {
			// Auto-create a default `production` branch so tests can rely on it existing.
			const defaultBranch: NeonBranchSnapshot = {
				id: this.allocateId("br"),
				name: "production",
				isDefault: true,
			};
			branches.push(defaultBranch);
			endpoints.push(
				this.makeEndpoint(defaultBranch.id, undefined, project),
			);
		}

		this.branches.set(project.id, branches);
		this.endpoints.set(project.id, endpoints);
	}

	async listProjects(filter: {
		orgId?: string;
	}): Promise<NeonProjectSnapshot[]> {
		this.history.push({ method: "listProjects", args: [filter] });
		const all = Array.from(this.projects.values());
		if (filter.orgId !== undefined) {
			return all.filter((p) => p.orgId === filter.orgId).map(clone);
		}
		return all.map(clone);
	}

	async getProject(projectId: string): Promise<NeonProjectSnapshot> {
		this.history.push({ method: "getProject", args: [projectId] });
		const found = this.projects.get(projectId);
		if (!found)
			throw new Error(`Fake Neon: project ${projectId} not found`);
		return clone(found);
	}

	async createProject(
		input: CreateProjectInput,
	): Promise<NeonProjectSnapshot> {
		this.history.push({ method: "createProject", args: [input] });
		const id = this.allocateId("proj");
		const project: NeonProjectSnapshot = {
			id,
			name: input.name,
			regionId: input.regionId,
			pgVersion: input.pgVersion ?? 17,
		};
		if (input.orgId) project.orgId = input.orgId;
		if (input.defaultEndpointSettings)
			project.defaultEndpointSettings = {
				...input.defaultEndpointSettings,
			};
		this.projects.set(id, project);

		const defaultBranch: NeonBranchSnapshot = {
			id: this.allocateId("br"),
			name: input.defaultBranchName ?? "main",
			isDefault: true,
		};
		const defaultEndpoint = this.makeEndpoint(
			defaultBranch.id,
			undefined,
			project,
		);
		this.branches.set(id, [defaultBranch]);
		this.endpoints.set(id, [defaultEndpoint]);

		return clone(project);
	}

	async updateProject(
		projectId: string,
		input: { name?: string; defaultEndpointSettings?: ComputeSettings },
	): Promise<NeonProjectSnapshot> {
		this.history.push({
			method: "updateProject",
			args: [projectId, input],
		});
		const existing = this.projects.get(projectId);
		if (!existing)
			throw new Error(`Fake Neon: project ${projectId} not found`);
		const updated: NeonProjectSnapshot = { ...existing };
		if (input.name !== undefined) updated.name = input.name;
		if (input.defaultEndpointSettings)
			updated.defaultEndpointSettings = {
				...input.defaultEndpointSettings,
			};
		this.projects.set(projectId, updated);
		return clone(updated);
	}

	async listBranches(projectId: string): Promise<NeonBranchSnapshot[]> {
		this.history.push({ method: "listBranches", args: [projectId] });
		return (this.branches.get(projectId) ?? []).map(clone);
	}

	async createBranch(
		projectId: string,
		input: CreateBranchInput,
	): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}> {
		this.history.push({ method: "createBranch", args: [projectId, input] });
		const project = this.projects.get(projectId);
		if (!project)
			throw new Error(`Fake Neon: project ${projectId} not found`);
		const branchList = this.branches.get(projectId) ?? [];

		if (branchList.some((b) => b.name === input.name)) {
			throw new Error(
				`Fake Neon: branch '${input.name}' already exists in project ${projectId}`,
			);
		}

		const branch: NeonBranchSnapshot = {
			id: this.allocateId("br"),
			name: input.name,
			isDefault: false,
		};
		if (input.parentId) branch.parentId = input.parentId;
		else if (branchList[0])
			branch.parentId =
				branchList.find((b) => b.isDefault)?.id ?? branchList[0].id;
		if (input.expiresAt) branch.expiresAt = input.expiresAt;

		branchList.push(branch);
		this.branches.set(projectId, branchList);

		const endpointSettings =
			input.computeSettings ?? project.defaultEndpointSettings;
		const endpoint = this.makeEndpoint(
			branch.id,
			endpointSettings,
			project,
		);
		const endpoints = this.endpoints.get(projectId) ?? [];
		endpoints.push(endpoint);
		this.endpoints.set(projectId, endpoints);

		return { branch: clone(branch), endpoints: [clone(endpoint)] };
	}

	async updateBranch(
		projectId: string,
		branchId: string,
		input: UpdateBranchInput,
	): Promise<NeonBranchSnapshot> {
		this.history.push({
			method: "updateBranch",
			args: [projectId, branchId, input],
		});
		const branchList = this.branches.get(projectId);
		if (!branchList)
			throw new Error(`Fake Neon: project ${projectId} not found`);
		const idx = branchList.findIndex((b) => b.id === branchId);
		if (idx === -1)
			throw new Error(`Fake Neon: branch ${branchId} not found`);
		const current = branchList[idx];
		const updated: NeonBranchSnapshot = { ...current };
		if (input.name !== undefined) updated.name = input.name;
		if (input.expiresAt === null) delete updated.expiresAt;
		else if (input.expiresAt !== undefined)
			updated.expiresAt = input.expiresAt;
		branchList[idx] = updated;
		return clone(updated);
	}

	async listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]> {
		this.history.push({ method: "listEndpoints", args: [projectId] });
		return (this.endpoints.get(projectId) ?? []).map(clone);
	}

	async updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot> {
		this.history.push({
			method: "updateEndpoint",
			args: [projectId, endpointId, settings],
		});
		const endpoints = this.endpoints.get(projectId);
		if (!endpoints)
			throw new Error(`Fake Neon: project ${projectId} not found`);
		const idx = endpoints.findIndex((e) => e.id === endpointId);
		if (idx === -1)
			throw new Error(`Fake Neon: endpoint ${endpointId} not found`);
		const updated: NeonEndpointSnapshot = { ...endpoints[idx] };
		if (settings.autoscalingLimitMinCu !== undefined)
			updated.autoscalingLimitMinCu = settings.autoscalingLimitMinCu;
		if (settings.autoscalingLimitMaxCu !== undefined)
			updated.autoscalingLimitMaxCu = settings.autoscalingLimitMaxCu;
		if (settings.suspendTimeoutSeconds !== undefined)
			updated.suspendTimeoutSeconds = settings.suspendTimeoutSeconds;
		endpoints[idx] = updated;
		return clone(updated);
	}

	private allocateId(prefix: string): string {
		const id = `${prefix}-fake-${this.nextId.toString(36)}`;
		this.nextId += 1;
		return id;
	}

	private makeEndpoint(
		branchId: string,
		override: Partial<NeonEndpointSnapshot> | undefined,
		project: NeonProjectSnapshot,
	): NeonEndpointSnapshot {
		const projectDefaults = project.defaultEndpointSettings;
		return {
			id: override?.id ?? this.allocateId("ep"),
			branchId,
			type: override?.type ?? "read_write",
			autoscalingLimitMinCu:
				override?.autoscalingLimitMinCu ??
				projectDefaults?.autoscalingLimitMinCu ??
				0.25,
			autoscalingLimitMaxCu:
				override?.autoscalingLimitMaxCu ??
				projectDefaults?.autoscalingLimitMaxCu ??
				0.25,
			suspendTimeoutSeconds:
				override?.suspendTimeoutSeconds ??
				projectDefaults?.suspendTimeoutSeconds ??
				0,
		};
	}
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
