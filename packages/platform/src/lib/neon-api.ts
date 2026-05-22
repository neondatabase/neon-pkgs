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
	expiresAt?: string;
}

export interface NeonEndpointSnapshot {
	id: string;
	branchId: string;
	type: "read_only" | "read_write";
	autoscalingLimitMinCu: number;
	autoscalingLimitMaxCu: number;
	suspendTimeoutSeconds: number;
}

export interface CreateProjectInput {
	name: string;
	regionId: string;
	pgVersion?: number;
	orgId?: string;
	defaultEndpointSettings?: ComputeSettings;
	/**
	 * Optional name for the project's auto-created default branch. When omitted, Neon
	 * uses its own default (`main`). Set this to the root blueprint's pattern so push
	 * can match the desired state without trying to create a sibling branch.
	 */
	defaultBranchName?: string;
}

export interface CreateBranchInput {
	name: string;
	parentId?: string;
	expiresAt?: string;
	computeSettings?: ComputeSettings;
}

export interface UpdateBranchInput {
	name?: string;
	expiresAt?: string | null;
}

/**
 * Narrow façade over the Neon management API. Both `pullConfig` and `pushConfig` depend on
 * this interface — *not* on `@neondatabase/api-client` directly — which lets us inject a
 * real in-memory fake during tests without resorting to module mocks.
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
}
