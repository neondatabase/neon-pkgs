import {
	createProjectEndpoint,
	deleteProjectEndpoint,
	getProjectEndpoint,
	listProjectBranchEndpoints,
	listProjectEndpoints,
	restartProjectEndpoint,
	startProjectEndpoint,
	suspendProjectEndpoint,
	updateProjectEndpoint,
} from "../../client/sdk.gen.js";
import type {
	Endpoint,
	EndpointCreateRequest,
	EndpointUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = EndpointCreateRequest["endpoint"];
type UpdateInput = EndpointUpdateRequest["endpoint"];

export type EndpointsListParams = {
	projectId: string;
};

export type EndpointsListByBranchParams = EndpointsListParams & {
	branchId: string;
};

export type EndpointsGetParams = EndpointsListParams & {
	endpointId: string;
};

export type EndpointsCreateParams = EndpointsListParams & CreateInput;

export type EndpointsUpdateParams = EndpointsGetParams & UpdateInput;

export type EndpointsDeleteParams = EndpointsGetParams;

export type EndpointsStartParams = EndpointsGetParams;

export type EndpointsSuspendParams = EndpointsGetParams;

export type EndpointsRestartParams = EndpointsGetParams;

/** Compute endpoint resource (project-scoped). */
export class Endpoints<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/endpoints */
	list(params: EndpointsListParams): Promise<Outcome<Endpoint[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: EndpointsListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint[], Throw>>;
	list(
		params: EndpointsListParams,
		opts?: CallOptions,
	): Promise<Endpoint[] | NeonResult<Endpoint[]>> {
		const invalid = validateParams(params, "endpoints.list", {
			projectId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectEndpoints({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoints,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/endpoints */
	listByBranch(
		params: EndpointsListByBranchParams,
	): Promise<Outcome<Endpoint[], DThrow>>;
	listByBranch<Throw extends boolean = DThrow>(
		params: EndpointsListByBranchParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint[], Throw>>;
	listByBranch(
		params: EndpointsListByBranchParams,
		opts?: CallOptions,
	): Promise<Endpoint[] | NeonResult<Endpoint[]>> {
		const invalid = validateParams(params, "endpoints.listByBranch", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchEndpoints({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoints,
		);
	}

	/** @apiCall GET /projects/{project_id}/endpoints/{endpoint_id} */
	get(params: EndpointsGetParams): Promise<Outcome<Endpoint, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: EndpointsGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	get(
		params: EndpointsGetParams,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		const invalid = validateParams(params, "endpoints.get", {
			projectId: "string",
			endpointId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, endpointId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints */
	create(params: EndpointsCreateParams): Promise<Outcome<Endpoint, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: EndpointsCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	create(
		params: EndpointsCreateParams,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		const invalid = validateParams(params, "endpoints.create", {
			projectId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectEndpoint({
					client,
					path: { project_id: projectId },
					body: { endpoint: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/endpoints/{endpoint_id} */
	update(params: EndpointsUpdateParams): Promise<Outcome<Endpoint, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: EndpointsUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	update(
		params: EndpointsUpdateParams,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		const invalid = validateParams(params, "endpoints.update", {
			projectId: "string",
			endpointId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, endpointId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					body: { endpoint: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/endpoints/{endpoint_id} */
	delete(params: EndpointsDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: EndpointsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: EndpointsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "endpoints.delete", {
			projectId: "string",
			endpointId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, endpointId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectEndpoint({
				client,
				path: { project_id: projectId, endpoint_id: endpointId },
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints/{endpoint_id}/start */
	start(params: EndpointsStartParams): Promise<Outcome<Endpoint, DThrow>>;
	start<Throw extends boolean = DThrow>(
		params: EndpointsStartParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	start(
		params: EndpointsStartParams,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		const invalid = validateParams(params, "endpoints.start", {
			projectId: "string",
			endpointId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, endpointId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				startProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints/{endpoint_id}/suspend */
	suspend(params: EndpointsSuspendParams): Promise<Outcome<Endpoint, DThrow>>;
	suspend<Throw extends boolean = DThrow>(
		params: EndpointsSuspendParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	suspend(
		params: EndpointsSuspendParams,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		const invalid = validateParams(params, "endpoints.suspend", {
			projectId: "string",
			endpointId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, endpointId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				suspendProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}

	/** @apiCall POST /projects/{project_id}/endpoints/{endpoint_id}/restart */
	restart(params: EndpointsRestartParams): Promise<Outcome<Endpoint, DThrow>>;
	restart<Throw extends boolean = DThrow>(
		params: EndpointsRestartParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	restart(
		params: EndpointsRestartParams,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
		const invalid = validateParams(params, "endpoints.restart", {
			projectId: "string",
			endpointId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Endpoint>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, endpointId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				restartProjectEndpoint({
					client,
					path: { project_id: projectId, endpoint_id: endpointId },
					throwOnError: false,
					signal,
				}),
			(data) => data.endpoint,
		);
	}
}
