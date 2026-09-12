import {
	createProjectBranchRole,
	deleteProjectBranchRole,
	getProjectBranchRole,
	getProjectBranchRolePassword,
	listProjectBranchRoles,
	resetProjectBranchRolePassword,
} from "../../client/sdk.gen.js";
import type { Role, RoleCreateRequest } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = RoleCreateRequest["role"];

export type RolesListParams = {
	projectId: string;
	branchId: string;
};

export type RolesGetParams = RolesListParams & {
	roleName: string;
};

export type RolesCreateParams = RolesListParams & CreateInput;

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

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/roles */
	create(params: RolesCreateParams): Promise<Outcome<Role, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: RolesCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role, Throw>>;
	create(
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
		const { projectId, branchId, ...input } = params;
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
