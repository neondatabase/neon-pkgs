import {
	createProjectBranchFunctionDeployment,
	deleteProjectBranchFunction,
	getProjectBranchFunction,
	listProjectBranchFunctions,
	updateProjectBranchFunction,
} from "../../client/sdk.gen.js";
import type {
	FunctionDeployRequest,
	ListProjectBranchFunctionsData,
	NeonFunction,
	NeonFunctionDeployment,
	NeonFunctionUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";
import type { NeonResult, Outcome } from "../result.js";

type ListQuery = Omit<
	NonNullable<ListProjectBranchFunctionsData["query"]>,
	"cursor"
>;
type UpdateInput = NeonFunctionUpdateRequest;

/** Branch-scoped Neon Functions. */
export class Functions<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/functions (cursor-paginated) */
	list(
		projectId: string,
		branchId: string,
		query?: ListQuery,
		opts?: CallOptions,
	): Paginated<NeonFunction> {
		return paginate(
			(cursor, signal) =>
				listProjectBranchFunctions({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.functions ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/functions/{slug} */
	get(
		projectId: string,
		branchId: string,
		slug: string,
	): Promise<Outcome<NeonFunction, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		slug: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonFunction, Throw>>;
	get(
		projectId: string,
		branchId: string,
		slug: string,
		opts?: CallOptions,
	): Promise<NeonFunction | NeonResult<NeonFunction>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchFunction({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						slug,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.function,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/functions/{slug} */
	update(
		projectId: string,
		branchId: string,
		slug: string,
		input: UpdateInput,
	): Promise<Outcome<NeonFunction, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		slug: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonFunction, Throw>>;
	update(
		projectId: string,
		branchId: string,
		slug: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<NeonFunction | NeonResult<NeonFunction>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectBranchFunction({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						slug,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data.function,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/functions/{slug} */
	delete(
		projectId: string,
		branchId: string,
		slug: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		slug: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		slug: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchFunction({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					slug,
				},
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/functions/{slug}/deployments */
	deploy(
		projectId: string,
		branchId: string,
		slug: string,
		input?: FunctionDeployRequest,
	): Promise<Outcome<NeonFunctionDeployment, DThrow>>;
	deploy<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		slug: string,
		input: FunctionDeployRequest | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonFunctionDeployment, Throw>>;
	deploy(
		projectId: string,
		branchId: string,
		slug: string,
		input?: FunctionDeployRequest,
		opts?: CallOptions,
	): Promise<NeonFunctionDeployment | NeonResult<NeonFunctionDeployment>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchFunctionDeployment({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						slug,
					},
					body: input ?? {},
					throwOnError: false,
					signal,
				}),
			(data) => data.deployment,
		);
	}
}
