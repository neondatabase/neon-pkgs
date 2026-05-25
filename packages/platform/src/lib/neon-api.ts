import type { ComputeSettings } from "./types.js";

/**
 * Snapshot of a Neon project field set we care about. Maps onto a subset of the upstream
 * `@neondatabase/api-client` `Project` type. We do **not** widen this to the full upstream
 * shape — keeping the surface narrow makes the in-memory fake practical to maintain.
 */
export interface NeonProjectSnapshot {
	id: string;
	name: string;
	regionId: string;
	pgVersion: number;
	orgId?: string;
	defaultEndpointSettings?: ComputeSettings;
}

export interface NeonBranchSnapshot {
	id: string;
	name: string;
	parentId?: string;
	isDefault: boolean;
	/** Whether the branch is marked protected on Neon. */
	protected: boolean;
	expiresAt?: string;
}

export interface NeonEndpointSnapshot {
	id: string;
	branchId: string;
	type: "read_only" | "read_write";
	autoscalingLimitMinCu: ComputeSettings["autoscalingLimitMinCu"];
	autoscalingLimitMaxCu: ComputeSettings["autoscalingLimitMaxCu"];
	suspendTimeout: ComputeSettings["suspendTimeout"];
}

export interface CreateProjectInput {
	name: string;
	regionId: string;
	pgVersion?: number;
	orgId?: string;
	defaultEndpointSettings?: ComputeSettings;
	/**
	 * Optional name for the project's auto-created default branch. When omitted, Neon
	 * uses its own default (`main`).
	 */
	defaultBranchName?: string;
}

export interface CreateBranchInput {
	name: string;
	parentId?: string;
	expiresAt?: string;
	/** When `true`, the branch is created with the `protected` flag set on Neon. */
	protected?: boolean;
	computeSettings?: ComputeSettings;
}

export interface UpdateBranchInput {
	name?: string;
	expiresAt?: string | null;
	/** When set, toggles the branch's `protected` flag on Neon. */
	protected?: boolean;
}

/**
 * A role on a Neon branch (e.g. `neondb_owner`). Passwords are never returned by
 * {@link NeonApi.listBranchRoles}; use {@link NeonApi.getConnectionUri} to fetch a URI
 * with the role's password baked in.
 */
export interface NeonRoleSnapshot {
	name: string;
	branchId: string;
	/** Whether the role is system-protected (cannot be deleted). */
	protected: boolean;
}

/**
 * A database on a Neon branch (e.g. `neondb`).
 */
export interface NeonDatabaseSnapshot {
	name: string;
	branchId: string;
	/** The role that owns the database (one role can own multiple databases). */
	ownerName: string;
}

/**
 * Public, fetchable bits of a Neon Auth integration. The secrets (`pub_client_key`,
 * `secret_server_key`) are intentionally absent here — the Neon API only returns those
 * at create / rotate time, never on `GET /auth`, so `fetchEnv` reads them from
 * `process.env` instead of trying to refetch.
 */
export interface NeonAuthSnapshot {
	/** The Neon Auth project id (`auth_provider_project_id` on the Neon API). */
	projectId: string;
	/** JWKS URL for verifying tokens issued by Neon Auth. */
	jwksUrl: string;
	/** Optional base URL of the Neon Auth deployment. */
	baseUrl?: string;
}

/**
 * Public, fetchable bits of a Neon Data API integration on a specific branch.
 */
export interface NeonDataApiSnapshot {
	/** REST endpoint URL. */
	url: string;
}

/**
 * Parameters accepted by {@link NeonApi.getConnectionUri}. `branchId` and `endpointId`
 * are optional — when omitted, the API uses the project's default branch and that
 * branch's read-write endpoint, respectively.
 */
export interface GetConnectionUriInput {
	branchId?: string;
	endpointId?: string;
	databaseName: string;
	roleName: string;
	/** When `true`, returns the pooled (PgBouncer) URI instead of the direct URI. */
	pooled?: boolean;
}

/**
 * Narrow façade over the Neon management API. `pullConfig`, `pushConfig`, and `fetchEnv`
 * depend on this interface — *not* on `@neondatabase/api-client` directly — which lets us
 * inject a real in-memory fake during tests without resorting to module mocks.
 */
export interface NeonApi {
	listProjects(filter: { orgId?: string }): Promise<NeonProjectSnapshot[]>;
	getProject(projectId: string): Promise<NeonProjectSnapshot>;
	createProject(input: CreateProjectInput): Promise<NeonProjectSnapshot>;
	updateProject(
		projectId: string,
		input: { name?: string; defaultEndpointSettings?: ComputeSettings },
	): Promise<NeonProjectSnapshot>;

	listBranches(projectId: string): Promise<NeonBranchSnapshot[]>;
	createBranch(
		projectId: string,
		input: CreateBranchInput,
	): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}>;
	updateBranch(
		projectId: string,
		branchId: string,
		input: UpdateBranchInput,
	): Promise<NeonBranchSnapshot>;

	listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]>;
	updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot>;

	/** List roles on a branch. Used by {@link fetchEnv} to auto-pick the role when only one exists. */
	listBranchRoles(
		projectId: string,
		branchId: string,
	): Promise<NeonRoleSnapshot[]>;

	/** List databases on a branch. Used by {@link fetchEnv} to auto-pick the database when only one exists. */
	listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<NeonDatabaseSnapshot[]>;

	/**
	 * Fetch a Postgres connection URI for the given role + database on a branch.
	 * Returns the same string the Neon Console shows under "Connection Details".
	 */
	getConnectionUri(
		projectId: string,
		input: GetConnectionUriInput,
	): Promise<{ uri: string }>;

	/**
	 * Fetch the Neon Auth integration attached to a specific branch. Returns `null` when
	 * no integration is enabled — used by `fetchEnv` to decide whether the `env.auth`
	 * namespace can be populated.
	 */
	getNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot | null>;

	/**
	 * Enable the Neon Auth integration on a specific branch. Idempotent: if an integration
	 * is already enabled, the existing snapshot is returned unchanged. Used by
	 * `pushConfig` and `branch` to honour branch policy `auth: {}` / `auth.enabled: true`.
	 */
	enableNeonAuth(
		projectId: string,
		branchId: string,
		input?: { databaseName?: string },
	): Promise<NeonAuthSnapshot>;

	/**
	 * Fetch the Neon Data API integration attached to a specific branch + database.
	 * Returns `null` when no integration is enabled — used by `fetchEnv` to decide
	 * whether the `env.dataApi` namespace can be populated.
	 */
	getNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot | null>;

	/**
	 * Enable the Neon Data API integration on a specific branch + database. Idempotent:
	 * if an integration is already enabled, the existing snapshot is returned unchanged.
	 * Used by `pushConfig` and `branch` to honour branch policy `dataApi: {}` / `dataApi.enabled: true`.
	 */
	enableProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot>;
}
