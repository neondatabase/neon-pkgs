import {
	createProjectBranchDatabase,
	deleteProjectBranchDatabase,
	getProjectBranchDatabase,
	listProjectBranchDatabases,
	updateProjectBranchDatabase,
} from "../../client/sdk.gen.js";
import type {
	Database,
	DatabaseCreateRequest,
	DatabaseUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = DatabaseCreateRequest["database"];
type UpdateInput = DatabaseUpdateRequest["database"];

export type DatabasesListParams = {
	projectId: string;
	branchId: string;
};

export type DatabasesGetParams = DatabasesListParams & {
	databaseName: string;
};

export type DatabasesCreateParams = DatabasesListParams & CreateInput;

export type DatabasesUpdateParams = DatabasesGetParams & UpdateInput;

export type DatabasesDeleteParams = DatabasesGetParams;

/** Database resource (branch-scoped). */
export class Databases<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/databases */
	list(params: DatabasesListParams): Promise<Outcome<Database[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: DatabasesListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database[], Throw>>;
	list(
		params: DatabasesListParams,
		opts?: CallOptions,
	): Promise<Database[] | NeonResult<Database[]>> {
		const invalid = validateParams(params, "databases.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Database[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchDatabases({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.databases,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	get(params: DatabasesGetParams): Promise<Outcome<Database, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: DatabasesGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	get(
		params: DatabasesGetParams,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		const invalid = validateParams(params, "databases.get", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (invalid) {
			return invalidParamsResult<Database>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, databaseName } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/databases */
	create(params: DatabasesCreateParams): Promise<Outcome<Database, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: DatabasesCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	create(
		params: DatabasesCreateParams,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		const invalid = validateParams(params, "databases.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Database>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchDatabase({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { database: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	update(params: DatabasesUpdateParams): Promise<Outcome<Database, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: DatabasesUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	update(
		params: DatabasesUpdateParams,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		const invalid = validateParams(params, "databases.update", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (invalid) {
			return invalidParamsResult<Database>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, databaseName, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: databaseName,
					},
					body: { database: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	delete(params: DatabasesDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: DatabasesDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: DatabasesDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "databases.delete", {
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
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchDatabase({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					database_name: databaseName,
				},
				throwOnError: false,
				signal,
			}),
		);
	}
}
