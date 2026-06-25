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
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = DatabaseCreateRequest["database"];
type UpdateInput = DatabaseUpdateRequest["database"];

/** Database resource (branch-scoped). */
export class Databases<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/databases */
	list(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Database[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database[], Throw>>;
	list(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Database[] | NeonResult<Database[]>> {
		return this.#ctx.run(
			opts,
			(client) =>
				listProjectBranchDatabases({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data.databases,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	get(
		projectId: string,
		branchId: string,
		name: string,
	): Promise<Outcome<Database, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	get(
		projectId: string,
		branchId: string,
		name: string,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		return this.#ctx.run(
			opts,
			(client) =>
				getProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: name,
					},
					throwOnError: false,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/databases */
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
	): Promise<Outcome<Database, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		return this.#ctx.run(
			opts,
			(client) =>
				createProjectBranchDatabase({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { database: input },
					throwOnError: false,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	update(
		projectId: string,
		branchId: string,
		name: string,
		input: UpdateInput,
	): Promise<Outcome<Database, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	update(
		projectId: string,
		branchId: string,
		name: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		return this.#ctx.run(
			opts,
			(client) =>
				updateProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: name,
					},
					body: { database: input },
					throwOnError: false,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	delete(
		projectId: string,
		branchId: string,
		name: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		name: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client) =>
			deleteProjectBranchDatabase({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					database_name: name,
				},
				throwOnError: false,
			}),
		);
	}
}
