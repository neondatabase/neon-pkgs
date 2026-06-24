import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	updateProject,
} from "../../client/sdk.gen.js";
import type {
	ListProjectsData,
	Project,
	ProjectCreateRequest,
	ProjectListItem,
	ProjectUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";
import type { NeonResult, Outcome } from "../result.js";

type ListQuery = Omit<NonNullable<ListProjectsData["query"]>, "cursor">;
type CreateInput = ProjectCreateRequest["project"];
type UpdateInput = ProjectUpdateRequest["project"];

/** Project resource — one API call per method (`list` is cursor-paginated). */
export class Projects<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * List projects (cursor-paginated). Returns a lazy list — `await .all()`, `.page()`,
	 * or `for await (… of …)`.
	 *
	 * @apiCall GET /projects
	 */
	list(query?: ListQuery): Paginated<ProjectListItem> {
		return paginate(
			(cursor, signal) =>
				listProjects({
					client: this.#ctx.client,
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.projects ?? [],
				cursor: data?.pagination?.cursor,
			}),
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
			(client) =>
				getProject({
					client,
					path: { project_id: id },
					throwOnError: false,
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
			(client) =>
				createProject({
					client,
					body: { project: input ?? {} },
					throwOnError: false,
				}),
			(data) => data.project,
		);
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
			(client) =>
				updateProject({
					client,
					path: { project_id: id },
					body: { project: input },
					throwOnError: false,
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
			(client) =>
				deleteProject({
					client,
					path: { project_id: id },
					throwOnError: false,
				}),
			(data) => data.project,
		);
	}
}
