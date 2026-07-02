// Thin fetch-based client layer over `@neon/sdk` (the official, fetch-native
// Neon SDK). neonctl was originally built on the axios-based
// `@neondatabase/api-client`, whose generated `Api` object exposes one
// positional method per endpoint and resolves to an `AxiosResponse`. This module
// reproduces exactly the subset of `Api` methods neonctl uses, backed by the
// tree-shakeable `@neon/sdk/raw` functions, and returns a small
// `{ data, status, headers }` envelope the call sites destructure.
//
// On a non-2xx response (or a network/timeout failure) it throws a single typed
// {@link NeonApiError}; every call site narrows failures with
// {@link isNeonApiError} and reads `error.status` / `error.data`. There is no
// axios anywhere in neonctl: requests go through the global `fetch`, and this is
// the one place HTTP errors are shaped.

import { Readable } from "node:stream";
import * as raw from "@neon/sdk/raw";

import { type Client, createClient, createConfig } from "@neon/sdk/raw";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import { log } from "./log.js";
import pkg from "./pkg.js";

// Node's global `fetch` (undici) ignores HTTP_PROXY / HTTPS_PROXY / NO_PROXY,
// whereas the axios-based client neonctl used previously honored them. Restore
// that behaviour by installing a proxy-aware global dispatcher — but only when a
// proxy is actually configured, so the default (no-proxy) path stays untouched.
// This covers every `fetch` neonctl makes, including the direct S3 upload.
const PROXY_ENV_VARS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
];
if (PROXY_ENV_VARS.some((name) => process.env[name])) {
	setGlobalDispatcher(new EnvHttpProxyAgent());
}

export type ApiCallProps = {
	apiKey: string;
	apiHost?: string;
};

const DEFAULT_API_HOST = "https://console.neon.tech/api/v2";
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT = `neonctl v${pkg.version}`;

/** Mirrors the api-client `ContentType` enum used by the `request()` escape hatch. */
export enum ContentType {
	Json = "application/json",
	FormData = "multipart/form-data",
	UrlEncoded = "application/x-www-form-urlencoded",
	Text = "text/plain",
}

/**
 * The minimal response envelope neonctl relies on. Call sites only ever read
 * `.data`, and the object-storage download helper also reads `.headers`, so
 * those are the only fields we surface.
 */
export type ApiResponse<T> = {
	data: T;
	status: number;
	statusText: string;
	headers: Record<string, string>;
};

/** Result shape of every `@neon/sdk/raw` function in non-throwing mode. */
type RawResult<T> = {
	data?: T;
	error?: unknown;
	response?: Response;
	request?: Request;
};

/**
 * The single error type thrown by the neonctl API layer. It carries the HTTP
 * status and parsed body for a non-2xx response, or a `code` (e.g. `ETIMEDOUT`)
 * for a network/timeout failure. Call sites narrow with {@link isNeonApiError}
 * and read `status` / `data` rather than reaching into an axios-shaped object.
 */
export class NeonApiError extends Error {
	readonly status?: number;
	readonly statusText?: string;
	/** The parsed response body (object for JSON, string for non-JSON). */
	readonly data?: unknown;
	readonly headers?: Record<string, string>;
	/** The request path, for debug logging. */
	readonly requestPath?: string;
	/** A non-HTTP failure code, e.g. `ETIMEDOUT` for a request timeout. */
	readonly code?: string;

	constructor(
		message: string,
		init: {
			status?: number;
			statusText?: string;
			data?: unknown;
			headers?: Record<string, string>;
			requestPath?: string;
			code?: string;
		} = {},
	) {
		super(message);
		this.name = "NeonApiError";
		this.status = init.status;
		this.statusText = init.statusText;
		this.data = init.data;
		this.headers = init.headers;
		this.requestPath = init.requestPath;
		this.code = init.code;
	}
}

/** Narrow an unknown error to a {@link NeonApiError}. */
export function isNeonApiError(err: unknown): err is NeonApiError {
	return err instanceof NeonApiError;
}

/** Extract a `message` string from a parsed error body, if present. */
export function messageFromBody(body: unknown): string | undefined {
	if (body && typeof body === "object" && "message" in body) {
		const message = body.message;
		if (typeof message === "string") return message;
	}
	return undefined;
}

/** Extract a machine-readable `code` string from a parsed error body, if present. */
export function codeFromBody(body: unknown): string | undefined {
	if (body && typeof body === "object" && "code" in body) {
		const code = body.code;
		if (typeof code === "string") return code;
	}
	return undefined;
}

