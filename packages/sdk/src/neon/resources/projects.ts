import {
	createProject,
	deleteProject,
	getProject,
	grantPermissionToProject,
	listProjectMembers,
	listProjectPermissions,
	listProjects,
	recoverProject,
	removeProjectMemberRole,
	revokePermissionFromProject,
	setProjectMemberRole,
	transferProjectsFromOrgToOrg,
	transferProjectsFromUserToOrg,
	updateProject,
} from "../../client/sdk.gen.js";
import type {
	ListProjectMembersData,
	ListProjectsData,
	Project,
	ProjectCreateRequest,
	ProjectListItem,
	ProjectMember,
	ProjectMemberRoleResponse,
	ProjectPermission,
	ProjectRole,
	ProjectUpdateRequest,
} from "../../client/types.gen.js";
import { withConnectionString } from "../connection.js";
import type { CallOptions, RequestContext } from "../context.js";
import { NeonClientError } from "../errors.js";
import { type Paginated, paginate } from "../paginate.js";
import { invalidParamsResult, validateParams } from "../params.js";
import { err, finalize, type NeonResult, type Outcome } from "../result.js";

/** Input for {@link Projects.transfer} (org → org). */
export interface TransferProjectsInput {
	/** Source org. Defaults to the client's `orgId`. */
	fromOrgId?: string;
	/** Destination org. */
	toOrgId: string;
	projectIds: string[];
}

type ListQuery = Omit<NonNullable<ListProjectsData["query"]>, "cursor">;
type CreateInput = ProjectCreateRequest["project"];
type UpdateInput = ProjectUpdateRequest["project"];
type MemberListQuery = Omit<
	NonNullable<ListProjectMembersData["query"]>,
	"cursor"
>;

/** Per-call options for {@link Members.setRole}. */
export type SetRoleOptions<Throw extends boolean = boolean> =
	CallOptions<Throw>;

/** Per-call options for {@link Members.removeRole}. */
export type RemoveRoleOptions<Throw extends boolean = boolean> =
	CallOptions<Throw>;

export type ProjectListParams = ListQuery;
export interface ProjectGetParams {
	projectId: string;
}
export type ProjectCreateParams = CreateInput;
export type ProjectCreateAndConnectParams = CreateInput & {
	/** Return a pooled connection string (default `true`). */
	pooled?: boolean;
};
export type ProjectUpdateParams = UpdateInput & { projectId: string };
export interface ProjectDeleteParams {
	projectId: string;
}
export interface ProjectRecoverParams {
	projectId: string;
}
export type ProjectTransferParams = TransferProjectsInput;
export interface ProjectTransferFromUserParams {
	toOrgId: string;
	projectIds: string[];
}
export interface ProjectPermissionListParams {
	projectId: string;
}
export interface ProjectPermissionGrantParams {
	projectId: string;
	email: string;
}
export interface ProjectPermissionRevokeParams {
	projectId: string;
	permissionId: string;
}
export type ProjectMemberListParams = MemberListQuery & { projectId: string };
export interface ProjectMemberSetRoleParams {
	projectId: string;
	memberId: string;
	role: ProjectRole;
	/**
	 * Acknowledge that the call lowers the caller's own role. The API rejects a
	 * self-demotion without it, so it is left off by default.
	 */
	confirmSelfDemotion?: boolean;
}
export interface ProjectMemberRemoveRoleParams {
	projectId: string;
	memberId: string;
	/**
	 * Acknowledge that the call can cost the caller management access. The API
	 * rejects such a self-removal without it, so it is left off by default.
	 */
	confirmSelfLockout?: boolean;
}

/** A project with a ready-to-use connection string to its default branch. */
export interface ProjectConnection {
	project: Project;
	connectionString: string;
}

