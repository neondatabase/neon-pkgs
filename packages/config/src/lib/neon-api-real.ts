import type {
	DataApiSettings as ApiDataApiSettings,
	Branch,
	BranchCreateRequest,
	BranchCreateRequestEndpointOptions,
	BranchUpdateRequest,
	DataApiCreateRequest,
	DataApiReponse,
	Database,
	DefaultEndpointSettings,
	Endpoint,
	EndpointUpdateRequest,
	PgVersion,
	Project,
	ProjectCreateRequest,
	ProjectListItem,
	ProjectUpdateRequest,
	Role,
} from "@neon/sdk";
import { createNeonClient } from "@neon/sdk";
import {
	createProject as rawCreateProject,
	createProjectBranch as rawCreateProjectBranch,
	createProjectBranchDataApi as rawCreateProjectBranchDataApi,
	getConnectionUri as rawGetConnectionUri,
	getNeonAuth as rawGetNeonAuth,
	getProject as rawGetProject,
	getProjectBranchDataApi as rawGetProjectBranchDataApi,
	listProjectBranchDatabases as rawListProjectBranchDatabases,
	listProjectBranches as rawListProjectBranches,
	listProjectBranchRoles as rawListProjectBranchRoles,
	listProjectEndpoints as rawListProjectEndpoints,
	listProjects as rawListProjects,
	updateProject as rawUpdateProject,
	updateProjectBranch as rawUpdateProjectBranch,
	updateProjectBranchDataApi as rawUpdateProjectBranchDataApi,
	updateProjectEndpoint as rawUpdateProjectEndpoint,
} from "@neon/sdk/raw";
import { z } from "zod";
import { formatSuspendTimeout, parseSuspendTimeout } from "./duration.js";
import { ErrorCode, PlatformError } from "./errors.js";
import type {
	CreateBranchInput,
	CreateBucketInput,
	CreateCredentialInput,
	CreateProjectInput,
	DeployFunctionInput,
	EnableDataApiInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBranchStorageSnapshot,
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
import type {
	BucketAccessLevel,
	ComputeSettings,
	DataApiSettings,
} from "./types.js";
import { wrapNeonError } from "./wrap-neon-error.js";

type ApiClient = ReturnType<typeof createNeonClient>["client"];
const DEFAULT_NEON_API_BASE_URL = "https://console.neon.tech/api/v2";

/**
 * Unwrap a `@neon/sdk` raw `{ data, error, response }` result into the bare body, throwing
 * on a non-2xx response. The thrown shape (`{ response: { status, data } }`) deliberately
 * matches what the package's REST fallbacks already throw, so {@link wrapNeonError} and the
 * 423 {@link retryOnLocked} retry keep working unchanged across both transports.
 */
function unwrap<T>(result: {
	data?: T;
	error?: unknown;
	response?: Response;
}): T {
	const response = result.response;
	if (!response?.ok) {
		throw {
			response: {
				status: response?.status,
				data: result.error,
			},
		};
	}
	return result.data as T;
}

const neonAuthResponseSchema = z.object({
	auth_provider_project_id: z.string(),
	pub_client_key: z.string().optional(),
	secret_server_key: z.string().optional(),
	jwks_url: z.string(),
	base_url: z.string().optional(),
});

// ─── Data API mapping (camelCase neon.ts ↔ snake_case Neon API) ───────────────

/** Map our camelCase {@link DataApiSettings} onto the Neon API's snake_case `DataAPISettings`. */
function dataApiSettingsToApi(settings: DataApiSettings): ApiDataApiSettings {
	const out: ApiDataApiSettings = {};
	if (settings.dbAggregatesEnabled !== undefined)
		out.db_aggregates_enabled = settings.dbAggregatesEnabled;
	if (settings.dbAnonRole !== undefined)
		out.db_anon_role = settings.dbAnonRole;
	if (settings.dbExtraSearchPath !== undefined)
		out.db_extra_search_path = settings.dbExtraSearchPath;
	if (settings.dbMaxRows !== undefined) out.db_max_rows = settings.dbMaxRows;
	if (settings.dbSchemas !== undefined) out.db_schemas = settings.dbSchemas;
	if (settings.jwtRoleClaimKey !== undefined)
		out.jwt_role_claim_key = settings.jwtRoleClaimKey;
	if (settings.jwtCacheMaxLifetime !== undefined)
		out.jwt_cache_max_lifetime = settings.jwtCacheMaxLifetime;
	if (settings.openapiMode !== undefined)
		out.openapi_mode = settings.openapiMode;
	if (settings.serverCorsAllowedOrigins !== undefined)
		out.server_cors_allowed_origins = settings.serverCorsAllowedOrigins;
	if (settings.serverTimingEnabled !== undefined)
		out.server_timing_enabled = settings.serverTimingEnabled;
	return out;
}

/** Narrow the API's free-form `openapi_mode` string to our literal union (else drop it). */
function normalizeOpenapiMode(
	value: string,
): DataApiSettings["openapiMode"] | undefined {
	return value === "ignore-privileges" || value === "disabled"
		? value
		: undefined;
}

/** Map the Neon API's snake_case `DataAPISettings` back to our camelCase {@link DataApiSettings}. */
function dataApiSettingsFromApi(
	settings: ApiDataApiSettings | null | undefined,
): DataApiSettings | undefined {
	if (!settings) return undefined;
	const out: DataApiSettings = {};
	if (settings.db_aggregates_enabled !== undefined)
		out.dbAggregatesEnabled = settings.db_aggregates_enabled;
	if (settings.db_anon_role !== undefined)
		out.dbAnonRole = settings.db_anon_role;
	if (settings.db_extra_search_path !== undefined)
		out.dbExtraSearchPath = settings.db_extra_search_path;
	if (settings.db_max_rows !== undefined)
		out.dbMaxRows = settings.db_max_rows;
	if (settings.db_schemas !== undefined) out.dbSchemas = settings.db_schemas;
	if (settings.jwt_role_claim_key !== undefined)
		out.jwtRoleClaimKey = settings.jwt_role_claim_key;
	if (settings.jwt_cache_max_lifetime !== undefined)
		out.jwtCacheMaxLifetime = settings.jwt_cache_max_lifetime;
	if (settings.openapi_mode !== undefined) {
		const mode = normalizeOpenapiMode(settings.openapi_mode);
		if (mode !== undefined) out.openapiMode = mode;
	}
	if (settings.server_cors_allowed_origins !== undefined)
		out.serverCorsAllowedOrigins = settings.server_cors_allowed_origins;
	if (settings.server_timing_enabled !== undefined)
		out.serverTimingEnabled = settings.server_timing_enabled;
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Build the Neon API `DataAPICreateRequest` from our {@link EnableDataApiInput}. */
function dataApiCreateRequest(
	input: EnableDataApiInput | undefined,
): DataApiCreateRequest {
	const req: DataApiCreateRequest = {};
	if (!input) return req;
	if (input.authProvider !== undefined)
		req.auth_provider =
			input.authProvider === "neon" ? "neon_auth" : "external";
	if (input.jwksUrl !== undefined) req.jwks_url = input.jwksUrl;
	if (input.providerName !== undefined)
		req.provider_name = input.providerName;
	if (input.jwtAudience !== undefined) req.jwt_audience = input.jwtAudience;
	if (input.settings) {
		const settings = dataApiSettingsToApi(input.settings);
		if (Object.keys(settings).length > 0) req.settings = settings;
	}
	return req;
}

/** Map a `DataAPIReponse` (GET) onto our {@link NeonDataApiSnapshot}. */
function dataApiSnapshotFromResponse(
	data: DataApiReponse,
): NeonDataApiSnapshot {
	const snapshot: NeonDataApiSnapshot = { url: data.url };
	if (data.status !== undefined) snapshot.status = data.status;
	const settings = dataApiSettingsFromApi(data.settings);
	if (settings) snapshot.settings = settings;
	return snapshot;
}

// ─── Preview: buckets ──────────────────────────────────────────────────────

const bucketSchema = z.object({
	name: z.string(),
	access_level: z.string().optional(),
});
const bucketResponseSchema = z.object({ bucket: bucketSchema });
const bucketsListResponseSchema = z.object({ buckets: z.array(bucketSchema) });
const branchStorageSchema = z.object({
	enabled: z.boolean().optional(),
	s3_endpoint: z.string(),
	region: z.string(),
	force_path_style: z.boolean(),
});

// ─── Preview: functions ────────────────────────────────────────────────────

const functionDeploymentSchema = z.object({
	id: z.number(),
	status: z.string(),
});
const neonFunctionSchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	invocation_url: z.string(),
	active_deployment: functionDeploymentSchema.optional(),
});
const functionsListResponseSchema = z.object({
	functions: z.array(neonFunctionSchema),
});
const functionDeploymentResponseSchema = z.object({
	deployment: functionDeploymentSchema,
});