/**
 * Adapt a WHATWG `ReadableStream` (what `fetch` gives us as `response.body`) to
 * a Node `Readable`, so callers can `pipeline()` the body straight to disk. Done
 * by hand rather than `Readable.fromWeb` to sidestep the DOM-vs-`node:stream/web`
 * `ReadableStream` type friction without an unsafe cast.
 */
function webStreamToNodeReadable(body: ReadableStream<Uint8Array>): Readable {
	const reader = body.getReader();
	return new Readable({
		async read() {
			try {
				const { done, value } = await reader.read();
				this.push(done ? null : Buffer.from(value));
			} catch (err) {
				this.destroy(
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		},
	});
}

function headersToObject(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

function isAbortError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" || err.name === "TimeoutError")
	);
}

/**
 * Walk an error's `cause` chain to find the underlying socket/DNS `code` (e.g.
 * `ECONNREFUSED`, `ENOTFOUND`) — `fetch` surfaces these as the `cause` of a bare
 * `TypeError: fetch failed`. Preserving the code lets `isNetworkError` classify
 * the resulting {@link NeonApiError} as a connectivity failure.
 */
function readSocketCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let depth = 0; depth < 6 && current != null; depth++) {
		if (typeof current === "object" && "code" in current) {
			const code = (current as { code?: unknown }).code;
			if (typeof code === "string") return code;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** Build a {@link NeonApiError} from a non-2xx `Response` and its parsed body. */
function httpError(response: Response, body: unknown): NeonApiError {
	let requestPath: string | undefined;
	try {
		requestPath = new URL(response.url).pathname;
	} catch {
		// response.url may be empty in some runtimes; the path is best-effort.
	}
	return new NeonApiError(
		messageFromBody(body) ??
			`Request failed with status code ${response.status}`,
		{
			status: response.status,
			statusText: response.statusText,
			data: body,
			headers: headersToObject(response.headers),
			requestPath,
		},
	);
}

/**
 * Translate a thrown `fetch` failure into a {@link NeonApiError}. A request
 * timeout uses `ECONNABORTED` (matching the old axios behaviour, and excluded
 * from `isNetworkError`'s connectivity codes so it's still reported as a
 * timeout). A connection failure keeps its real socket code (e.g.
 * `ECONNREFUSED`) so `isNetworkError` recognises it as a connectivity problem.
 */
function networkError(err: unknown): NeonApiError {
	if (isAbortError(err)) {
		return new NeonApiError("Request timed out", { code: "ECONNABORTED" });
	}
	return new NeonApiError(err instanceof Error ? err.message : String(err), {
		code: readSocketCode(err) ?? "ENETWORK",
	});
}

/**
 * `fetch` with neonctl's request timeout applied (preserving any caller signal)
 * and lightweight debug logging of the request line + response status — the
 * fetch-native replacement for the old `axios-debug-log` wiring.
 */
const timedFetch: typeof fetch = async (input, init) => {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = init?.signal
		? AbortSignal.any([init.signal, timeout])
		: timeout;
	const method =
		init?.method ?? (input instanceof Request ? input.method : "GET");
	const url = input instanceof Request ? input.url : String(input);
	log.debug("%s %s", method.toUpperCase(), url);
	const response = await fetch(input, { ...init, signal });
	log.debug("%d %s", response.status, response.statusText);
	return response;
};

const RETRY_COUNT = 5;
const RETRY_DELAY = 3000;

/**
 * Retry a call while the API answers 423 (Locked) — Neon's "a prior mutation on
 * this resource is still in flight" signal.
 */
export const retryOnLock = async <T>(fn: () => Promise<T>): Promise<T> => {
	let attempt = 0;
	let errOut: unknown;
	while (attempt < RETRY_COUNT) {
		try {
			return await fn();
		} catch (err) {
			errOut = err;
			if (isNeonApiError(err) && err.status === 423) {
				attempt++;
				log.info(
					`Resource is locked. Waiting ${RETRY_DELAY}ms before retrying...`,
				);
				await new Promise((resolve) =>
					setTimeout(resolve, RETRY_DELAY),
				);
			} else {
				throw err;
			}
		}
	}
	throw errOut;
};

function buildUrl(
	apiHost: string,
	path: string,
	query?: Record<string, QueryValue>,
): string {
	const url = new URL(
		`${apiHost.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`,
	);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null) continue;
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}

async function readJsonBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text.trim() === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// Match axios' `responseType: 'json'` behaviour: a body that isn't valid
		// JSON is surfaced as the raw string rather than coerced into an object, so
		// callers' `body?.message` checks correctly see "no structured message".
		return text;
	}
}

