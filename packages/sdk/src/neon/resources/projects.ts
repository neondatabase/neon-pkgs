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
import { NeonError } from "../errors.js";
import { type Paginated, paginate } from "../paginate.js";
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
export interface SetRoleOptions<Throw extends boolean = boolean>
	extends CallOptions<Throw> {
	/**
	 * Acknowledge that the call lowers the caller's own role. The API rejects a
	 * self-demotion without it, so it is left off by default.
	 */
	confirmSelfDemotion?: boolean;
}

/** Per-call options for {@link Members.removeRole}. */
export interface RemoveRoleOptions<Throw extends boolean = boolean>
	extends CallOptions<Throw> {
	/**
	 * Acknowledge that the call can cost the caller management access. The API
	 * rejects such a self-removal without it, so it is left off by default.
	 */
	confirmSelfLockout?: boolean;
}

/** Per-call options for the connect workflow. */
interface WorkflowOptions<Throw extends boolean> extends CallOptions<Throw> {
	/** Return a pooled connection string (default `true`). */
	pooled?: boolean;
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
	list(projectId: string): Promise<Outcome<ProjectPermission[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectPermission[], Throw>>;
	list(
		projectId: string,
		opts?: CallOptions,
	): Promise<ProjectPermission[] | NeonResult<ProjectPermission[]>> {
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
		projectId: string,
		email: string,
	): Promise<Outcome<ProjectPermission, DThrow>>;
	grant<Throw extends boolean = DThrow>(
		projectId: string,
		email: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectPermission, Throw>>;
	grant(
		projectId: string,
		email: string,
		opts?: CallOptions,
	): Promise<ProjectPermission | NeonResult<ProjectPermission>> {
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
		projectId: string,
		permissionId: string,
	): Promise<Outcome<ProjectPermission, DThrow>>;
	revoke<Throw extends boolean = DThrow>(
		projectId: string,
		permissionId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectPermission, Throw>>;
	revoke(
		projectId: string,
		permissionId: string,
		opts?: CallOptions,
	): Promise<ProjectPermission | NeonResult<ProjectPermission>> {
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
	list(
		projectId: string,
		query?: MemberListQuery,
		opts?: CallOptions,
	): Paginated<ProjectMember> {
		return paginate(
			(cursor, signal) =>
				listProjectMembers({
					client: this.#ctx.client,
					path: { project_id: projectId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.project_members ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
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
		projectId: string,
		memberId: string,
		role: ProjectRole,
	): Promise<Outcome<ProjectMemberRoleResponse, DThrow>>;
	setRole<Throw extends boolean = DThrow>(
		projectId: string,
		memberId: string,
		role: ProjectRole,
		opts: SetRoleOptions<Throw>,
	): Promise<Outcome<ProjectMemberRoleResponse, Throw>>;
	setRole(
		projectId: string,
		memberId: string,
		role: ProjectRole,
		opts?: SetRoleOptions<boolean>,
	): Promise<
		ProjectMemberRoleResponse | NeonResult<ProjectMemberRoleResponse>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				setProjectMemberRole({
					client,
					path: { project_id: projectId, member_id: memberId },
					query: opts?.confirmSelfDemotion
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
		projectId: string,
		memberId: string,
	): Promise<Outcome<ProjectMemberRoleResponse, DThrow>>;
	removeRole<Throw extends boolean = DThrow>(
		projectId: string,
		memberId: string,
		opts: RemoveRoleOptions<Throw>,
	): Promise<Outcome<ProjectMemberRoleResponse, Throw>>;
	removeRole(
		projectId: string,
		memberId: string,
		opts?: RemoveRoleOptions<boolean>,
	): Promise<
		ProjectMemberRoleResponse | NeonResult<ProjectMemberRoleResponse>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				removeProjectMemberRole({
					client,
					path: { project_id: projectId, member_id: memberId },
					query: opts?.confirmSelfLockout
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
	list(query?: ListQuery, opts?: CallOptions): Paginated<ProjectListItem> {
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
		);
	}

	/** @apiCall GET /projects/{project_id} */
	get(id: string): Promise<Outcome<Project, DThrow>>;
	get<Throw extends boolean = DThrow>(
		id: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	get(
		id: string,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProject({
					client,
					path: { project_id: id },
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/** @apiCall POST /projects */
	create(input?: CreateInput): Promise<Outcome<Project, DThrow>>;
	create<Throw extends boolean = DThrow>(
		input: CreateInput | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	create(
		input?: CreateInput,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		return this.#ctx.run(
			opts,
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
		input?: CreateInput,
	): Promise<Outcome<ProjectConnection, DThrow>>;
	createAndConnect<Throw extends boolean = DThrow>(
		input: CreateInput | undefined,
		opts: WorkflowOptions<Throw>,
	): Promise<Outcome<ProjectConnection, Throw>>;
	async createAndConnect(
		input?: CreateInput,
		opts?: WorkflowOptions<boolean>,
	): Promise<ProjectConnection | NeonResult<ProjectConnection>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			{ ...opts, waitForReadiness: opts?.waitForReadiness ?? true },
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
			opts?.pooled ?? true,
		);
		return finalize(out, shouldThrow);
	}

	/** @apiCall PATCH /projects/{project_id} */
	update(id: string, input: UpdateInput): Promise<Outcome<Project, DThrow>>;
	update<Throw extends boolean = DThrow>(
		id: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	update(
		id: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProject({
					client,
					path: { project_id: id },
					body: { project: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.project,
		);
	}

	/** @apiCall DELETE /projects/{project_id} */
	delete(id: string): Promise<Outcome<Project, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		id: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	delete(
		id: string,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				deleteProject({
					client,
					path: { project_id: id },
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
	recover(id: string): Promise<Outcome<Project, DThrow>>;
	recover<Throw extends boolean = DThrow>(
		id: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Project, Throw>>;
	recover(
		id: string,
		opts?: CallOptions,
	): Promise<Project | NeonResult<Project>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				recoverProject({
					client,
					path: { project_id: id },
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
	transfer(input: TransferProjectsInput): Promise<Outcome<void, DThrow>>;
	transfer<Throw extends boolean = DThrow>(
		input: TransferProjectsInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	async transfer(
		input: TransferProjectsInput,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const fromOrgId = input.fromOrgId ?? this.#ctx.defaults.orgId;
		if (!fromOrgId) {
			return finalize(
				err<void>(
					new NeonError(
						"Pass fromOrgId or set orgId on the client.",
						"client",
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
	transferFromUser(input: {
		toOrgId: string;
		projectIds: string[];
	}): Promise<Outcome<void, DThrow>>;
	transferFromUser<Throw extends boolean = DThrow>(
		input: { toOrgId: string; projectIds: string[] },
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	transferFromUser(
		input: { toOrgId: string; projectIds: string[] },
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