// ─── Preview: branch-scoped credentials ─────────────────────────────────────

const credentialScopeSchema = z.enum([
	"storage:read",
	"storage:write",
	"ai_gateway:invoke",
	"functions:invoke",
]);
const createCredentialResponseSchema = z.object({
	token_id: z.string(),
	token_id_short: z.string(),
	name: z.string().optional(),
	api_token: z.string(),
	s3_secret_access_key: z.string(),
	scopes: z.array(credentialScopeSchema),
	branch_id: z.string(),
	created_at: z.string(),
	expires_at: z.string().optional(),
});
const credentialMetaSchema = z.object({
	token_id: z.string(),
	token_id_short: z.string(),
	name: z.string().optional(),
	scopes: z.array(credentialScopeSchema),
	principal_type: z.enum(["user", "function"]),
	function_id: z.string().optional(),
	branch_id: z.string().optional(),
	created_at: z.string(),
	last_used_at: z.string().optional(),
	revoked_at: z.string().optional(),
	expires_at: z.string().optional(),
});
const listCredentialsResponseSchema = z.object({
	credentials: z.array(credentialMetaSchema),
});

interface CreateNeonAuthRestInput {
	auth_provider: "better_auth";
	database_name?: string;
}

interface RestConfig {
	apiKey: string;
	baseUrl: string;
}

