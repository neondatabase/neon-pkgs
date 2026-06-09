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
import { z } from "zod";
import { formatSuspendTimeout, parseSuspendTimeout } from "./duration.js";
import { ErrorCode, PlatformError } from "./errors.js";
import type {
	CreateBranchInput,
	CreateBucketInput,
	CreateProjectInput,
	DeployFunctionInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBucketSnapshot,
	NeonDataApiSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionDeploymentSnapshot,
	NeonFunctionSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
	UpdateBranchInput,
} from "./neon-api.js";
import type { BucketAccessLevel, ComputeSettings } from "./types.js";
import { wrapNeonError } from "./wrap-neon-error.js";

type ApiClient = ReturnType<typeof createApiClient>;
const DEFAULT_NEON_API_BASE_URL = "https://console.neon.tech/api/v2";

const neonAuthResponseSchema = z.object({
	auth_provider_project_id: z.string(),
	pub_client_key: z.string().optional(),
	secret_server_key: z.string().optional(),
	jwks_url: z.string(),
	base_url: z.string().optional(),
});

// ─── Preview: buckets ──────────────────────────────────────────────────────

const bucketSchema = z.object({
	name: z.string(),
	access_level: z.string().optional(),
});
const bucketResponseSchema = z.object({ bucket: bucketSchema });
const bucketsListResponseSchema = z.object({ buckets: z.array(bucketSchema) });

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
const functionResponseSchema = z.object({ function: neonFunctionSchema });
const functionsListResponseSchema = z.object({
	functions: z.array(neonFunctionSchema),
});
const functionDeploymentResponseSchema = z.object({
	deployment: functionDeploymentSchema,
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
				...(input.protected !== undefined
					? { protected: input.protected }
					: {}),
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
		if (input.protected !== undefined) branch.protected = input.protected;
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
					const res = await this.client.getNeonAuth(
						projectId,
						branchId,
					);
					return neonAuthResponseToSnapshot(res.data);
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
					// TODO: switch back to `this.client.createNeonAuth` once
					// @neondatabase/api-client narrows this branch endpoint to `better_auth`.
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
	 * Upload a built function bundle via `multipart/form-data` to the deploy endpoint.
	 * Sends the bundle as the `file` field plus the deploy params Neon requires.
	 */
	private async postMultipart(
		path: string,
		input: DeployFunctionInput,
	): Promise<unknown> {
		const form = new FormData();
		form.set(
			"file",
			new Blob([input.bundle as BlobPart], {
				type: "application/zip",
			}),
			"bundle.zip",
		);
		// Keep concurrency internal for now. The API requires it, but the public
		// neon.ts config surface intentionally does not expose it yet.
		form.set("concurrency", "1");
		form.set("runtime", input.runtime);
		for (const [key, value] of Object.entries(input.environment)) {
			form.set(`environment[${key}]`, value);
		}
		return this.request("POST", path, { body: form });
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
				async () => {
					const res = await this.client.getProjectBranchDataApi(
						projectId,
						branchId,
						databaseName,
					);
					return { url: res.data.url };
				},
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
	): Promise<NeonDataApiSnapshot> {
		// Idempotent in the same shape as `enableNeonAuth`: if an integration already
		// exists, the POST returns 409 and we re-fetch the existing snapshot.
		try {
			return await this.call(
				`enableProjectBranchDataApi(${projectId}/${branchId}/${databaseName})`,
				async () => {
					const res = await this.client.createProjectBranchDataApi(
						projectId,
						branchId,
						databaseName,
						// Empty body — pick up Neon defaults (auth_provider inferred from
						// whether Neon Auth is also enabled; default schemas/grants).
						{},
					);
					return { url: res.data.url };
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

	async createBranchFunction(
		projectId: string,
		branchId: string,
		input: { slug: string; name: string },
	): Promise<NeonFunctionSnapshot> {
		return this.call(
			`createBranchFunction(${projectId}/${branchId}/${input.slug})`,
			async () => {
				const data = await this.postJson(
					branchPreviewPath(projectId, branchId, "functions"),
					{ slug: input.slug, name: input.name },
				);
				const parsed = functionResponseSchema.parse(data);
				return functionToSnapshot(parsed.function);
			},
			{ projectId, mutating: true },
		);
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
	// TODO(neon-deploy): the AI Gateway routes are not yet in the public API spec we wired
	// the rest of this adapter against. The paths below follow the established branch-scoped
	// convention (`/projects/{p}/branches/{b}/ai-gateway`); confirm them against the real
	// API (and the exact enable/disable verb + response shape) before relying on this in
	// production, and swap to the typed `@neondatabase/api-client` method once it exists.

	async getAiGatewayEnabled(
		projectId: string,
		branchId: string,
	): Promise<boolean> {
		try {
			return await this.call(
				`getAiGatewayEnabled(${projectId}/${branchId})`,
				async () => {
					const data = await this.getJson(
						aiGatewayPath(projectId, branchId),
					);
					return aiGatewayEnabledFromResponse(data);
				},
				{ projectId },
			);
		} catch (err) {
			// A "feature unavailable" signal (route not deployed / "not available")
			// is a hard error — surface it rather than reporting "disabled". A plain
			// NotFound *without* that signal means the route exists but AI Gateway is
			// simply not enabled on this branch, which is `false`.
			if (isPreviewFeatureUnavailable(err)) {
				throw previewUnavailableError(err, "AI Gateway");
			}
			if (
				err instanceof PlatformError &&
				err.code === ErrorCode.NotFound
			) {
				return false;
			}
			throw err;
		}
	}

	async enableAiGateway(projectId: string, branchId: string): Promise<void> {
		await this.call(
			`enableAiGateway(${projectId}/${branchId})`,
			async () => {
				await this.postJson(aiGatewayPath(projectId, branchId), {
					enabled: true,
				});
			},
			{ projectId, mutating: true },
		);
	}

	async disableAiGateway(projectId: string, branchId: string): Promise<void> {
		await this.call(
			`disableAiGateway(${projectId}/${branchId})`,
			async () => {
				await this.deleteJson(aiGatewayPath(projectId, branchId));
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

function aiGatewayPath(projectId: string, branchId: string): string {
	return `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/ai-gateway`;
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

function aiGatewayEnabledFromResponse(data: unknown): boolean {
	if (data !== null && typeof data === "object" && "enabled" in data) {
		return (data as { enabled?: unknown }).enabled === true;
	}
	return false;
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
 * Convert a Preview-feature error into a clear {@link PlatformError} when the feature is
 * unavailable for the project; otherwise pass the original error through unchanged so a
 * genuine failure (auth, transient 5xx, …) keeps its specific code and message.
 */
export function previewUnavailableError(
	err: unknown,
	featureLabel: string,
): unknown {
	if (!isPreviewFeatureUnavailable(err)) return err;
	const neonMessage =
		err instanceof PlatformError &&
		typeof err.details.neonMessage === "string"
			? ` (Neon API said: "${err.details.neonMessage}")`
			: "";
	return new PlatformError(
		ErrorCode.FeatureUnavailable,
		`${featureLabel} is a Preview feature that is not available for this project or region${neonMessage}. ` +
			"Enable it for your Neon account/project first, then re-run.",
		{ cause: err, details: { feature: featureLabel } },
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
