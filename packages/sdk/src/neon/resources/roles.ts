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
import { NeonError } from "../errors.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";

type CreateInput = RoleCreateRequest["role"];

/** Role resource (branch-scoped). */
export class Roles<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/roles */
	list(projectId: string, branchId: string): Promise<Outcome<Role[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role[], Throw>>;
	list(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Role[] | NeonResult<Role[]>> {
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
	get(
		projectId: string,
		branchId: string,
		name: string,
	): Promise<Outcome<Role, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role, Throw>>;
	get(
		projectId: string,
		branchId: string,
		name: string,
		opts?: CallOptions,
	): Promise<Role | NeonResult<Role>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchRole({
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
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/roles */
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
	): Promise<Outcome<Role, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Role, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts?: CallOptions,
	): Promise<Role | NeonResult<Role>> {
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
			deleteProjectBranchRole({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					role_name: name,
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
	revealPassword(
		projectId: string,
		branchId: string,
		name: string,
	): Promise<Outcome<string, DThrow>>;
	revealPassword<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<string, Throw>>;
	revealPassword(
		projectId: string,
		branchId: string,
		name: string,
		opts?: CallOptions,
	): Promise<string | NeonResult<string>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchRolePassword({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: name,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.password,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password */
	resetPassword(
		projectId: string,
		branchId: string,
		name: string,
	): Promise<Outcome<string, DThrow>>;
	resetPassword<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		name: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<string, Throw>>;
	async resetPassword(
		projectId: string,
		branchId: string,
		name: string,
		opts?: CallOptions,
	): Promise<string | NeonResult<string>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			opts,
			(client, signal) =>
				resetProjectBranchRolePassword({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						role_name: name,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.role?.password,
		);
		if (result.error) {
			return finalize(err<string>(result.error), shouldThrow);
		}
		if (!result.data) {
			return finalize(
				err<string>(
					new NeonError(
						"Reset returned a role without a password.",
						"client",
					),
				),
				shouldThrow,
			);
		}
		return finalize(ok(result.data), shouldThrow);
	}
}