/**
 * Adapt `@neon/sdk` (raw layer) to the narrow {@link NeonApi} façade used by the rest of
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

	// The SDK runs its own retries by default; this adapter does its own 423-aware
	// `retryOnLocked`, so disable the SDK's to avoid compounding backoff.
	const client = createNeonClient({
		apiKey: options.apiKey,
		retries: 0,
		...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
	}).client;

	return new RealNeonApi(
		client,
		{
			maxAttempts: options.retryOnLocked?.maxAttempts ?? 12,
			initialDelayMs: options.retryOnLocked?.initialDelayMs ?? 250,
			maxDelayMs: options.retryOnLocked?.maxDelayMs ?? 5_000,
		},
		{
			apiKey: options.apiKey,
			baseUrl: options.baseUrl ?? DEFAULT_NEON_API_BASE_URL,
		},
	);
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
		private readonly restConfig: RestConfig,
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
					const body = unwrap(
						await rawListProjects({
							client: this.client,
							query: {
								...(filter.orgId
									? { org_id: filter.orgId }
									: {}),
								...(cursor ? { cursor } : {}),
								limit: 100,
							},
						}),
					);
					projects.push(...body.projects);
					const next = (body as { pagination?: { next?: string } })
						.pagination?.next;
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
				const body = unwrap(
					await rawGetProject({
						client: this.client,
						path: { project_id: projectId },
					}),
				);
				return projectToSnapshot(body.project);
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
				const data = unwrap(
					await rawCreateProject({ client: this.client, body }),
				);
				return projectToSnapshot(data.project);
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
				const data = unwrap(
					await rawUpdateProject({
						client: this.client,
						path: { project_id: projectId },
						body,
					}),
				);
				return projectToSnapshot(data.project);
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
					const body = unwrap(
						await rawListProjectBranches({
							client: this.client,
							path: { project_id: projectId },
							query: {
								limit: 100,
								...(cursor ? { cursor } : {}),
							},
						}),
					);
					branches.push(...(body.branches as Branch[]));
					const next = (body as { pagination?: { next?: string } })
						.pagination?.next;
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
						type: "read_write",
						...computeSettingsToEndpointOptions(
							input.computeSettings,
						),
					}
				: { type: "read_write" };

		const body: BranchCreateRequest = {
			branch: {
				name: input.name,
				...(input.parentId ? { parent_id: input.parentId } : {}),
				...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
				...(input.protected !== undefined
					? { protected: input.protected }
					: {}),
			},
			endpoints: [endpointOptions],
		};
		return this.call(
			`createBranch(${projectId}/${input.name})`,
			async () => {
				const data = unwrap(
					await rawCreateProjectBranch({
						client: this.client,
						path: { project_id: projectId },
						body,
					}),
				);
				return {
					branch: branchToSnapshot(data.branch),
					endpoints: (data.endpoints ?? []).map(endpointToSnapshot),
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
		if (input.protected !== undefined) branch.protected = input.protected;
		return this.call(
			`updateBranch(${projectId}/${branchId})`,
			async () => {
				const data = unwrap(
					await rawUpdateProjectBranch({
						client: this.client,
						path: { project_id: projectId, branch_id: branchId },
						body: { branch },
					}),
				);
				return branchToSnapshot(data.branch);
			},
			{ projectId, mutating: true },
		);
	}

	async listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]> {
		return this.call(
			`listEndpoints(${projectId})`,
			async () => {
				const data = unwrap(
					await rawListProjectEndpoints({
						client: this.client,
						path: { project_id: projectId },
					}),
				);
				return (data.endpoints as Endpoint[]).map(endpointToSnapshot);
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
				const data = unwrap(
					await rawUpdateProjectEndpoint({
						client: this.client,
						path: {
							project_id: projectId,
							endpoint_id: endpointId,
						},
						body: { endpoint },
					}),
				);
				return endpointToSnapshot(data.endpoint);
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
				const data = unwrap(
					await rawListProjectBranchRoles({
						client: this.client,
						path: { project_id: projectId, branch_id: branchId },
					}),
				);
				return (data.roles as Role[]).map(roleToSnapshot);
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
				const data = unwrap(
					await rawListProjectBranchDatabases({
						client: this.client,
						path: { project_id: projectId, branch_id: branchId },
					}),
				);
				return (data.databases as Database[]).map(databaseToSnapshot);
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
				const data = unwrap(
					await rawGetConnectionUri({
						client: this.client,
						path: { project_id: projectId },
						query: {
							database_name: input.databaseName,
							role_name: input.roleName,
							...(input.branchId
								? { branch_id: input.branchId }
								: {}),
							...(input.endpointId
								? { endpoint_id: input.endpointId }
								: {}),
							pooled,
						},
					}),
				);
				return { uri: data.uri };
			},
			{ projectId },
		);
	}

	async getNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot | null> {
		// `GET /projects/:pid/branches/:bid/auth` returns 404 when no integration exists.
		// Surface that as `null` so callers can branch cleanly instead of try/catch.
		try {
			return await this.call(
				`getNeonAuth(${projectId}/${branchId})`,
				async () => {
					const data = unwrap(
						await rawGetNeonAuth({
							client: this.client,
							path: {
								project_id: projectId,
								branch_id: branchId,
							},
						}),
					);
					return neonAuthResponseToSnapshot(
						neonAuthResponseSchema.parse(data),
					);
				},
				{ projectId },
			);
		} catch (err) {
			if (err instanceof PlatformError && err.code === ErrorCode.NotFound)
				return null;
			throw err;
		}
	}

	async enableNeonAuth(
		projectId: string,
		branchId: string,
		input: { databaseName?: string } = {},
	): Promise<NeonAuthSnapshot> {
		// Idempotent: if an integration already exists on the branch, the POST returns 409
		// (`Conflict`). We swallow that and re-fetch the existing snapshot so callers can
		// rely on `enableNeonAuth` to be safe to invoke from any push, including no-ops.
		try {
			return await this.call(
				`enableNeonAuth(${projectId}/${branchId})`,
				async () => {
					// The generated `createNeonAuth` doesn't narrow this branch
					// endpoint to `better_auth`, so post the REST body directly.
					const data = await this.postJson(
						`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/auth`,
						createNeonAuthRestInput(input),
					);
					const parsed = neonAuthResponseSchema.parse(data);
					return neonAuthResponseToSnapshot(parsed);
				},
				{ projectId, mutating: true },
			);
		} catch (err) {
			if (
				err instanceof PlatformError &&
				err.code === ErrorCode.Conflict
			) {
				const existing = await this.getNeonAuth(projectId, branchId);
				if (existing) return existing;
			}
			throw err;
		}
	}

	private async postJson(path: string, body: unknown): Promise<unknown> {
		return this.request("POST", path, {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	private async getJson(path: string): Promise<unknown> {
		return this.request("GET", path);
	}

	private async deleteJson(path: string): Promise<unknown> {
		return this.request("DELETE", path);
	}

	/**
	 * Upload a built function bundle via `multipart/form-data` to the deploy endpoint
	 * (`POST .../functions/{slug}/deployments`). Body shape lives in the pure
	 * {@link buildFunctionDeployForm} helper so it can be unit-tested against the spec.
	 */
	private async postMultipart(
		path: string,
		input: DeployFunctionInput,
	): Promise<unknown> {
		return this.request("POST", path, {
			body: buildFunctionDeployForm(input),
		});
	}

	private async request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		init: { headers?: Record<string, string>; body?: BodyInit } = {},
	): Promise<unknown> {
		const url = `${this.restConfig.baseUrl.replace(/\/+$/, "")}${path}`;
		const res = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${this.restConfig.apiKey}`,
				...(init.headers ?? {}),
			},
			...(init.body !== undefined ? { body: init.body } : {}),
		});
		const data = await readJsonBody(res);
		if (!res.ok) {
			throw {
				response: {
					status: res.status,
					data,
				},
			};
		}
		return data;
	}

	async getNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot | null> {
		// Same shape as getNeonAuth — 404 means "no integration on this branch/db", which
		// we translate to `null` for the caller.
		try {
			return await this.call(
				`getNeonDataApi(${projectId}/${branchId}/${databaseName})`,
				async () =>
					dataApiSnapshotFromResponse(
						unwrap(
							await rawGetProjectBranchDataApi({
								client: this.client,
								path: {
									project_id: projectId,
									branch_id: branchId,
									database_name: databaseName,
								},
							}),
						),
					),
				{ projectId },
			);
		} catch (err) {
			if (err instanceof PlatformError && err.code === ErrorCode.NotFound)
				return null;
			throw err;
		}
	}

	async enableProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: EnableDataApiInput,
	): Promise<NeonDataApiSnapshot> {
		// Idempotent in the same shape as `enableNeonAuth`: if an integration already
		// exists, the POST returns 409 and we re-fetch the existing snapshot.
		try {
			return await this.call(
				`enableProjectBranchDataApi(${projectId}/${branchId}/${databaseName})`,
				async () => {
					const data = unwrap(
						await rawCreateProjectBranchDataApi({
							client: this.client,
							path: {
								project_id: projectId,
								branch_id: branchId,
								database_name: databaseName,
							},
							body: dataApiCreateRequest(input),
						}),
					);
					// The create response only carries `url`; settings/status come from a
					// follow-up GET, which we leave to the caller when it needs them.
					return { url: data.url };
				},
				{ projectId, mutating: true },
			);
		} catch (err) {
			if (
				err instanceof PlatformError &&
				err.code === ErrorCode.Conflict
			) {
				const existing = await this.getNeonDataApi(
					projectId,
					branchId,
					databaseName,
				);
				if (existing) return existing;
			}
			throw err;
		}
	}

	async updateProjectBranchDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
		settings: DataApiSettings,
	): Promise<NeonDataApiSnapshot> {
		return await this.call(
			`updateProjectBranchDataApi(${projectId}/${branchId}/${databaseName})`,
			async () => {
				unwrap(
					await rawUpdateProjectBranchDataApi({
						client: this.client,
						path: {
							project_id: projectId,
							branch_id: branchId,
							database_name: databaseName,
						},
						body: { settings: dataApiSettingsToApi(settings) },
					}),
				);
				// The PATCH returns an empty body; re-fetch so the caller sees the
				// post-update url/status/settings.
				const data = unwrap(
					await rawGetProjectBranchDataApi({
						client: this.client,
						path: {
							project_id: projectId,
							branch_id: branchId,
							database_name: databaseName,
						},
					}),
				);
				return dataApiSnapshotFromResponse(data);
			},
			{ projectId, mutating: true },
		);
	}

	// ─── Preview: buckets ──────────────────────────────────────────────────────

	async listBranchBuckets(
		projectId: string,
		branchId: string,
	): Promise<NeonBucketSnapshot[]> {
		try {
			return await this.call(
				`listBranchBuckets(${projectId}/${branchId})`,
				async () => {
					const data = await this.getJson(
						branchPreviewPath(projectId, branchId, "buckets"),
					);
					const parsed = bucketsListResponseSchema.parse(data);
					return parsed.buckets.map(bucketToSnapshot);
				},
				{ projectId },
			);
		} catch (err) {
			throw previewUnavailableError(err, "Object storage (buckets)");
		}
	}

	async createBranchBucket(
		projectId: string,
		branchId: string,
		input: CreateBucketInput,
	): Promise<NeonBucketSnapshot> {
		return this.call(
			`createBranchBucket(${projectId}/${branchId}/${input.name})`,
			async () => {
				const data = await this.postJson(
					branchPreviewPath(projectId, branchId, "buckets"),
					{
						name: input.name,
						...(input.accessLevel
							? { access_level: input.accessLevel }
							: {}),
					},
				);
				const parsed = bucketResponseSchema.parse(data);
				return bucketToSnapshot(parsed.bucket);
			},
			{ projectId, mutating: true },
		);
	}

	async deleteBranchBucket(
		projectId: string,
		branchId: string,
		bucketName: string,
	): Promise<void> {
		await this.call(
			`deleteBranchBucket(${projectId}/${branchId}/${bucketName})`,
			async () => {
				await this.deleteJson(
					`${branchPreviewPath(projectId, branchId, "buckets")}/${encodeURIComponent(bucketName)}`,
				);
			},
			{ projectId, mutating: true },
		);
	}

	async getProjectBranchStorage(
		projectId: string,
		branchId: string,
	): Promise<NeonBranchStorageSnapshot | null> {
		try {
			return await this.call(
				`getProjectBranchStorage(${projectId}/${branchId})`,
				async () => {
					const data = await this.getJson(
						`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/storage`,
					);
					const parsed = branchStorageSchema.parse(data);
					return {
						s3Endpoint: parsed.s3_endpoint,
						region: parsed.region,
						forcePathStyle: parsed.force_path_style,
					};
				},
				{ projectId },
			);
		} catch (err) {
			// 404 BranchStorageNotEnabled → storage not usable on this branch; let the
			// caller decide (fetchEnv throws a clear "enable storage first" error).
			if (err instanceof PlatformError && err.code === ErrorCode.NotFound)
				return null;
			throw previewUnavailableError(err, "Object storage");
		}
	}

	// ─── Preview: functions ────────────────────────────────────────────────────

	async listBranchFunctions(
		projectId: string,
		branchId: string,
	): Promise<NeonFunctionSnapshot[]> {
		try {
			return await this.call(
				`listBranchFunctions(${projectId}/${branchId})`,
				async () => {
					const data = await this.getJson(
						branchPreviewPath(projectId, branchId, "functions"),
					);
					const parsed = functionsListResponseSchema.parse(data);
					return parsed.functions.map(functionToSnapshot);
				},
				{ projectId },
			);
		} catch (err) {
			throw previewUnavailableError(err, "Functions");
		}
	}

	async deleteBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
	): Promise<void> {
		await this.call(
			`deleteBranchFunction(${projectId}/${branchId}/${slug})`,
			async () => {
				await this.deleteJson(
					`${branchPreviewPath(projectId, branchId, "functions")}/${encodeURIComponent(slug)}`,
				);
			},
			{ projectId, mutating: true },
		);
	}

	async deployBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
		input: DeployFunctionInput,
	): Promise<NeonFunctionDeploymentSnapshot> {
		return this.call(
			`deployBranchFunction(${projectId}/${branchId}/${slug})`,
			async () => {
				const data = await this.postMultipart(
					`${branchPreviewPath(projectId, branchId, "functions")}/${encodeURIComponent(slug)}/deployments`,
					input,
				);
				const parsed = functionDeploymentResponseSchema.parse(data);
				return deploymentToSnapshot(parsed.deployment);
			},
			{ projectId, mutating: true },
		);
	}

	// ─── Preview: AI Gateway ───────────────────────────────────────────────────
	//
	// No methods: the AI Gateway is always available on a branch (credential-gated, not
	// per-branch provisioned). There is no control-plane enable/disable/status route — the
	// gateway is reached at the branch host with a credential carrying `ai_gateway:invoke`.
	// `preview.aiGateway` only drives that credential scope and the
	// `NEON_AI_GATEWAY_*` env vars (see `@neon/env`); nothing is provisioned here, so
	// `plan` / `apply` never touch an AI Gateway route and can't fail on its availability.

	// ─── Preview: branch-scoped credentials ──────────────────────────────────

	async createCredential(
		projectId: string,
		branchId: string,
		input: CreateCredentialInput,
	): Promise<NeonCredentialSecret> {
		try {
			return await this.call(
				`createCredential(${projectId}/${branchId})`,
				async () => {
					const data = await this.postJson(
						credentialsPath(projectId, branchId),
						{
							scopes: input.scopes,
							principal_type: input.principalType,
							...(input.functionId
								? { function_id: input.functionId }
								: {}),
							...(input.name ? { name: input.name } : {}),
						},
					);
					const parsed = createCredentialResponseSchema.parse(data);
					return createCredentialToSnapshot(parsed);
				},
				{ projectId, mutating: true },
			);
		} catch (err) {
			throw previewUnavailableError(err, "Branch credentials");
		}
	}

	async listCredentials(
		projectId: string,
		branchId: string,
	): Promise<NeonCredentialMeta[]> {
		try {
			return await this.call(
				`listCredentials(${projectId}/${branchId})`,
				async () => {
					const data = await this.getJson(
						credentialsPath(projectId, branchId),
					);
					const parsed = listCredentialsResponseSchema.parse(data);
					return parsed.credentials.map(credentialMetaToSnapshot);
				},
				{ projectId },
			);
		} catch (err) {
			throw previewUnavailableError(err, "Branch credentials");
		}
	}

	async revokeCredential(
		projectId: string,
		branchId: string,
		tokenId: string,
	): Promise<void> {
		await this.call(
			`revokeCredential(${projectId}/${branchId}/${tokenId})`,
			async () => {
				await this.deleteJson(
					`${credentialsPath(projectId, branchId)}/${encodeURIComponent(tokenId)}`,
				);
			},
			{ projectId, mutating: true },
		);
	}
}

function branchPreviewPath(
	projectId: string,
	branchId: string,
	resource: "buckets" | "functions",
): string {
	return `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/${resource}`;
}

function credentialsPath(projectId: string, branchId: string): string {
	return `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/credentials`;
}

function createCredentialToSnapshot(
	data: z.infer<typeof createCredentialResponseSchema>,
): NeonCredentialSecret {
	const snapshot: NeonCredentialSecret = {
		tokenId: data.token_id,
		tokenIdShort: data.token_id_short,
		apiToken: data.api_token,
		s3SecretAccessKey: data.s3_secret_access_key,
		scopes: data.scopes,
		branchId: data.branch_id,
		createdAt: data.created_at,
	};
	if (data.name !== undefined) snapshot.name = data.name;
	if (data.expires_at !== undefined) snapshot.expiresAt = data.expires_at;
	return snapshot;
}

function credentialMetaToSnapshot(
	data: z.infer<typeof credentialMetaSchema>,
): NeonCredentialMeta {
	const snapshot: NeonCredentialMeta = {
		tokenId: data.token_id,
		tokenIdShort: data.token_id_short,
		scopes: data.scopes,
		principalType: data.principal_type,
		createdAt: data.created_at,
	};
	if (data.name !== undefined) snapshot.name = data.name;
	if (data.function_id !== undefined) snapshot.functionId = data.function_id;
	if (data.branch_id !== undefined) snapshot.branchId = data.branch_id;
	if (data.last_used_at !== undefined)
		snapshot.lastUsedAt = data.last_used_at;
	if (data.revoked_at !== undefined) snapshot.revokedAt = data.revoked_at;
	if (data.expires_at !== undefined) snapshot.expiresAt = data.expires_at;
	return snapshot;
}

function bucketToSnapshot(
	bucket: z.infer<typeof bucketSchema>,
): NeonBucketSnapshot {
	return {
		name: bucket.name,
		accessLevel: normalizeBucketAccessLevel(bucket.access_level),
	};
}

/**
 * The Neon API returns `access_level` as a free-form string (per the API guidelines:
 * responses use plain strings, not enums). Map the known values onto our union and treat
 * anything else as `private` — the safe default for an unrecognised access level.
 */
function normalizeBucketAccessLevel(
	value: string | undefined,
): BucketAccessLevel {
	return value === "public_read" ? "public_read" : "private";
}

function functionToSnapshot(
	fn: z.infer<typeof neonFunctionSchema>,
): NeonFunctionSnapshot {
	const snapshot: NeonFunctionSnapshot = {
		id: fn.id,
		slug: fn.slug,
		name: fn.name,
		invocationUrl: fn.invocation_url,
	};
	if (fn.active_deployment) {
		snapshot.activeDeploymentId = fn.active_deployment.id;
	}
	return snapshot;
}

function deploymentToSnapshot(
	deployment: z.infer<typeof functionDeploymentSchema>,
): NeonFunctionDeploymentSnapshot {
	return {
		id: deployment.id,
		status: normalizeDeploymentStatus(deployment.status),
	};
}

function normalizeDeploymentStatus(
	value: string,
): NeonFunctionDeploymentSnapshot["status"] {
	switch (value) {
		case "pending":
		case "building":
		case "completed":
		case "failed":
			return value;
		default:
			// Unknown status from a newer server — surface as `pending` rather than throwing,
			// matching the API guideline that clients treat undocumented enum values leniently.
			return "pending";
	}
}

/**
 * Whether an error from a Preview-feature read means the feature simply isn't available
 * for this project/branch/region (as opposed to a real, transient failure). Neon signals
 * this a few ways: a 404 "this route does not exist" (the route isn't deployed at all), or
 * a 503/4xx whose message says the platform feature is "not available" / "not enabled".
 *
 * Callers do **not** swallow this into an empty result — touching a Preview feature that
 * isn't available is surfaced as a {@link previewUnavailableError} so `plan` / `status` /
 * `pull` (and `neon dev`) fail clearly instead of, say, planning to create resources the
 * API will refuse to create.
 */
export function isPreviewFeatureUnavailable(err: unknown): boolean {
	if (!(err instanceof PlatformError)) return false;
	const status = err.details.status;
	const message =
		typeof err.details.neonMessage === "string"
			? err.details.neonMessage.toLowerCase()
			: "";
	const mentionsUnavailable =
		message.includes("not available") ||
		message.includes("does not exist") ||
		message.includes("not enabled");
	return (
		mentionsUnavailable &&
		(status === 503 || status === 404 || status === 501)
	);
}

/**
 * Reason phrase for the handful of HTTP statuses a Preview-feature read can surface as
 * "unavailable". Used to print a short `HTTP <status> <reason>` line (not a stack trace),
 * so the message reads like the API response the user would see in a tool like curl.
 */
const HTTP_STATUS_TEXT: Record<number, string> = {
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	500: "Internal Server Error",
	501: "Not Implemented",
	503: "Service Unavailable",
};

/** AWS region where Neon features are currently available in beta. */
const PLATFORM_BETA_REGION_ID = "aws-us-east-2";

const PLATFORM_BETA_REGION_GUIDANCE =
	"Neon features (Functions and Object Storage) are currently in beta and only available in the AWS US East (Ohio) region " +
	`(\`${PLATFORM_BETA_REGION_ID}\`); more regions are coming shortly. Run \`neon link\` to link or create a new project in that region.`;

const PLATFORM_BETA_REGION_GUIDANCE_SHORT =
	"Neon features are currently in beta and only available in the AWS US East (Ohio) region " +
	`(\`${PLATFORM_BETA_REGION_ID}\`); more regions are coming shortly. Run \`neon link\` to link or create a new project in that region.`;

/**
 * True when the Neon API body indicates the feature isn't deployed for this project's
 * region (as opposed to a transient 503 incident).
 */
function isRegionUnavailableNeonMessage(
	neonMessage: string | undefined,
): boolean {
	if (!neonMessage) return false;
	const lower = neonMessage.toLowerCase();
	return (
		lower.includes("not available for this region") ||
		lower.includes("not available for this project") ||
		lower.includes("platform functions not available") ||
		lower.includes("platform service not available")
	);
}

/**
 * Per-status guidance for a platform feature that came back "unavailable". These features
 * are currently in beta and rolling out region by region — today only in
 * {@link PLATFORM_BETA_REGION_ID} — so we tailor the next step instead of emitting one
 * catch-all:
 *
 * - 404 / 501, or an API message that names region/project unavailability — the route
 *   isn't deployed for this project's region: create a project in `aws-us-east-2`.
 * - 503 without a region-unavailable body — the route exists but is refusing right now;
 *   Neon may be having a transient incident. Retry; if it persists check neonstatus.com.
 * - anything else — point at the beta region requirement.
 *
 * Only statuses {@link isPreviewFeatureUnavailable} accepts (404/501/503) actually reach
 * this, so there is intentionally no 401/403 branch — those never classify as "unavailable".
 */
function platformFeatureUnavailableHint(
	status: number | undefined,
	neonMessage: string | undefined,
): string {
	if (
		isRegionUnavailableNeonMessage(neonMessage) ||
		status === 404 ||
		status === 501
	) {
		return PLATFORM_BETA_REGION_GUIDANCE;
	}
	if (status === 503) {
		return "The endpoint is reachable but refused the request — Neon may be having a transient incident. Retry shortly; if it keeps failing, check https://neonstatus.com and contact Neon support.";
	}
	return PLATFORM_BETA_REGION_GUIDANCE_SHORT;
}

/**
 * Convert a Preview-feature error into a clear {@link PlatformError} when the feature is
 * unavailable for the project; otherwise pass the original error through unchanged so a
 * genuine failure (auth, transient 5xx, …) keeps its specific code and message.
 *
 * The message names the failing feature, summarizes the response in one short
 * `HTTP <status> <reason>` line, includes the raw Neon API message + request id (valuable
 * signal while the feature is in beta), gives status-specific guidance (see
 * {@link platformFeatureUnavailableHint}), and offers removing the feature from the policy as an
 * escape hatch. `status`/`requestId` are also kept on `details` for programmatic consumers.
 */
export function previewUnavailableError(
	err: unknown,
	featureLabel: string,
): unknown {
	if (!isPreviewFeatureUnavailable(err)) return err;
	const details = err instanceof PlatformError ? err.details : {};
	const status =
		typeof details.status === "number" ? details.status : undefined;
	const neonMessage =
		typeof details.neonMessage === "string"
			? details.neonMessage
			: undefined;
	const requestId =
		typeof details.requestId === "string" ? details.requestId : undefined;

	// One short status line + the raw API message + request id — never a stack trace.
	const statusText = status ? HTTP_STATUS_TEXT[status] : undefined;
	const apiParts = [
		status
			? `HTTP ${status}${statusText ? ` ${statusText}` : ""}`
			: undefined,
		neonMessage ? `Neon API said: "${neonMessage}"` : undefined,
		requestId ? `request id ${requestId}` : undefined,
	].filter((part): part is string => part !== undefined);
	const apiContext = apiParts.length > 0 ? ` (${apiParts.join("; ")})` : "";

	return new PlatformError(
		ErrorCode.FeatureUnavailable,
		[
			`${featureLabel} isn't available for this Neon project${apiContext}.`,
			platformFeatureUnavailableHint(status, neonMessage),
			"If you don't need it, remove the corresponding feature from the `preview` block of your neon.ts and re-run.",
		].join(" "),
		{
			cause: err,
			details: {
				feature: featureLabel,
				...(status !== undefined ? { status } : {}),
				...(requestId !== undefined ? { requestId } : {}),
			},
		},
	);
}

function neonAuthResponseToSnapshot(
	data: z.infer<typeof neonAuthResponseSchema>,
): NeonAuthSnapshot {
	const snapshot: NeonAuthSnapshot = {
		projectId: data.auth_provider_project_id,
		jwksUrl: data.jwks_url,
	};
	if (data.pub_client_key !== undefined) {
		snapshot.publishableClientKey = data.pub_client_key;
	}
	if (data.secret_server_key !== undefined) {
		snapshot.secretServerKey = data.secret_server_key;
	}
	if (data.base_url) snapshot.baseUrl = data.base_url;
	return snapshot;
}

export function createNeonAuthRestInput(input: {
	databaseName?: string;
}): CreateNeonAuthRestInput {
	return {
		auth_provider: "better_auth",
		...(input.databaseName ? { database_name: input.databaseName } : {}),
	};
}

/**
 * Build the `multipart/form-data` body for a function deployment, matching the public
 * `FunctionDeployRequest` schema (`POST .../functions/{slug}/deployments`):
 *
 * - `zip` — the bundle as a binary part (named `bundle.zip`).
 * - `runtime` — the function runtime.
 * - `environment` — a single JSON-encoded string→string map (multipart can't carry a typed
 *   object part), omitted entirely when there are no env vars.
 *
 * Pure (no I/O) so it can be unit-tested against the spec without stubbing `fetch`.
 */
export function buildFunctionDeployForm(input: DeployFunctionInput): FormData {
	const form = new FormData();
	form.set(
		"zip",
		new Blob([input.bundle as BlobPart], { type: "application/zip" }),
		"bundle.zip",
	);
	form.set("runtime", input.runtime);
	if (Object.keys(input.environment).length > 0) {
		form.set("environment", JSON.stringify(input.environment));
	}
	return form;
}

/**
 * Read a response body as JSON, tolerating non-JSON. Some Neon routes return a plain-text
 * body (e.g. a 404 `"this route does not exist"` for a Preview feature not enabled in the
 * project/region). Parsing that with `JSON.parse` used to throw a cryptic
 * `SyntaxError: Unexpected token …`, which — because parsing happens before the `res.ok`
 * check in {@link request} — masked the real HTTP status. We instead return the raw text
 * wrapped as `{ message }` so the status-based error path in `request` / `wrapNeonError`
 * runs and produces a proper {@link PlatformError} (e.g. `NotFound`), and a non-error body
 * that simply isn't JSON degrades to text rather than crashing.
 */
export async function readJsonBody(res: Response): Promise<unknown> {
	const text = await res.text();
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return { message: text.trim() };
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
		protected: branch.protected === true,
	};
	if (branch.parent_id) snapshot.parentId = branch.parent_id;
	if (branch.expires_at) snapshot.expiresAt = branch.expires_at;
	return snapshot;
}

function endpointToSnapshot(endpoint: Endpoint): NeonEndpointSnapshot {
	return {
		id: endpoint.id,
		branchId: endpoint.branch_id,
		type: endpoint.type === "read_only" ? "read_only" : "read_write",
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