/** A single query-string parameter value (serialized via `String()`). */
type QueryValue = string | number | boolean | null | undefined;

/** Parameters accepted by the low-level `request()` escape hatch. */
export type RequestParams = {
	path: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	query?: Record<string, QueryValue>;
	body?: unknown;
	type?: ContentType;
	format?: "json" | "stream";
	secure?: boolean;
	/**
	 * Extra request headers, merged on top of the defaults (`User-Agent`,
	 * `Authorization`, and `Content-Type`). Later keys win, so callers can
	 * override any default when they need to.
	 */
	headers?: Record<string, string>;
};

export const getApiClient = ({ apiKey, apiHost }: ApiCallProps) => {
	const baseUrl = apiHost ?? DEFAULT_API_HOST;
	const client: Client = createClient(
		createConfig({
			auth: () => apiKey,
			baseUrl,
			fetch: timedFetch,
			headers: { "User-Agent": USER_AGENT },
		}),
	);

	/** Await a raw call, unwrap to a `{ data, status, headers }` envelope, or throw {@link NeonApiError}. */
	async function call<T>(
		run: () => Promise<RawResult<T>>,
	): Promise<ApiResponse<T>> {
		let result: RawResult<T>;
		try {
			result = await run();
		} catch (err) {
			throw networkError(err);
		}
		const response = result.response;
		if (!response) {
			throw networkError(
				result.error ?? new Error("No response from Neon API"),
			);
		}
		if (!response.ok) {
			throw httpError(response, result.error ?? result.data);
		}
		return {
			data: result.data as T,
			status: response.status,
			statusText: response.statusText,
			headers: headersToObject(response.headers),
		};
	}

	/**
	 * Low-level request used by the object-storage and functions helpers for
	 * endpoints not (yet) modeled as typed SDK functions. Mirrors the api-client
	 * `HttpClient.request()`: `format: 'json'` parses the body, `format: 'stream'`
	 * returns a Node `Readable`, and `type: ContentType.FormData` sends multipart.
	 */
	async function request<T = unknown>(
		params: RequestParams,
	): Promise<ApiResponse<T>> {
		const url = buildUrl(baseUrl, params.path, params.query);
		const headers: Record<string, string> = { "User-Agent": USER_AGENT };
		if (params.secure !== false) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		let payload: BodyInit | undefined;
		if (
			params.body instanceof FormData ||
			params.type === ContentType.FormData
		) {
			payload = params.body as BodyInit;
		} else if (params.body !== undefined) {
			headers["Content-Type"] = ContentType.Json;
			payload = JSON.stringify(params.body);
		}

		// Caller-supplied headers win over the defaults set above.
		if (params.headers) {
			for (const [key, value] of Object.entries(params.headers)) {
				headers[key] = value;
			}
		}

		let response: Response;
		try {
			response = await timedFetch(url, {
				method: params.method,
				headers,
				...(payload !== undefined ? { body: payload } : {}),
			});
		} catch (err) {
			throw networkError(err);
		}

		if (!response.ok) {
			// For a streamed download the error body arrives as a stream too; hand it
			// back as a Node `Readable` so the caller can drain it for a message.
			const errorBody =
				params.format === "stream" && response.body
					? webStreamToNodeReadable(response.body)
					: await readJsonBody(response);
			throw httpError(response, errorBody);
		}

		let data: unknown;
		if (params.format === "stream") {
			data = response.body
				? webStreamToNodeReadable(response.body)
				: undefined;
		} else {
			data = await readJsonBody(response);
		}
		return {
			data: data as T,
			status: response.status,
			statusText: response.statusText,
			headers: headersToObject(response.headers),
		};
	}

	return {
		request,

		// ─── Account / user ──────────────────────────────────────────────────
		getCurrentUserInfo: () =>
			call(() => raw.getCurrentUserInfo({ client })),
		getCurrentUserOrganizations: () =>
			call(() => raw.getCurrentUserOrganizations({ client })),
		getAuthDetails: () => call(() => raw.getAuthDetails({ client })),
		getActiveRegions: () => call(() => raw.getActiveRegions({ client })),

		// ─── Projects ────────────────────────────────────────────────────────
		listProjects: (
			query: NonNullable<raw.ListProjectsData["query"]> = {},
		) => call(() => raw.listProjects({ client, query })),
		listSharedProjects: (
			query: NonNullable<raw.ListProjectsData["query"]> = {},
		) =>
			call(() =>
				raw.listSharedProjects({
					client,
					query: {
						...(query.cursor !== undefined
							? { cursor: query.cursor }
							: {}),
						...(query.limit !== undefined
							? { limit: query.limit }
							: {}),
						...(query.search !== undefined
							? { search: query.search }
							: {}),
					},
				}),
			),
		getProject: (projectId: string) =>
			call(() =>
				raw.getProject({ client, path: { project_id: projectId } }),
			),
		createProject: (data: NonNullable<raw.CreateProjectData["body"]>) =>
			call(() => raw.createProject({ client, body: data })),
		updateProject: (
			projectId: string,
			data: NonNullable<raw.UpdateProjectData["body"]>,
		) =>
			call(() =>
				raw.updateProject({
					client,
					path: { project_id: projectId },
					body: data,
				}),
			),
		deleteProject: (projectId: string) =>
			call(() =>
				raw.deleteProject({ client, path: { project_id: projectId } }),
			),
		recoverProject: (projectId: string) =>
			call(() =>
				raw.recoverProject({ client, path: { project_id: projectId } }),
			),
		listProjectOperations: ({
			projectId,
			...query
		}: { projectId: string } & NonNullable<
			raw.ListProjectOperationsData["query"]
		>) =>
			call(() =>
				raw.listProjectOperations({
					client,
					path: { project_id: projectId },
					query,
				}),
			),

		// ─── Branches ────────────────────────────────────────────────────────
		listProjectBranches: ({
			projectId,
			...query
		}: { projectId: string } & NonNullable<
			raw.ListProjectBranchesData["query"]
		>) =>
			call(() =>
				raw.listProjectBranches({
					client,
					path: { project_id: projectId },
					query,
				}),
			),
		createProjectBranch: (
			projectId: string,
			data?: raw.CreateProjectBranchData["body"],
		) =>
			call(() =>
				raw.createProjectBranch({
					client,
					path: { project_id: projectId },
					...(data !== undefined ? { body: data } : {}),
				}),
			),
		getProjectBranch: (projectId: string, branchId: string) =>
			call(() =>
				raw.getProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		updateProjectBranch: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.UpdateProjectBranchData["body"]>,
		) =>
			call(() =>
				raw.updateProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		deleteProjectBranch: (projectId: string, branchId: string) =>
			call(() =>
				raw.deleteProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		restoreProjectBranch: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.RestoreProjectBranchData["body"]>,
		) =>
			call(() =>
				raw.restoreProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		setDefaultProjectBranch: (projectId: string, branchId: string) =>
			call(() =>
				raw.setDefaultProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		getProjectBranchSchema: ({
			projectId,
			branchId,
			...query
		}: { projectId: string; branchId: string } & NonNullable<
			raw.GetProjectBranchSchemaData["query"]
		>) =>
			call(() =>
				raw.getProjectBranchSchema({
					client,
					path: { project_id: projectId, branch_id: branchId },
					query,
				}),
			),
		listProjectBranchEndpoints: (projectId: string, branchId: string) =>
			call(() =>
				raw.listProjectBranchEndpoints({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		createProjectEndpoint: (
			projectId: string,
			data: NonNullable<raw.CreateProjectEndpointData["body"]>,
		) =>
			call(() =>
				raw.createProjectEndpoint({
					client,
					path: { project_id: projectId },
					body: data,
				}),
			),

		// ─── Databases ───────────────────────────────────────────────────────
		listProjectBranchDatabases: (projectId: string, branchId: string) =>
			call(() =>
				raw.listProjectBranchDatabases({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		createProjectBranchDatabase: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.CreateProjectBranchDatabaseData["body"]>,
		) =>
			call(() =>
				raw.createProjectBranchDatabase({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		deleteProjectBranchDatabase: (
			projectId: string,
			branchId: string,
			databaseName: string,
		) =>
			call(() =>
				raw.deleteProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
				}),
			),

		// ─── Roles ───────────────────────────────────────────────────────────
		listProjectBranchRoles: (projectId: string, branchId: string) =>
			call(() =>
				raw.listProjectBranchRoles({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		createProjectBranchRole: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.CreateProjectBranchRoleData["body"]>,
		) =>
			call(() =>
				raw.createProjectBranchRole({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		deleteProjectBranchRole: (
			projectId: string,
			branchId: string,
			roleName: string,
		) =>
			call(() =>
				raw.deleteProjectBranchRole({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: roleName,
					},
				}),
			),
		getProjectBranchRolePassword: (
			projectId: string,
			branchId: string,
			roleName: string,
		) =>
			call(() =>
				raw.getProjectBranchRolePassword({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: roleName,
					},
				}),
			),

		// ─── Data API ────────────────────────────────────────────────────────
		createProjectBranchDataApi: (
			projectId: string,
			branchId: string,
			databaseName: string,
			data: NonNullable<raw.CreateProjectBranchDataApiData["body"]>,
		) =>
			call(() =>
				raw.createProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					body: data,
				}),
			),
		updateProjectBranchDataApi: (
			projectId: string,
			branchId: string,
			databaseName: string,
			data: NonNullable<raw.UpdateProjectBranchDataApiData["body"]>,
		) =>
			call(() =>
				raw.updateProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					body: data,
				}),
			),
		deleteProjectBranchDataApi: (
			projectId: string,
			branchId: string,
			databaseName: string,
		) =>
			call(() =>
				raw.deleteProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
				}),
			),
		getProjectBranchDataApi: (
			projectId: string,
			branchId: string,
			databaseName: string,
		) =>
			call(() =>
				raw.getProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
				}),
			),

		// ─── VPC endpoints (project + organization) ──────────────────────────
		listProjectVpcEndpoints: (projectId: string) =>
			call(() =>
				raw.listProjectVpcEndpoints({
					client,
					path: { project_id: projectId },
				}),
			),
		assignProjectVpcEndpoint: (
			projectId: string,
			vpcEndpointId: string,
			data: NonNullable<raw.AssignProjectVpcEndpointData["body"]>,
		) =>
			call(() =>
				raw.assignProjectVpcEndpoint({
					client,
					path: {
						project_id: projectId,
						vpc_endpoint_id: vpcEndpointId,
					},
					body: data,
				}),
			),
		deleteProjectVpcEndpoint: (projectId: string, vpcEndpointId: string) =>
			call(() =>
				raw.deleteProjectVpcEndpoint({
					client,
					path: {
						project_id: projectId,
						vpc_endpoint_id: vpcEndpointId,
					},
				}),
			),
		listOrganizationVpcEndpoints: (orgId: string, regionId: string) =>
			call(() =>
				raw.listOrganizationVpcEndpoints({
					client,
					path: { org_id: orgId, region_id: regionId },
				}),
			),
		getOrganizationVpcEndpointDetails: (
			orgId: string,
			regionId: string,
			vpcEndpointId: string,
		) =>
			call(() =>
				raw.getOrganizationVpcEndpointDetails({
					client,
					path: {
						org_id: orgId,
						region_id: regionId,
						vpc_endpoint_id: vpcEndpointId,
					},
				}),
			),
		assignOrganizationVpcEndpoint: (
			orgId: string,
			regionId: string,
			vpcEndpointId: string,
			data: NonNullable<raw.AssignOrganizationVpcEndpointData["body"]>,
		) =>
			call(() =>
				raw.assignOrganizationVpcEndpoint({
					client,
					path: {
						org_id: orgId,
						region_id: regionId,
						vpc_endpoint_id: vpcEndpointId,
					},
					body: data,
				}),
			),
		deleteOrganizationVpcEndpoint: (
			orgId: string,
			regionId: string,
			vpcEndpointId: string,
		) =>
			call(() =>
				raw.deleteOrganizationVpcEndpoint({
					client,
					path: {
						org_id: orgId,
						region_id: regionId,
						vpc_endpoint_id: vpcEndpointId,
					},
				}),
			),

		// ─── Neon Auth ───────────────────────────────────────────────────────
		getNeonAuth: (projectId: string, branchId: string) =>
			call(() =>
				raw.getNeonAuth({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		createNeonAuth: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.CreateNeonAuthData["body"]>,
		) =>
			call(() =>
				raw.createNeonAuth({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		disableNeonAuth: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.DisableNeonAuthData["body"]>,
		) =>
			call(() =>
				raw.disableNeonAuth({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		listBranchNeonAuthOauthProviders: (
			projectId: string,
			branchId: string,
		) =>
			call(() =>
				raw.listBranchNeonAuthOauthProviders({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		addBranchNeonAuthOauthProvider: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.AddBranchNeonAuthOauthProviderData["body"]>,
		) =>
			call(() =>
				raw.addBranchNeonAuthOauthProvider({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		updateBranchNeonAuthOauthProvider: (
			projectId: string,
			branchId: string,
			oauthProviderId: raw.NeonAuthOauthProviderId,
			data: NonNullable<
				raw.UpdateBranchNeonAuthOauthProviderData["body"]
			>,
		) =>
			call(() =>
				raw.updateBranchNeonAuthOauthProvider({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						oauth_provider_id: oauthProviderId,
					},
					body: data,
				}),
			),
		deleteBranchNeonAuthOauthProvider: (
			projectId: string,
			branchId: string,
			oauthProviderId: raw.NeonAuthOauthProviderId,
		) =>
			call(() =>
				raw.deleteBranchNeonAuthOauthProvider({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						oauth_provider_id: oauthProviderId,
					},
				}),
			),
		listBranchNeonAuthTrustedDomains: (
			projectId: string,
			branchId: string,
		) =>
			call(() =>
				raw.listBranchNeonAuthTrustedDomains({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		addBranchNeonAuthTrustedDomain: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.AddBranchNeonAuthTrustedDomainData["body"]>,
		) =>
			call(() =>
				raw.addBranchNeonAuthTrustedDomain({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		deleteBranchNeonAuthTrustedDomain: (
			projectId: string,
			branchId: string,
			data: NonNullable<
				raw.DeleteBranchNeonAuthTrustedDomainData["body"]
			>,
		) =>
			call(() =>
				raw.deleteBranchNeonAuthTrustedDomain({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		getNeonAuthAllowLocalhost: (projectId: string, branchId: string) =>
			call(() =>
				raw.getNeonAuthAllowLocalhost({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		updateNeonAuthAllowLocalhost: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.UpdateNeonAuthAllowLocalhostData["body"]>,
		) =>
			call(() =>
				raw.updateNeonAuthAllowLocalhost({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		getNeonAuthEmailAndPasswordConfig: (
			projectId: string,
			branchId: string,
		) =>
			call(() =>
				raw.getNeonAuthEmailAndPasswordConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		updateNeonAuthEmailAndPasswordConfig: (
			projectId: string,
			branchId: string,
			data: NonNullable<
				raw.UpdateNeonAuthEmailAndPasswordConfigData["body"]
			>,
		) =>
			call(() =>
				raw.updateNeonAuthEmailAndPasswordConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		getNeonAuthEmailProvider: (projectId: string, branchId: string) =>
			call(() =>
				raw.getNeonAuthEmailProvider({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		updateNeonAuthEmailProvider: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.UpdateNeonAuthEmailProviderData["body"]>,
		) =>
			call(() =>
				raw.updateNeonAuthEmailProvider({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		sendNeonAuthTestEmail: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.SendNeonAuthTestEmailData["body"]>,
		) =>
			call(() =>
				raw.sendNeonAuthTestEmail({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		getNeonAuthPluginConfigs: (projectId: string, branchId: string) =>
			call(() =>
				raw.getNeonAuthPluginConfigs({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		updateNeonAuthOrganizationPlugin: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.UpdateNeonAuthOrganizationPluginData["body"]>,
		) =>
			call(() =>
				raw.updateNeonAuthOrganizationPlugin({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		getNeonAuthWebhookConfig: (projectId: string, branchId: string) =>
			call(() =>
				raw.getNeonAuthWebhookConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
				}),
			),
		updateNeonAuthWebhookConfig: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.UpdateNeonAuthWebhookConfigData["body"]>,
		) =>
			call(() =>
				raw.updateNeonAuthWebhookConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		createBranchNeonAuthNewUser: (
			projectId: string,
			branchId: string,
			data: NonNullable<raw.CreateBranchNeonAuthNewUserData["body"]>,
		) =>
			call(() =>
				raw.createBranchNeonAuthNewUser({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: data,
				}),
			),
		deleteBranchNeonAuthUser: (
			projectId: string,
			branchId: string,
			authUserId: string,
		) =>
			call(() =>
				raw.deleteBranchNeonAuthUser({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						auth_user_id: authUserId,
					},
				}),
			),
		updateNeonAuthUserRole: (
			projectId: string,
			branchId: string,
			authUserId: string,
			data: NonNullable<raw.UpdateNeonAuthUserRoleData["body"]>,
		) =>
			call(() =>
				raw.updateNeonAuthUserRole({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						auth_user_id: authUserId,
					},
					body: data,
				}),
			),
	};
};

/** The neonctl API client — a thin fetch-based façade over `@neon/sdk`. */
export type NeonApiClient = ReturnType<typeof getApiClient>;
