import type {
	CreateBranchInput,
	CreateBucketInput,
	CreateCredentialInput,
	CreateProjectInput,
	DeployFunctionInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBucketSnapshot,
	NeonCredentialMeta,
	NeonCredentialSecret,
	NeonDataApiSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionDeploymentSnapshot,
	NeonFunctionSnapshot,
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
	/** Preview buckets, keyed by `${projectId}:${branchId}`. */
	private readonly buckets = new Map<string, NeonBucketSnapshot[]>();
	/** Preview functions, keyed by `${projectId}:${branchId}`. */
	private readonly functions = new Map<string, NeonFunctionSnapshot[]>();
	/** Monotonic per-function deployment counter, keyed by `${projectId}:${branchId}:${slug}`. */
	private readonly functionDeployments = new Map<string, number>();
	/** AI Gateway enabled set, keyed by `${projectId}:${branchId}`. */
	private readonly aiGateway = new Set<string>();
	/** Issued credentials (incl. secrets), keyed by `${projectId}:${branchId}`. */
	private readonly credentials = new Map<
		string,
		Array<
			NeonCredentialMeta & { apiToken: string; s3SecretAccessKey: string }
		>
	>();
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
		return found ? clone(publicNeonAuthSnapshot(found)) : null;
	}

	async enableNeonAuth(
		projectId: string,
		branchId: string,
		input: { databaseName?: string } = {},
	): Promise<NeonAuthSnapshot> {
		this.history.push({
			method: "enableNeonAuth",
			args: [projectId, branchId, input],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}`;
		const existing = this.neonAuth.get(key);
		if (existing) return clone(publicNeonAuthSnapshot(existing));
		const snapshot: NeonAuthSnapshot = {
			projectId: `auth-${branchId}`,
			publishableClientKey: `pub-${branchId}`,
			secretServerKey: `secret-${branchId}`,
			jwksUrl: `https://api.fake.neon.tech/auth/${projectId}/${branchId}/.well-known/jwks.json`,
			baseUrl: `https://api.fake.neon.tech/auth/${projectId}/${branchId}`,
		};
		this.neonAuth.set(key, snapshot);
		return clone(snapshot);
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

	async enableProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot> {
		this.history.push({
			method: "enableProjectBranchDataApi",
			args: [projectId, branchId, databaseName],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}:${databaseName}`;
		const existing = this.neonDataApi.get(key);
		if (existing) return clone(existing);
		const snapshot: NeonDataApiSnapshot = {
			url: `https://${branchId}.fake.neon.tech/data-api/${databaseName}`,
		};
		this.neonDataApi.set(key, snapshot);
		return clone(snapshot);
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

	// ─── Preview: buckets ──────────────────────────────────────────────────────

	async listBranchBuckets(
		projectId: string,
		branchId: string,
	): Promise<NeonBucketSnapshot[]> {
		this.history.push({
			method: "listBranchBuckets",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		return (this.buckets.get(`${projectId}:${branchId}`) ?? []).map(clone);
	}

	async createBranchBucket(
		projectId: string,
		branchId: string,
		input: CreateBucketInput,
	): Promise<NeonBucketSnapshot> {
		this.history.push({
			method: "createBranchBucket",
			args: [projectId, branchId, input],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}`;
		const list = this.buckets.get(key) ?? [];
		if (list.some((b) => b.name === input.name)) {
			throw new Error(
				`Fake Neon: bucket '${input.name}' already exists on branch ${branchId}`,
			);
		}
		const snapshot: NeonBucketSnapshot = {
			name: input.name,
			accessLevel: input.accessLevel ?? "private",
		};
		list.push(snapshot);
		this.buckets.set(key, list);
		return clone(snapshot);
	}

	async deleteBranchBucket(
		projectId: string,
		branchId: string,
		bucketName: string,
	): Promise<void> {
		this.history.push({
			method: "deleteBranchBucket",
			args: [projectId, branchId, bucketName],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}`;
		const list = this.buckets.get(key) ?? [];
		this.buckets.set(
			key,
			list.filter((b) => b.name !== bucketName),
		);
	}

	// ─── Preview: functions ────────────────────────────────────────────────────

	async listBranchFunctions(
		projectId: string,
		branchId: string,
	): Promise<NeonFunctionSnapshot[]> {
		this.history.push({
			method: "listBranchFunctions",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		return (this.functions.get(`${projectId}:${branchId}`) ?? []).map(
			clone,
		);
	}

	async createBranchFunction(
		projectId: string,
		branchId: string,
		input: { slug: string; name: string },
	): Promise<NeonFunctionSnapshot> {
		this.history.push({
			method: "createBranchFunction",
			args: [projectId, branchId, input],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}`;
		const list = this.functions.get(key) ?? [];
		if (list.some((f) => f.slug === input.slug)) {
			throw new Error(
				`Fake Neon: function '${input.slug}' already exists on branch ${branchId}`,
			);
		}
		const snapshot: NeonFunctionSnapshot = {
			id: this.allocateId("fn"),
			slug: input.slug,
			name: input.name,
			invocationUrl: `https://${branchId}.fake.neon.tech/functions/${input.slug}`,
		};
		list.push(snapshot);
		this.functions.set(key, list);
		return clone(snapshot);
	}

	async deleteBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
	): Promise<void> {
		this.history.push({
			method: "deleteBranchFunction",
			args: [projectId, branchId, slug],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}`;
		const list = this.functions.get(key) ?? [];
		this.functions.set(
			key,
			list.filter((f) => f.slug !== slug),
		);
	}

	async deployBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
		input: DeployFunctionInput,
	): Promise<NeonFunctionDeploymentSnapshot> {
		this.history.push({
			method: "deployBranchFunction",
			args: [projectId, branchId, slug, input],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const key = `${projectId}:${branchId}`;
		const list = this.functions.get(key) ?? [];
		const fn = list.find((f) => f.slug === slug);
		if (!fn) {
			throw new Error(
				`Fake Neon: function '${slug}' not found on branch ${branchId}`,
			);
		}
		const deployKey = `${projectId}:${branchId}:${slug}`;
		const id = (this.functionDeployments.get(deployKey) ?? 0) + 1;
		this.functionDeployments.set(deployKey, id);
		fn.activeDeploymentId = id;
		return { id, status: "completed" };
	}

	// ─── Preview: AI Gateway ───────────────────────────────────────────────────

	async getAiGatewayEnabled(
		projectId: string,
		branchId: string,
	): Promise<boolean> {
		this.history.push({
			method: "getAiGatewayEnabled",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		return this.aiGateway.has(`${projectId}:${branchId}`);
	}

	async enableAiGateway(projectId: string, branchId: string): Promise<void> {
		this.history.push({
			method: "enableAiGateway",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		this.aiGateway.add(`${projectId}:${branchId}`);
	}

	async disableAiGateway(projectId: string, branchId: string): Promise<void> {
		this.history.push({
			method: "disableAiGateway",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		this.aiGateway.delete(`${projectId}:${branchId}`);
	}

	// ─── Preview: branch-scoped credentials ──────────────────────────────────

	async createCredential(
		projectId: string,
		branchId: string,
		input: CreateCredentialInput,
	): Promise<NeonCredentialSecret> {
		this.history.push({
			method: "createCredential",
			args: [projectId, branchId, input],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const seq = this.nextId.toString(16).padStart(12, "0");
		this.nextId += 1;
		const tokenIdShort = `c${seq}`.slice(0, 12);
		const tokenId = `${tokenIdShort}-fake-fake-fake-${seq}`;
		const apiToken = `nt_live_${tokenIdShort}_${seq}secret`;
		const s3SecretAccessKey = `s3secret${seq}`.padEnd(64, "0");
		const key = `${projectId}:${branchId}`;
		const list = this.credentials.get(key) ?? [];
		list.push({
			tokenId,
			tokenIdShort,
			...(input.name !== undefined ? { name: input.name } : {}),
			scopes: [...input.scopes],
			principalType: input.principalType,
			...(input.functionId !== undefined
				? { functionId: input.functionId }
				: {}),
			branchId,
			createdAt: "2026-01-01T00:00:00Z",
			apiToken,
			s3SecretAccessKey,
		});
		this.credentials.set(key, list);
		const secret: NeonCredentialSecret = {
			tokenId,
			tokenIdShort,
			...(input.name !== undefined ? { name: input.name } : {}),
			apiToken,
			s3SecretAccessKey,
			scopes: [...input.scopes],
			branchId,
			createdAt: "2026-01-01T00:00:00Z",
		};
		return clone(secret);
	}

	async listCredentials(
		projectId: string,
		branchId: string,
	): Promise<NeonCredentialMeta[]> {
		this.history.push({
			method: "listCredentials",
			args: [projectId, branchId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const list = this.credentials.get(`${projectId}:${branchId}`) ?? [];
		return list
			.filter((c) => c.revokedAt === undefined)
			.map(({ apiToken: _a, s3SecretAccessKey: _s, ...meta }) =>
				clone(meta),
			);
	}

	async revokeCredential(
		projectId: string,
		branchId: string,
		tokenId: string,
	): Promise<void> {
		this.history.push({
			method: "revokeCredential",
			args: [projectId, branchId, tokenId],
		});
		this.requireProject(projectId);
		this.requireBranch(projectId, branchId);
		const list = this.credentials.get(`${projectId}:${branchId}`) ?? [];
		for (const cred of list) {
			if (cred.tokenId === tokenId && cred.revokedAt === undefined) {
				cred.revokedAt = "2026-01-02T00:00:00Z";
			}
		}
	}

	/** Test helper: attach a bucket to a branch. */
	seedBucket(
		projectId: string,
		branchId: string,
		snapshot: NeonBucketSnapshot,
	): void {
		const key = `${projectId}:${branchId}`;
		const list = this.buckets.get(key) ?? [];
		list.push({ ...snapshot });
		this.buckets.set(key, list);
	}

	/** Test helper: attach a function to a branch. */
	seedFunction(
		projectId: string,
		branchId: string,
		snapshot: NeonFunctionSnapshot,
	): void {
		const key = `${projectId}:${branchId}`;
		const list = this.functions.get(key) ?? [];
		list.push({ ...snapshot });
		this.functions.set(key, list);
	}

	/** Test helper: mark the AI Gateway enabled on a branch. */
	seedAiGateway(projectId: string, branchId: string): void {
		this.aiGateway.add(`${projectId}:${branchId}`);
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

function publicNeonAuthSnapshot(snapshot: NeonAuthSnapshot): NeonAuthSnapshot {
	const publicSnapshot: NeonAuthSnapshot = {
		projectId: snapshot.projectId,
		jwksUrl: snapshot.jwksUrl,
	};
	if (snapshot.baseUrl) publicSnapshot.baseUrl = snapshot.baseUrl;
	return publicSnapshot;
}