/** Project access grants (share a project with additional users by email). */
export class Permissions<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/permissions */
	list(
		params: ProjectPermissionListParams,
	): Promise<Outcome<ProjectPermission[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: ProjectPermissionListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectPermission[], Throw>>;
	list(
		params: ProjectPermissionListParams,
		opts?: CallOptions,
	): Promise<ProjectPermission[] | NeonResult<ProjectPermission[]>> {
		const error = validateParams(params, "projects.permissions.list", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<ProjectPermission[]>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectPermissions({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.project_permissions,
		);
	}

	/** @apiCall POST /projects/{project_id}/permissions */
	grant(
		params: ProjectPermissionGrantParams,
	): Promise<Outcome<ProjectPermission, DThrow>>;
	grant<Throw extends boolean = DThrow>(
		params: ProjectPermissionGrantParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectPermission, Throw>>;
	grant(
		params: ProjectPermissionGrantParams,
		opts?: CallOptions,
	): Promise<ProjectPermission | NeonResult<ProjectPermission>> {
		const error = validateParams(params, "projects.permissions.grant", {
			projectId: "string",
			email: "string",
		});
		if (error)
			return invalidParamsResult<ProjectPermission>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, email } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				grantPermissionToProject({
					client,
					path: { project_id: projectId },
					body: { email },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/permissions/{permission_id} */
	revoke(
		params: ProjectPermissionRevokeParams,
	): Promise<Outcome<ProjectPermission, DThrow>>;
	revoke<Throw extends boolean = DThrow>(
		params: ProjectPermissionRevokeParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectPermission, Throw>>;
	revoke(
		params: ProjectPermissionRevokeParams,
		opts?: CallOptions,
	): Promise<ProjectPermission | NeonResult<ProjectPermission>> {
		const error = validateParams(params, "projects.permissions.revoke", {
			projectId: "string",
			permissionId: "string",
		});
		if (error)
			return invalidParamsResult<ProjectPermission>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, permissionId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				revokePermissionFromProject({
					client,
					path: {
						project_id: projectId,
						permission_id: permissionId,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}

/**
 * Per-project roles for members of the owning organization.
 *
 * Distinct from {@link Permissions}, which shares a project with an individual by
 * email address: these act on existing org members by member id, and clearing a
 * grant leaves the member's organization-role default in force rather than
 * removing their access.
 */
export class Members<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * List org members and their project roles (cursor-paginated). Org-owned
	 * projects only — a personal project answers `404`, as does an org with
	 * per-project role management disabled.
	 *
	 * @apiCall GET /projects/{project_id}/members (cursor-paginated)
	 */
	list(params: ProjectMemberListParams): Paginated<ProjectMember, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: ProjectMemberListParams,
		opts: CallOptions<Throw>,
	): Paginated<ProjectMember, Throw>;
	list(
		params: ProjectMemberListParams,
		opts?: CallOptions,
	): Paginated<ProjectMember, boolean> {
		const error = validateParams(params, "projects.members.list", {
			projectId: "string",
		});
		const { projectId, ...query } = error
			? ({} as ProjectMemberListParams)
			: params;
		return paginate(
			async (cursor, signal) => {
				if (error) throw error;
				return listProjectMembers({
					client: this.#ctx.client,
					path: { project_id: projectId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.project_members ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/**
	 * Set a member's explicit project role, replacing any existing grant.
	 * Idempotent. Check `credential_rotation_recommended` and
	 * `org_api_key_rotation_recommended` on the result — a downgrade can leave
	 * credentials the member still holds.
	 *
	 * @apiCall PUT /projects/{project_id}/members/{member_id}/role
	 */
	setRole(
		params: ProjectMemberSetRoleParams,
	): Promise<Outcome<ProjectMemberRoleResponse, DThrow>>;
	setRole<Throw extends boolean = DThrow>(
		params: ProjectMemberSetRoleParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectMemberRoleResponse, Throw>>;
	setRole(
		params: ProjectMemberSetRoleParams,
		opts?: CallOptions<boolean>,
	): Promise<
		ProjectMemberRoleResponse | NeonResult<ProjectMemberRoleResponse>
	> {
		const error = validateParams(params, "projects.members.setRole", {
			projectId: "string",
			memberId: "string",
			role: "string",
		});
		if (error)
			return invalidParamsResult<ProjectMemberRoleResponse>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, memberId, role, confirmSelfDemotion } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				setProjectMemberRole({
					client,
					path: { project_id: projectId, member_id: memberId },
					query: confirmSelfDemotion
						? { confirm_self_demotion: true }
						: undefined,
					body: { role },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Clear a member's explicit project grant. Idempotent, and a no-op when no
	 * explicit grant exists. The member keeps whatever their organization role
	 * grants by default, so this narrows access rather than removing it.
	 *
	 * @apiCall DELETE /projects/{project_id}/members/{member_id}/role
	 */
	removeRole(
		params: ProjectMemberRemoveRoleParams,
	): Promise<Outcome<ProjectMemberRoleResponse, DThrow>>;
	removeRole<Throw extends boolean = DThrow>(
		params: ProjectMemberRemoveRoleParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectMemberRoleResponse, Throw>>;
	removeRole(
		params: ProjectMemberRemoveRoleParams,
		opts?: CallOptions<boolean>,
	): Promise<
		ProjectMemberRoleResponse | NeonResult<ProjectMemberRoleResponse>
	> {
		const error = validateParams(params, "projects.members.removeRole", {
			projectId: "string",
			memberId: "string",
		});
		if (error)
			return invalidParamsResult<ProjectMemberRoleResponse>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, memberId, confirmSelfLockout } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				removeProjectMemberRole({
					client,
					path: { project_id: projectId, member_id: memberId },
					query: confirmSelfLockout
						? { confirm_self_lockout: true }
						: undefined,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}

/** Project resource — one API call per method (`list` is cursor-paginated). */
export class Projects<DThrow extends boolean> {
	readonly #ctx: RequestContext;
	/** Project access grants (share by email). */
	readonly permissions: Permissions<DThrow>;
	/** Per-project roles for members of the owning organization. */
	readonly members: Members<DThrow>;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.permissions = new Permissions<DThrow>(ctx);
		this.members = new Members<DThrow>(ctx);
	}

	/**
	 * List projects (cursor-paginated). Returns a lazy list — `await .all()`, `.page()`,
	 * or `for await (… of …)`.
	 *
	 * @apiCall GET /projects
	 */
	list(params?: ProjectListParams): Paginated<ProjectListItem, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: ProjectListParams | undefined,
		opts: CallOptions<Throw>,
	): Paginated<ProjectListItem, Throw>;
	list(
		query: ProjectListParams = {},
		opts?: CallOptions,
	): Paginated<ProjectListItem, boolean> {
		return paginate(
			(cursor, signal) =>
				listProjects({
					client: this.#ctx.client,
					query: {
						org_id: this.#ctx.defaults.orgId,
						...query,
						cursor,
					},
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.projects ?? [],
				cursor: data?.pagination?.cursor,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /projects/{project_id} */
	get(params: ProjectGetParams): Promise<Outcome<Project, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: ProjectGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	get(
		params: ProjectGetParams,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		const error = validateParams(params, "projects.get", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<Project>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProject({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/**
	 * The API provides no way to skip the default branch or read-write compute.
	 * This method retains its project-only result; use
	 * {@link Projects.createAndConnect} or `postgres.connectionString` when a
	 * connection string is needed.
	 */
	create(params?: ProjectCreateParams): Promise<Outcome<Project, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: ProjectCreateParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	create(
		input: ProjectCreateParams = {},
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		return this.#ctx.run(
			{
				...opts,
				waitForReadiness: this.#ctx.resolveWait(opts, true),
			},
			(client, signal) =>
				createProject({
					client,
					body: {
						project: {
							...(this.#ctx.defaults.orgId
								? { org_id: this.#ctx.defaults.orgId }
								: {}),
							...input,
						},
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/**
	 * Create a project and return a ready-to-use connection string to its default branch.
	 * One API call plus readiness polling (the create response already carries the
	 * connection URI).
	 *
	 * @workflow createProject + waitForReadiness
	 */
	createAndConnect(
		params?: ProjectCreateAndConnectParams,
	): Promise<Outcome<ProjectConnection, DThrow>>;
	createAndConnect<Throw extends boolean = DThrow>(
		params: ProjectCreateAndConnectParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectConnection, Throw>>;
	async createAndConnect(
		params: ProjectCreateAndConnectParams = {},
		opts?: CallOptions<boolean>,
	): Promise<ProjectConnection | NeonResult<ProjectConnection>> {
		const error = validateParams(params, "projects.createAndConnect");
		if (error)
			return invalidParamsResult<ProjectConnection>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { pooled = true, ...input } = params;
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			{ ...opts, waitForReadiness: this.#ctx.resolveWait(opts, true) },
			(client, signal) =>
				createProject({
					client,
					body: {
						project: {
							...(this.#ctx.defaults.orgId
								? { org_id: this.#ctx.defaults.orgId }
								: {}),
							...input,
						},
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
		const out = withConnectionString(
			result,
			(data) => data.connection_uris,
			(data, connectionString) => ({
				project: data.project,
				connectionString,
			}),
			pooled,
		);
		return finalize(out, shouldThrow);
	}

	/** @apiCall PATCH /projects/{project_id} */
	update(params: ProjectUpdateParams): Promise<Outcome<Project, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: ProjectUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	update(
		params: ProjectUpdateParams,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		const error = validateParams(params, "projects.update", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<Project>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProject({
					client,
					path: { project_id: projectId },
					body: { project: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/** @apiCall DELETE /projects/{project_id} */
	delete(params: ProjectDeleteParams): Promise<Outcome<Project, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: ProjectDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	delete(
		params: ProjectDeleteParams,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		const error = validateParams(params, "projects.delete", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<Project>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				deleteProject({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/**
	 * Recover a soft-deleted project within its retention window (beta).
	 *
	 * @apiCall POST /projects/{project_id}/recover
	 */
	recover(params: ProjectRecoverParams): Promise<Outcome<Project, DThrow>>;
	recover<Throw extends boolean = DThrow>(
		params: ProjectRecoverParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	recover(
		params: ProjectRecoverParams,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		const error = validateParams(params, "projects.recover", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<Project>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				recoverProject({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/**
	 * Transfer projects from one organization to another (e.g. sponsored → paid). The
	 * source org defaults to the client's `orgId`. Requires a key with access to both orgs.
	 *
	 * @apiCall POST /organizations/{source_org_id}/projects/transfer
	 */
	transfer(params: ProjectTransferParams): Promise<Outcome<void, DThrow>>;
	transfer<Throw extends boolean = DThrow>(
		params: ProjectTransferParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	async transfer(
		input: ProjectTransferParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const fromOrgId = input.fromOrgId ?? this.#ctx.defaults.orgId;
		if (!fromOrgId) {
			return finalize(
				err<void>(
					new NeonClientError(
						"Pass fromOrgId or set orgId on the client.",
					),
				),
				shouldThrow,
			);
		}
		return this.#ctx.run(
			opts,
			(client, signal) =>
				transferProjectsFromOrgToOrg({
					client,
					path: { source_org_id: fromOrgId },
					body: {
						destination_org_id: input.toOrgId,
						project_ids: input.projectIds,
					},
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}

	/**
	 * Transfer projects from the personal account to an organization.
	 *
	 * @apiCall POST /users/me/projects/transfer
	 */
	transferFromUser(
		params: ProjectTransferFromUserParams,
	): Promise<Outcome<void, DThrow>>;
	transferFromUser<Throw extends boolean = DThrow>(
		params: ProjectTransferFromUserParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	transferFromUser(
		input: ProjectTransferFromUserParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				transferProjectsFromUserToOrg({
					client,
					body: {
						destination_org_id: input.toOrgId,
						project_ids: input.projectIds,
					},
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}
}
