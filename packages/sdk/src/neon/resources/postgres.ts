import {
	getConnectionUri,
	listProjectBranchDatabases,
	listProjectBranches,
	listProjectBranchRoles,
} from "../../client/sdk.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { NeonError, toNeonError } from "../errors.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";
import { DataApi } from "./dataapi.js";
import { Databases } from "./databases.js";
import { Endpoints } from "./endpoints.js";
import { Roles } from "./roles.js";

/** Parameters for {@link Postgres.connectionString}. */
export interface ConnectionStringParams {
	projectId: string;
	/** Defaults to the project's default branch. */
	branchId?: string;
	/** Defaults to the branch's read-write endpoint. */
	endpointId?: string;
	/** Auto-selected when the branch has exactly one database. */
	databaseName?: string;
	/** Auto-selected when the branch has exactly one role. */
	roleName?: string;
	/** Pooled connection string (default `true`). */
	pooled?: boolean;
}

/**
 * The Postgres data plane of a branch: compute endpoints, roles, databases, the Data API,
 * and a connection-string helper. (Grouped under `neon.postgres.*` so future top-level
 * namespaces like `functions` / `storage` stay unambiguous.)
 */
export class Postgres<DThrow extends boolean> {
	readonly endpoints: Endpoints<DThrow>;
	readonly roles: Roles<DThrow>;
	readonly databases: Databases<DThrow>;
	readonly dataApi: DataApi<DThrow>;
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.endpoints = new Endpoints<DThrow>(ctx);
		this.roles = new Roles<DThrow>(ctx);
		this.databases = new Databases<DThrow>(ctx);
		this.dataApi = new DataApi<DThrow>(ctx);
	}

	/**
	 * Resolve a Postgres connection string. Auto-selects the default branch and the sole
	 * role/database when not specified (mirrors `@neondatabase/config`'s `fetchEnv`); returns
	 * a `client`-kind {@link NeonError} when the selection is ambiguous.
	 */
	connectionString(
		params: ConnectionStringParams,
	): Promise<Outcome<string, DThrow>>;
	connectionString<Throw extends boolean = DThrow>(
		params: ConnectionStringParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<string, Throw>>;
	async connectionString(
		params: ConnectionStringParams,
		opts?: CallOptions,
	): Promise<string | NeonResult<string>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		return finalize(await this.#resolve(params, opts?.signal), shouldThrow);
	}

	async #resolve(
		params: ConnectionStringParams,
		signal?: AbortSignal,
	): Promise<NeonResult<string>> {
		const client = this.#ctx.client;
		const projectId = params.projectId;
		let branchId = params.branchId;
		let roleName = params.roleName;
		let databaseName = params.databaseName;

		if ((!roleName || !databaseName) && !branchId) {
			const branches = await listProjectBranches({
				client,
				path: { project_id: projectId },
				throwOnError: false,
				signal,
			});
			if (branches.error || !branches.data) {
				return err(toNeonError(branches.error, branches.response));
			}
			branchId = branches.data.branches.find(
				(branch) => branch.default,
			)?.id;
			if (!branchId) {
				return err(
					new NeonError(
						"Could not determine the default branch; pass branchId.",
						"client",
					),
				);
			}
		}

		if (!roleName) {
			if (!branchId) return err(branchRequired("roleName"));
			const roles = await listProjectBranchRoles({
				client,
				path: { project_id: projectId, branch_id: branchId },
				throwOnError: false,
				signal,
			});
			if (roles.error || !roles.data)
				return err(toNeonError(roles.error, roles.response));
			if (roles.data.roles.length !== 1) {
				return err(
					ambiguous("role", roles.data.roles.length, "roleName"),
				);
			}
			roleName = roles.data.roles[0].name;
		}

		if (!databaseName) {
			if (!branchId) return err(branchRequired("databaseName"));
			const databases = await listProjectBranchDatabases({
				client,
				path: { project_id: projectId, branch_id: branchId },
				throwOnError: false,
				signal,
			});
			if (databases.error || !databases.data) {
				return err(toNeonError(databases.error, databases.response));
			}
			if (databases.data.databases.length !== 1) {
				return err(
					ambiguous(
						"database",
						databases.data.databases.length,
						"databaseName",
					),
				);
			}
			databaseName = databases.data.databases[0].name;
		}

		const conn = await getConnectionUri({
			client,
			path: { project_id: projectId },
			query: {
				branch_id: branchId,
				endpoint_id: params.endpointId,
				database_name: databaseName,
				role_name: roleName,
				pooled: params.pooled ?? true,
			},
			throwOnError: false,
			signal,
		});
		if (conn.error || !conn.data)
			return err(toNeonError(conn.error, conn.response));
		return ok(conn.data.uri);
	}
}

function branchRequired(param: string): NeonError {
	return new NeonError(
		`Pass branchId or ${param} to resolve a connection string.`,
		"client",
	);
}

function ambiguous(kind: string, count: number, param: string): NeonError {
	return new NeonError(
		`Expected exactly one ${kind} to auto-select for the connection string; found ${count}. Pass ${param}.`,
		"client",
	);
}
