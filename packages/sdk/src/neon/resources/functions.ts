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
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";
import { CustomDomains } from "./custom-domains.js";

type ListQuery = Omit<
	NonNullable<ListProjectBranchFunctionsData["query"]>,
	"cursor"
>;
type UpdateInput = NeonFunctionUpdateRequest;

export type FunctionsListParams = {
	projectId: string;
	branchId: string;
} & ListQuery;
export type FunctionsGetParams = {
	projectId: string;
	branchId: string;
	slug: string;
};
export type FunctionsUpdateParams = FunctionsGetParams & UpdateInput;
export type FunctionsDeleteParams = FunctionsGetParams;
export type FunctionsDeployParams = FunctionsGetParams & FunctionDeployRequest;

/** Branch-scoped Neon Functions. */
export class Functions<DThrow extends boolean> {
	readonly customDomains: CustomDomains<DThrow>;
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.customDomains = new CustomDomains<DThrow>(ctx);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/functions (cursor-paginated) */
	list(params: FunctionsListParams): Paginated<NeonFunction, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: FunctionsListParams,
		opts: CallOptions<Throw>,
	): Paginated<NeonFunction, Throw>;
	list(
		params: FunctionsListParams,
		opts?: CallOptions,
	): Paginated<NeonFunction, boolean> {
		const invalid = validateParams(params, "functions.list", {
			projectId: "string",
			branchId: "string",
		});
		const { projectId, branchId, ...query } = invalid
			? ({} as FunctionsListParams)
			: params;
		return paginate(
			async (cursor, signal) => {
				if (invalid) throw invalid;
				return listProjectBranchFunctions({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.functions ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/functions/{slug} */
	get(params: FunctionsGetParams): Promise<Outcome<NeonFunction, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: FunctionsGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonFunction, Throw>>;
	get(
		params: FunctionsGetParams,
		opts?: CallOptions,
	): Promise<NeonFunction | NeonResult<NeonFunction>> {
		const invalid = validateParams(params, "functions.get", {
			projectId: "string",
			branchId: "string",
			slug: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonFunction>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, slug } = params;
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
		params: FunctionsUpdateParams,
	): Promise<Outcome<NeonFunction, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: FunctionsUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonFunction, Throw>>;
	update(
		params: FunctionsUpdateParams,
		opts?: CallOptions,
	): Promise<NeonFunction | NeonResult<NeonFunction>> {
		const invalid = validateParams(params, "functions.update", {
			projectId: "string",
			branchId: "string",
			slug: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonFunction>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, slug, ...input } = params;
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
	delete(params: FunctionsDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: FunctionsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: FunctionsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "functions.delete", {
			projectId: "string",
			branchId: "string",
			slug: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, slug } = params;
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
		params: FunctionsDeployParams,
	): Promise<Outcome<NeonFunctionDeployment, DThrow>>;
	deploy<Throw extends boolean = DThrow>(
		params: FunctionsDeployParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonFunctionDeployment, Throw>>;
	deploy(
		params: FunctionsDeployParams,
		opts?: CallOptions,
	): Promise<NeonFunctionDeployment | NeonResult<NeonFunctionDeployment>> {
		const invalid = validateParams(params, "functions.deploy", {
			projectId: "string",
			branchId: "string",
			slug: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonFunctionDeployment>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, slug, ...input } = params;
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
