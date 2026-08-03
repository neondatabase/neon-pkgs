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
import type { NeonResult, Outcome } from "../result.js";

/** Neon Data API resource (branch + database scoped). */
export class DataApi<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/data-api/{database_name} */
	get(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<Outcome<DataApiReponse, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		databaseName: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<DataApiReponse, Throw>>;
	get(
		projectId: string,
		branchId: string,
		databaseName: string,
		opts?: CallOptions,
	): Promise<DataApiReponse | NeonResult<DataApiReponse>> {
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
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: DataApiCreateRequest,
	): Promise<Outcome<DataApiCreateResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		databaseName: string,
		input: DataApiCreateRequest | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<DataApiCreateResponse, Throw>>;
	create(
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: DataApiCreateRequest,
		opts?: CallOptions,
	): Promise<DataApiCreateResponse | NeonResult<DataApiCreateResponse>> {
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
	update(
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: DataApiUpdateRequest,
	): Promise<Outcome<void, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		databaseName: string,
		input: DataApiUpdateRequest | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	update(
		projectId: string,
		branchId: string,
		databaseName: string,
		input?: DataApiUpdateRequest,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
	delete(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		databaseName: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		databaseName: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
