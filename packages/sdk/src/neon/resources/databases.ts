import {
	createProjectBranchDatabase,
	deleteProjectBranchDatabase,
	getProjectBranchDatabase,
	listProjectBranchDatabases,
	updateProjectBranchDatabase,
} from "../../client/sdk.gen.js";
import type { Database } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

export interface DatabaseCreateInput {
	name: string;
	ownerName: string;
}

export interface DatabaseUpdateInput {
	name?: string;
	ownerName?: string;
}

function mapDatabaseCreate(input: DatabaseCreateInput) {
	return { name: input.name, owner_name: input.ownerName };
}

function mapDatabaseUpdate(input: DatabaseUpdateInput) {
	return {
		...(input.name !== undefined ? { name: input.name } : {}),
		...(input.ownerName !== undefined
			? { owner_name: input.ownerName }
			: {}),
	};
}

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
			(client, signal) =>
				getProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: name,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/databases */
	create(
		projectId: string,
		branchId: string,
		input: DatabaseCreateInput,
	): Promise<Outcome<Database, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: DatabaseCreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: DatabaseCreateInput,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchDatabase({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { database: mapDatabaseCreate(input) },
					throwOnError: false,
					signal,
				}),
			(data) => data.database,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/databases/{database_name} */
	update(
		projectId: string,
		branchId: string,
		name: string,
		input: DatabaseUpdateInput,
	): Promise<Outcome<Database, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		input: DatabaseUpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Database, Throw>>;
	update(
		projectId: string,
		branchId: string,
		name: string,
		input: DatabaseUpdateInput,
		opts?: CallOptions,
	): Promise<Database | NeonResult<Database>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectBranchDatabase({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						database_name: name,
					},
					body: { database: mapDatabaseUpdate(input) },
					throwOnError: false,
					signal,
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
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchDatabase({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					database_name: name,
				},
				throwOnError: false,
				signal,
			}),
		);
	}
}
