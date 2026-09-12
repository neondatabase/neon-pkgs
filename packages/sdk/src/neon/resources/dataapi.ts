import {
	createProjectBranchDataApi,
	deleteProjectBranchDataApi,
	getProjectBranchDataApi,
	updateProjectBranchDataApi,
} from "../../client/sdk.gen.js";
import type {
	DataApiCreateRequest,
	DataApiCreateResponse,
	DataApiReponse,
	DataApiUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type DataApiSelectors = {
	projectId: string;
	branchId: string;
	databaseName: string;
};

export type DataApiGetParams = DataApiSelectors;

export type DataApiCreateParams = DataApiSelectors & DataApiCreateRequest;

export type DataApiUpdateParams = DataApiSelectors & DataApiUpdateRequest;

export type DataApiDeleteParams = DataApiSelectors;

/** Neon Data API resource (branch + database scoped). */
export class DataApi<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/data-api/{database_name} */
	get(params: DataApiGetParams): Promise<Outcome<DataApiReponse, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: DataApiGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<DataApiReponse, Throw>>;
	get(
		params: DataApiGetParams,
		opts?: CallOptions,
	): Promise<DataApiReponse | NeonResult<DataApiReponse>> {
		const invalid = validateParams(params, "dataApi.get", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (invalid) {
			return invalidParamsResult<DataApiReponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, databaseName } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/data-api/{database_name} */
	create(
		params: DataApiCreateParams,
	): Promise<Outcome<DataApiCreateResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: DataApiCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<DataApiCreateResponse, Throw>>;
	create(
		params: DataApiCreateParams,
		opts?: CallOptions,
	): Promise<DataApiCreateResponse | NeonResult<DataApiCreateResponse>> {
		const invalid = validateParams(params, "dataApi.create", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (invalid) {
			return invalidParamsResult<DataApiCreateResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, databaseName, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/data-api/{database_name} */
	update(params: DataApiUpdateParams): Promise<Outcome<void, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: DataApiUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	update(
		params: DataApiUpdateParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "dataApi.update", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, databaseName, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/data-api/{database_name} */
	delete(params: DataApiDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: DataApiDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: DataApiDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "dataApi.delete", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, databaseName } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				deleteProjectBranchDataApi({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}
}
