import {
	type Branch,
	type BranchCreateRequest,
	type BranchCreateRequestEndpointOptions,
	type BranchUpdateRequest,
	createApiClient,
	type Database,
	type DefaultEndpointSettings,
	type Endpoint,
	EndpointType,
	type EndpointUpdateRequest,
	type PgVersion,
	type Project,
	type ProjectCreateRequest,
	type ProjectListItem,
	type ProjectUpdateRequest,
	type Role,
} from "@neondatabase/api-client";
import { formatSuspendTimeout, parseSuspendTimeout } from "./duration.js";
import { ErrorCode, PlatformError } from "./errors.js";
import type {
	CreateBranchInput,
	CreateProjectInput,
	GetConnectionUriInput,
	NeonApi,
	NeonBranchSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
	UpdateBranchInput,
} from "./neon-api.js";
import type { ComputeSettings } from "./types.js";
import { wrapNeonError } from "./wrap-neon-error.js";

type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Adapt `@neondatabase/api-client` to the narrow {@link NeonApi} façade used by the rest of
 * this package. Constructs are restricted to whole-object read/write of just the fields we
 * model in {@link Config}; anything else stays untouched on the remote.
 */
export function createRealNeonApi(options: {
	apiKey: string;
	baseUrl?: string;
	/**
	 * Tuning knob for the built-in 423 retry. Defaults: ~30s of total wait spread across
	 * 12 attempts with exponential backoff capped at 5s. Lowering this is mostly useful in
	 * tests; raising it is rarely needed because Neon operations are usually sub-second.
	 */
	retryOnLocked?: {
		maxAttempts?: number;
		initialDelayMs?: number;
		maxDelayMs?: number;
	};
}): NeonApi {
	if (!options.apiKey || options.apiKey.trim() === "") {
		throw new PlatformError(
			ErrorCode.MissingApiKey,
			[
				"createRealNeonApi requires a non-empty `apiKey`.",
				"Generate one at https://console.neon.tech/app/settings/api-keys and pass it as { apiKey: process.env.NEON_API_KEY }.",
			].join(" "),
		);
	}

	const client = createApiClient({
		apiKey: options.apiKey,
		...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
	});

	return new RealNeonApi(client, {
		maxAttempts: options.retryOnLocked?.maxAttempts ?? 12,
		initialDelayMs: options.retryOnLocked?.initialDelayMs ?? 250,
		maxDelayMs: options.retryOnLocked?.maxDelayMs ?? 5_000,
	});
}

interface RetryConfig {
	maxAttempts: number;
	initialDelayMs: number;
	maxDelayMs: number;
}

/**
 * Retry a function whenever it throws an HTTP 423 (Locked) — Neon's signal that a prior
 * mutation on the same resource is still in flight. Uses exponential backoff capped at
 * `maxDelayMs`. Any other error (and the last attempt) propagates.
 *
 * Exported only for tests; production callers go through the wrapped {@link NeonApi}.
 */
export async function retryOnLocked<T>(
	fn: () => Promise<T>,
	config: RetryConfig,
): Promise<T> {
	let delay = config.initialDelayMs;
	let lastError: unknown;
	for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const status = readHttpStatusFromError(err);
			if (status !== 423 || attempt === config.maxAttempts) throw err;
			await sleep(delay);
			delay = Math.min(delay * 2, config.maxDelayMs);
		}
	}
	throw lastError;
}

