import {
	createProject,
	deleteProject,
	getProject,
	grantPermissionToProject,
	listProjectPermissions,
	listProjects,
	recoverProject,
	revokePermissionFromProject,
	transferProjectsFromOrgToOrg,
	transferProjectsFromUserToOrg,
	updateProject,
} from "../../client/sdk.gen.js";
import type {
	ListProjectsData,
	Project,
	ProjectCreateRequest,
	ProjectListItem,
	ProjectPermission,
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

/** Project resource — one API call per method (`list` is cursor-paginated). */
export class Projects<DThrow extends boolean> {
	readonly #ctx: RequestContext;
	/** Project access grants (share by email). */
	readonly permissions: Permissions<DThrow>;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.permissions = new Permissions<DThrow>(ctx);
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
	 * Recover a soft-deleted project within its retention window (beta). Mirrors
	 * `branches.recover` at the project level.
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
