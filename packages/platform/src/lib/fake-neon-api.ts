import type {
	CreateBranchInput,
	CreateProjectInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonDataApiSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
	UpdateBranchInput,
} from "./neon-api.js";
import type { ComputeSettings } from "./types.js";

/**
 * Test-only branch seed shape. Permits omitting `protected` (defaults to `false`) so the
 * many tests that pre-date the field don't have to spell it out on every entry.
 */
type SeedBranch = Omit<NeonBranchSnapshot, "protected"> & {
	protected?: boolean;
};

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
	private readonly roles = new Map<string, NeonRoleSnapshot[]>();
	private readonly databases = new Map<string, NeonDatabaseSnapshot[]>();
	/** Keyed by `${projectId}:${branchId}` so a project can have per-branch integrations. */
	private readonly neonAuth = new Map<string, NeonAuthSnapshot>();
	/** Keyed by `${projectId}:${branchId}:${databaseName}`. */
	private readonly neonDataApi = new Map<string, NeonDataApiSnapshot>();
	readonly history: Array<{ method: string; args: unknown[] }> = [];

	/**
	 * Seed the fake with a fully-formed project (and optionally extra branches), bypassing
	 * the public mutation API. Used by tests that want to assert on diff/update behaviour
	 * without first calling `createProject`.
	 *
	 * Each branch is seeded with a default `neondb_owner` role and `neondb` database unless
	 * overridden — matching what Neon's real `createProject` does. Pass `roles` / `databases`
	 * on a branch entry to model non-default setups (custom roles, multiple databases).
	 */
	seedProject(input: {
		project: NeonProjectSnapshot;
		branches?: Array<{
			branch: SeedBranch;
			endpoint?: Partial<NeonEndpointSnapshot>;
			roles?: Array<Partial<NeonRoleSnapshot> & { name: string }>;
			databases?: Array<Partial<NeonDatabaseSnapshot> & { name: string }>;
		}>;
	}): void {
		const project = { ...input.project };
		this.projects.set(project.id, project);
		const branches: NeonBranchSnapshot[] = [];
		const endpoints: NeonEndpointSnapshot[] = [];

		for (const entry of input.branches ?? []) {
			branches.push({ protected: false, ...entry.branch });
			endpoints.push(
				this.makeEndpoint(entry.branch.id, entry.endpoint, project),
			);
			this.seedBranchAuth(entry.branch.id, entry.roles, entry.databases);
		}

		if (branches.length === 0) {
			// Auto-create a default `production` branch so tests can rely on it existing.
			const defaultBranch: NeonBranchSnapshot = {
				id: this.allocateId("br"),
				name: "production",
				isDefault: true,
				protected: false,
			};
			branches.push(defaultBranch);
			endpoints.push(
				this.makeEndpoint(defaultBranch.id, undefined, project),
			);
			this.seedBranchAuth(defaultBranch.id);
		}

		this.branches.set(project.id, branches);
		this.endpoints.set(project.id, endpoints);
	}

	private seedBranchAuth(
		branchId: string,
		roles?: Array<Partial<NeonRoleSnapshot> & { name: string }>,
		databases?: Array<Partial<NeonDatabaseSnapshot> & { name: string }>,
	): void {
		const resolvedRoles: NeonRoleSnapshot[] = (
			roles ?? [{ name: "neondb_owner" }]
		).map((r) => ({
			name: r.name,
			branchId,
			protected: r.protected ?? false,
		}));
		this.roles.set(branchId, resolvedRoles);

		const resolvedDatabases: NeonDatabaseSnapshot[] = (
			databases ?? [{ name: "neondb" }]
		).map((d) => ({
			name: d.name,
			branchId,
			ownerName: d.ownerName ?? resolvedRoles[0]?.name ?? "neondb_owner",
		}));
		this.databases.set(branchId, resolvedDatabases);
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
			protected: false,
		};
		const defaultEndpoint = this.makeEndpoint(
			defaultBranch.id,
			undefined,
			project,
		);
		this.branches.set(id, [defaultBranch]);
		this.endpoints.set(id, [defaultEndpoint]);
		this.seedBranchAuth(defaultBranch.id);

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
			protected: input.protected === true,
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

		// Inherit the roles/databases from the parent branch — Neon does the same
		// (every branch starts as a copy-on-write clone of its parent).
		const parentRoles =
			(branch.parentId ? this.roles.get(branch.parentId) : undefined) ??
			[];
		const parentDatabases =
			(branch.parentId
				? this.databases.get(branch.parentId)
				: undefined) ?? [];
		this.seedBranchAuth(
			branch.id,
			parentRoles.length > 0 ? parentRoles : undefined,
			parentDatabases.length > 0 ? parentDatabases : undefined,
		);

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
		if (input.protected !== undefined) updated.protected = input.protected;
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
		if (settings.suspendTimeout !== undefined)
			updated.suspendTimeout = settings.suspendTimeout;
		endpoints[idx] = updated;
		return clone(updated);
	}

	async listBranchRoles(
		projectId: string,
		branchId: string,
	): Promise<NeonRoleSnapshot[]> {
		this.history.push({
			method: "listBranchRoles",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		return (this.roles.get(branchId) ?? []).map(clone);
	}

	async listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<NeonDatabaseSnapshot[]> {
		this.history.push({
			method: "listBranchDatabases",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		return (this.databases.get(branchId) ?? []).map(clone);
	}

	async getConnectionUri(
		projectId: string,
		input: GetConnectionUriInput,
	): Promise<{ uri: string }> {
		this.history.push({
			method: "getConnectionUri",
			args: [projectId, input],
		});
		this.requireProject(projectId);

		const branchId = input.branchId ?? this.defaultBranchId(projectId);
		if (!branchId) {
			throw new Error(
				`Fake Neon: project ${projectId} has no default branch`,
			);
		}
		this.requireBranch(projectId, branchId);

		const roles = this.roles.get(branchId) ?? [];
		if (!roles.some((r) => r.name === input.roleName)) {
			throw new Error(
				`Fake Neon: role '${input.roleName}' not found on branch ${branchId}`,
			);
		}
		const databases = this.databases.get(branchId) ?? [];
		if (!databases.some((d) => d.name === input.databaseName)) {
			throw new Error(
				`Fake Neon: database '${input.databaseName}' not found on branch ${branchId}`,
			);
		}

		const project = this.projects.get(projectId);
		const region = project?.regionId ?? "aws-us-east-1";
		const hostPart = input.pooled
			? `${branchId}-pooler.${region}.fake.neon.tech`
			: `${branchId}.${region}.fake.neon.tech`;
		const uri = `postgresql://${input.roleName}:fake-password-for-${branchId}@${hostPart}/${input.databaseName}?sslmode=require`;
		return { uri };
	}

	async getNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot | null> {
		this.history.push({
			method: "getNeonAuth",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const found = this.neonAuth.get(`${projectId}:${branchId}`);
		return found ? clone(found) : null;
	}

	async getNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot | null> {
		this.history.push({
			method: "getNeonDataApi",
			args: [projectId, branchId, databaseName],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const found = this.neonDataApi.get(
			`${projectId}:${branchId}:${databaseName}`,
		);
		return found ? clone(found) : null;
	}

	/** Test helper: attach a Neon Auth integration to a branch. */
	seedNeonAuth(
		projectId: string,
		branchId: string,
		snapshot: NeonAuthSnapshot,
	): void {
		this.neonAuth.set(`${projectId}:${branchId}`, { ...snapshot });
	}

	/** Test helper: attach a Neon Data API integration to a branch + database. */
	seedNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		snapshot: NeonDataApiSnapshot,
	): void {
		this.neonDataApi.set(`${projectId}:${branchId}:${databaseName}`, {
			...snapshot,
		});
	}

	private requireProject(projectId: string): void {
		if (!this.projects.has(projectId))
			throw new Error(`Fake Neon: project ${projectId} not found`);
	}

	private requireBranch(projectId: string, branchId: string): void {
		const branchList = this.branches.get(projectId) ?? [];
		if (!branchList.some((b) => b.id === branchId)) {
			throw new Error(
				`Fake Neon: branch ${branchId} not found in project ${projectId}`,
			);
		}
	}

	private defaultBranchId(projectId: string): string | undefined {
		const branchList = this.branches.get(projectId) ?? [];
		return (branchList.find((b) => b.isDefault) ?? branchList[0])?.id;
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
			suspendTimeout:
				override?.suspendTimeout ??
				projectDefaults?.suspendTimeout ??
				undefined,
		};
	}
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