function readHttpStatusFromError(err: unknown): number | undefined {
	if (err === null || typeof err !== "object") return undefined;
	const response = (err as { response?: unknown }).response;
	if (response === null || typeof response !== "object") return undefined;
	const status = (response as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class RealNeonApi implements NeonApi {
	constructor(
		private readonly client: ApiClient,
		private readonly retryConfig: RetryConfig,
	) {}

	private retry<T>(fn: () => Promise<T>): Promise<T> {
		return retryOnLocked(fn, this.retryConfig);
	}

	private async call<T>(
		op: string,
		fn: () => Promise<T>,
		options: { projectId?: string; mutating?: boolean } = {},
	): Promise<T> {
		try {
			return options.mutating ? await this.retry(fn) : await fn();
		} catch (err) {
			const wrapped = wrapNeonError(
				err,
				options.projectId
					? { op, projectId: options.projectId }
					: { op },
			);
			throw wrapped;
		}
	}

	async listProjects(filter: {
		orgId?: string;
	}): Promise<NeonProjectSnapshot[]> {
		return this.call(
			filter.orgId ? `listProjects(org=${filter.orgId})` : "listProjects",
			async () => {
				const projects: ProjectListItem[] = [];
				let cursor: string | undefined;
				while (true) {
					const res = await this.client.listProjects({
						...(filter.orgId ? { org_id: filter.orgId } : {}),
						...(cursor ? { cursor } : {}),
						limit: 100,
					});
					projects.push(...res.data.projects);
					const next = (
						res.data as { pagination?: { next?: string } }
					).pagination?.next;
					if (!next || next === cursor) break;
					cursor = next;
				}
				return projects.map(projectToSnapshot);
			},
		);
	}

	async getProject(projectId: string): Promise<NeonProjectSnapshot> {
		return this.call(
			`getProject(${projectId})`,
			async () => {
				const res = await this.client.getProject(projectId);
				return projectToSnapshot(res.data.project);
			},
			{ projectId },
		);
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
				...(input.defaultBranchName
					? { branch: { name: input.defaultBranchName } }
					: {}),
			},
		};
		return this.call(
			`createProject(${input.name})`,
			async () => {
				const res = await this.client.createProject(body);
				return projectToSnapshot(res.data.project);
			},
			{ mutating: true },
		);
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
		return this.call(
			`updateProject(${projectId})`,
			async () => {
				const res = await this.client.updateProject(projectId, body);
				return projectToSnapshot(res.data.project);
			},
			{ projectId, mutating: true },
		);
	}

	async listBranches(projectId: string): Promise<NeonBranchSnapshot[]> {
		return this.call(
			`listBranches(${projectId})`,
			async () => {
				const branches: Branch[] = [];
				let cursor: string | undefined;
				while (true) {
					const res = await this.client.listProjectBranches({
						projectId,
						limit: 100,
						...(cursor ? { cursor } : {}),
					});
					branches.push(...(res.data.branches as Branch[]));
					const next = (
						res.data as { pagination?: { next?: string } }
					).pagination?.next;
					if (!next || next === cursor) break;
					cursor = next;
				}
				return branches.map(branchToSnapshot);
			},
			{ projectId },
		);
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
		return this.call(
			`createBranch(${projectId}/${input.name})`,
			async () => {
				const res = await this.client.createProjectBranch(
					projectId,
					body,
				);
				return {
					branch: branchToSnapshot(res.data.branch),
					endpoints: (res.data.endpoints ?? []).map(
						endpointToSnapshot,
					),
				};
			},
			{ projectId, mutating: true },
		);
	}

	async updateBranch(
		projectId: string,
		branchId: string,
		input: UpdateBranchInput,
	): Promise<NeonBranchSnapshot> {
		const branch: BranchUpdateRequest["branch"] = {};
		if (input.name !== undefined) branch.name = input.name;
		if (input.expiresAt !== undefined) branch.expires_at = input.expiresAt;
		return this.call(
			`updateBranch(${projectId}/${branchId})`,
			async () => {
				const res = await this.client.updateProjectBranch(
					projectId,
					branchId,
					{ branch },
				);
				return branchToSnapshot(res.data.branch);
			},
			{ projectId, mutating: true },
		);
	}

	async listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]> {
		return this.call(
			`listEndpoints(${projectId})`,
			async () => {
				const res = await this.client.listProjectEndpoints(projectId);
				return (res.data.endpoints as Endpoint[]).map(
					endpointToSnapshot,
				);
			},
			{ projectId },
		);
	}

	async updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot> {
		const endpoint: EndpointUpdateRequest["endpoint"] =
			computeSettingsToEndpointOptions(settings);
		return this.call(
			`updateEndpoint(${projectId}/${endpointId})`,
			async () => {
				const res = await this.client.updateProjectEndpoint(
					projectId,
					endpointId,
					{ endpoint },
				);
				return endpointToSnapshot(res.data.endpoint);
			},
			{ projectId, mutating: true },
		);
	}

	async listBranchRoles(
		projectId: string,
		branchId: string,
	): Promise<NeonRoleSnapshot[]> {
		return this.call(
			`listBranchRoles(${projectId}/${branchId})`,
			async () => {
				const res = await this.client.listProjectBranchRoles(
					projectId,
					branchId,
				);
				return (res.data.roles as Role[]).map(roleToSnapshot);
			},
			{ projectId },
		);
	}

	async listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<NeonDatabaseSnapshot[]> {
		return this.call(
			`listBranchDatabases(${projectId}/${branchId})`,
			async () => {
				const res = await this.client.listProjectBranchDatabases(
					projectId,
					branchId,
				);
				return (res.data.databases as Database[]).map(
					databaseToSnapshot,
				);
			},
			{ projectId },
		);
	}

	async getConnectionUri(
		projectId: string,
		input: GetConnectionUriInput,
	): Promise<{ uri: string }> {
		const op = `getConnectionUri(${projectId}/${input.databaseName}@${input.roleName}${input.pooled ? " pooled" : ""})`;
		// Always send `pooled` explicitly. The Neon API has switched its default
		// to returning the pooled URI when the parameter is omitted, so we have
		// to be explicit to get the direct URI back.
		const pooled = input.pooled === true;
		return this.call(
			op,
			async () => {
				const res = await this.client.getConnectionUri({
					projectId,
					database_name: input.databaseName,
					role_name: input.roleName,
					...(input.branchId ? { branch_id: input.branchId } : {}),
					...(input.endpointId
						? { endpoint_id: input.endpointId }
						: {}),
					pooled,
				});
				return { uri: res.data.uri };
			},
			{ projectId },
		);
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
		autoscalingLimitMinCu:
			endpoint.autoscaling_limit_min_cu as ComputeSettings["autoscalingLimitMinCu"],
		autoscalingLimitMaxCu:
			endpoint.autoscaling_limit_max_cu as ComputeSettings["autoscalingLimitMaxCu"],
		suspendTimeout: formatSuspendTimeout(endpoint.suspend_timeout_seconds),
	};
}

