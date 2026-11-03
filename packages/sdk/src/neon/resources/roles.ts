import {
	createProjectBranchRole,
	deleteProjectBranchRole,
	getConnectionUri,
	getProjectBranchDatabase,
	getProjectBranchRole,
	getProjectBranchRolePassword,
	listProjectBranchDatabases,
	listProjectBranchRoles,
	resetProjectBranchRolePassword,
} from "../../client/sdk.gen.js";
import type {
	Database,
	Role,
	RoleCreateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { cancelled } from "../deadline.js";
import {
	NeonApiError,
	NeonClientError,
	NeonWaitTimeoutError,
} from "../errors.js";
import { invalidParamsResult, validateParams } from "../params.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";
import { runSqlTransaction } from "../sql-over-http.js";
import {
	bootstrapPassword,
	parseRoleAccess,
	type RoleAccess,
	roleAccessStatements,
	type ScopedRoleAccess,
	type ScopedRoleInput,
} from "./role-access.js";

export type { RoleAccess };

type CreateInput = RoleCreateRequest["role"];

export type RolesListParams = {
	projectId: string;
	branchId: string;
};

export type RolesGetParams = RolesListParams & {
	roleName: string;
};

/**
 * `access` defaults to `admin`: the Neon API creates the role and it joins
 * `neon_superuser`. `read_only` and `read_write` create the role with SQL as the database
 * owner, scoped to one database and `schemas` (default `["public"]`), then let Neon set
 * its password.
 */
export type RolesCreateParams = RolesListParams &
	CreateInput &
	(
		| { access?: "admin"; databaseName?: never; schemas?: never }
		| {
				access: ScopedRoleAccess;
				/** Auto-selected when the branch has exactly one database. */
				databaseName?: string;
				schemas?: readonly string[];
		  }
	);

export type RolesDeleteParams = RolesGetParams;

export type RolesPasswordParams = RolesGetParams;

export type RolesResetPasswordParams = RolesGetParams;

/** Role resource (branch-scoped). */
export class Roles<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/roles */
	list(params: RolesListParams): Promise<Outcome<Role[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: RolesListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role[], Throw>>;
	list(
		params: RolesListParams,
		opts?: CallOptions,
	): Promise<Role[] | NeonResult<Role[]>> {
		const invalid = validateParams(params, "roles.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Role[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchRoles({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.roles,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/roles/{role_name} */
	get(params: RolesGetParams): Promise<Outcome<Role, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: RolesGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role, Throw>>;
	get(
		params: RolesGetParams,
		opts?: CallOptions,
	): Promise<Role | NeonResult<Role>> {
		const invalid = validateParams(params, "roles.get", {
			projectId: "string",
			branchId: "string",
			roleName: "string",
		});
		if (invalid) {
			return invalidParamsResult<Role>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, roleName } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchRole({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: roleName,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.role,
		);
	}

	/**
	 * Create a role. With `access` `read_only` or `read_write`, the role is created with SQL
	 * over Neon's HTTP SQL endpoint as the database owner, then its password is reset
	 * through the API so Neon generates and stores it.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/roles
	 */
	create(params: RolesCreateParams): Promise<Outcome<Role, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: RolesCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role, Throw>>;
	async create(
		params: RolesCreateParams,
		opts?: CallOptions,
	): Promise<Role | NeonResult<Role>> {
		const invalid = validateParams(params, "roles.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Role>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const scoped = parseRoleAccess(params);
		if (scoped instanceof NeonClientError) {
			return invalidParamsResult<Role>(
				scoped,
				this.#ctx.shouldThrow(opts),
			);
		}
		const {
			projectId,
			branchId,
			access: _access,
			databaseName: _databaseName,
			schemas: _schemas,
			...input
		} = params;
		if (scoped !== undefined) {
			return finalize(
				await this.#createScoped(
					{
						projectId,
						branchId,
						name: input.name,
						noLogin: input.no_login === true,
						...scoped,
					},
					opts,
				),
				this.#ctx.shouldThrow(opts),
			);
		}
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchRole({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { role: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.role,
		);
	}

	async #createScoped(
		input: RolesListParams &
			ScopedRoleInput & { name: string; noLogin: boolean },
		opts: CallOptions | undefined,
	): Promise<NeonResult<Role>> {
		const { projectId, branchId, name, access } = input;
		const database = await this.#resolveDatabase(input, opts);
		if (database.error) return err(database.error);
		const owner = database.data.owner_name;

		const uri = await this.#ctx.execute(
			opts,
			(client, signal) =>
				getConnectionUri({
					client,
					path: { project_id: projectId },
					query: {
						branch_id: branchId,
						database_name: database.data.name,
						role_name: owner,
						pooled: false,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.uri,
		);
		if (uri.error) {
			if (uri.error.kind !== "api" && uri.error.kind !== "not_found") {
				return err(uri.error);
			}
			return err(
				new NeonClientError(
					`Could not connect as "${owner}", the owner of database "${database.data.name}", to create role "${name}"; nothing was changed. A ${access} role is created with SQL by the database owner, which needs a password Neon can reveal and a read-write compute on the branch. ${uri.error.message}`,
					{ cause: uri.error },
				),
			);
		}

		const statements = roleAccessStatements({
			name,
			databaseName: database.data.name,
			ownerName: owner,
			access,
			schemas: input.schemas,
			bootstrapPassword: input.noLogin ? undefined : bootstrapPassword(),
		});
		const deadline = this.#ctx.deadlineFor(opts);
		try {
			const before = cancelled(deadline);
			if (before) return err(before);
			const outcome = await runSqlTransaction({
				connectionString: uri.data,
				statements,
				fetch: this.#ctx.client.getConfig().fetch ?? globalThis.fetch,
				deadline,
			});
			if (outcome.kind === "rolled_back") {
				return err(
					new NeonApiError(
						`Could not create role "${name}"; nothing was changed. Postgres: ${outcome.message ?? "the statement failed"}`,
						{
							status: outcome.response.status,
							code: outcome.code,
							response: outcome.response,
							body: outcome.body,
						},
					),
				);
			}
			if (outcome.kind === "uncertain") {
				return err(
					new NeonClientError(
						`Could not confirm whether role "${name}" was created: ${outcome.reason}. Check roles.list before retrying.`,
						{ cause: outcome.cause },
					),
				);
			}
		} finally {
			deadline.dispose();
		}

		const created = await this.#ctx.execute(
			opts,
			(client, signal) =>
				input.noLogin
					? getProjectBranchRole({
							client,
							path: {
								project_id: projectId,
								branch_id: branchId,
								role_name: name,
							},
							throwOnError: false,
							signal,
						})
					: resetProjectBranchRolePassword({
							client,
							path: {
								project_id: projectId,
								branch_id: branchId,
								role_name: name,
							},
							throwOnError: false,
							signal,
						}),
			(data) => data.role,
		);
		if (created.error === undefined) return ok(created.data);
		if (created.error instanceof NeonWaitTimeoutError) return created;
		return err(
			new NeonClientError(
				input.noLogin
					? `Role "${name}" was created with ${access} access, but reading it back failed: ${created.error.message}`
					: `Role "${name}" was created with ${access} access, but Neon did not return a password: ${created.error.message} Call roles.resetPassword to get one.`,
				{ cause: created.error },
			),
		);
	}

	async #resolveDatabase(
		input: RolesListParams & { databaseName?: string },
		opts: CallOptions | undefined,
	): Promise<NeonResult<Database>> {
		const { projectId, branchId, databaseName } = input;
		if (databaseName !== undefined) {
			return this.#ctx.execute(
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
		const databases = await this.#ctx.execute(
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
		if (databases.error) return err(databases.error);
		const [only, ...rest] = databases.data;
		if (only === undefined || rest.length > 0) {
			return err<Database>(
				new NeonClientError(
					`roles.create needs databaseName: the branch has ${databases.data.length} databases, and a read_only or read_write role is scoped to one.`,
				),
			);
		}
		return ok(only);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/roles/{role_name} */
	delete(params: RolesDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: RolesDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: RolesDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "roles.delete", {
			projectId: "string",
			branchId: "string",
			roleName: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, roleName } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchRole({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					role_name: roleName,
				},
				throwOnError: false,
				signal,
			}),
		);
	}

	/**
	 * Reveal the role's password.
	 *
	 * @apiCall GET /projects/{project_id}/branches/{branch_id}/roles/{role_name}/reveal_password
	 */
	password(params: RolesPasswordParams): Promise<Outcome<string, DThrow>>;
	password<Throw extends boolean = DThrow>(
		params: RolesPasswordParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<string, Throw>>;
	password(
		params: RolesPasswordParams,
		opts?: CallOptions,
	): Promise<string | NeonResult<string>> {
		const invalid = validateParams(params, "roles.password", {
			projectId: "string",
			branchId: "string",
			roleName: "string",
		});
		if (invalid) {
			return invalidParamsResult<string>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, roleName } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchRolePassword({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: roleName,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.password,
		);
	}

	/**
	 * Reset the role's password; the returned `Role` carries the new `password`.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password
	 */
	resetPassword(
		params: RolesResetPasswordParams,
	): Promise<Outcome<Role, DThrow>>;
	resetPassword<Throw extends boolean = DThrow>(
		params: RolesResetPasswordParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role, Throw>>;
	resetPassword(
		params: RolesResetPasswordParams,
		opts?: CallOptions,
	): Promise<Role | NeonResult<Role>> {
		const invalid = validateParams(params, "roles.resetPassword", {
			projectId: "string",
			branchId: "string",
			roleName: "string",
		});
		if (invalid) {
			return invalidParamsResult<Role>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, roleName } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				resetProjectBranchRolePassword({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: roleName,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.role,
		);
	}
}
