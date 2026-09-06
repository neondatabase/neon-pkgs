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
import { type Paginated, paginate } from "../paginate.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = EndpointCreateRequest["endpoint"];
type UpdateInput = EndpointUpdateRequest["endpoint"];

/** Compute endpoint resource (project-scoped). */
export class Endpoints<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/endpoints */
	list(
		projectId: string,
		query?: { branchId?: string },
		opts?: CallOptions,
	): Paginated<Endpoint> {
		const branchId = query?.branchId;
		return paginate(
			(_cursor, signal) =>
				branchId === undefined
					? listProjectEndpoints({
							client: this.#ctx.client,
							path: { project_id: projectId },
							throwOnError: false,
							signal,
						})
					: listProjectBranchEndpoints({
							client: this.#ctx.client,
							path: {
								project_id: projectId,
								branch_id: branchId,
							},
							throwOnError: false,
							signal,
						}),
			(data) => ({ items: data?.endpoints ?? [] }),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/endpoints/{endpoint_id} */
	get(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	get(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
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
	create(
		projectId: string,
		input: CreateInput,
	): Promise<Outcome<Endpoint, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		input: CreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	create(
		projectId: string,
		input: CreateInput,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
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
	update(
		projectId: string,
		endpointId: string,
		input: UpdateInput,
	): Promise<Outcome<Endpoint, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	update(
		projectId: string,
		endpointId: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
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
	delete(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
	start(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	start<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	start(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
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
	suspend(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	suspend<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	suspend(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
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
	restart(
		projectId: string,
		endpointId: string,
	): Promise<Outcome<Endpoint, DThrow>>;
	restart<Throw extends boolean = DThrow>(
		projectId: string,
		endpointId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Endpoint, Throw>>;
	restart(
		projectId: string,
		endpointId: string,
		opts?: CallOptions,
	): Promise<Endpoint | NeonResult<Endpoint>> {
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