function roleToSnapshot(role: Role): NeonRoleSnapshot {
	return {
		name: role.name,
		branchId: role.branch_id,
		protected: role.protected ?? false,
	};
}

function databaseToSnapshot(database: Database): NeonDatabaseSnapshot {
	return {
		name: database.name,
		branchId: database.branch_id,
		ownerName: database.owner_name,
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
	if (settings.suspendTimeout !== undefined) {
		const parsed = parseSuspendTimeout(settings.suspendTimeout);
		if ("error" in parsed) {
			throw new PlatformError(
				ErrorCode.InvalidConfig,
				`Invalid suspendTimeout: ${parsed.error}`,
			);
		}
		out.suspend_timeout_seconds = parsed.seconds;
	}
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
	if (settings.suspendTimeout !== undefined) {
		const parsed = parseSuspendTimeout(settings.suspendTimeout);
		if ("error" in parsed) {
			throw new PlatformError(
				ErrorCode.InvalidConfig,
				`Invalid suspendTimeout: ${parsed.error}`,
			);
		}
		out.suspend_timeout_seconds = parsed.seconds;
	}
	return out;
}

function defaultsToComputeSettings(
	defaults: DefaultEndpointSettings,
): ComputeSettings | undefined {
	const out: ComputeSettings = {};
	if (defaults.autoscaling_limit_min_cu !== undefined)
		out.autoscalingLimitMinCu =
			defaults.autoscaling_limit_min_cu as ComputeSettings["autoscalingLimitMinCu"];
	if (defaults.autoscaling_limit_max_cu !== undefined)
		out.autoscalingLimitMaxCu =
			defaults.autoscaling_limit_max_cu as ComputeSettings["autoscalingLimitMaxCu"];
	if (defaults.suspend_timeout_seconds !== undefined)
		out.suspendTimeout = formatSuspendTimeout(
			defaults.suspend_timeout_seconds,
		);
	return Object.keys(out).length > 0 ? out : undefined;
}
