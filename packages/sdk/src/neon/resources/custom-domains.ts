import {
	deleteProjectBranchCustomDomain,
	listProjectBranchCustomDomains,
	registerProjectBranchCustomDomain,
} from "../../client/sdk.gen.js";
import type {
	CustomDomain,
	CustomDomainRegisterRequest,
	ListProjectBranchCustomDomainsData,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type ListQuery = Omit<
	NonNullable<ListProjectBranchCustomDomainsData["query"]>,
	"cursor"
>;
type RegisterInput = CustomDomainRegisterRequest;

export type CustomDomainsListParams = {
	projectId: string;
	branchId: string;
} & ListQuery;
export type CustomDomainsRegisterParams = {
	projectId: string;
	branchId: string;
} & RegisterInput;
export type CustomDomainsDeleteParams = {
	projectId: string;
	branchId: string;
	domain: string;
};

/** Branch-scoped custom domains. v1 can only target a function. */
export class CustomDomains<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/custom-domains (cursor-paginated) */
	list(params: CustomDomainsListParams): Paginated<CustomDomain, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: CustomDomainsListParams,
		opts: CallOptions<Throw>,
	): Paginated<CustomDomain, Throw>;
	list(
		params: CustomDomainsListParams,
		opts?: CallOptions,
	): Paginated<CustomDomain, boolean> {
		const invalid = validateParams(params, "functions.customDomains.list", {
			projectId: "string",
			branchId: "string",
		});
		const { projectId, branchId, ...query } = invalid
			? ({} as CustomDomainsListParams)
			: params;
		return paginate(
			async (cursor, signal) => {
				if (invalid) throw invalid;
				return listProjectBranchCustomDomains({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.custom_domains ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/custom-domains */
	register(
		params: CustomDomainsRegisterParams,
	): Promise<Outcome<CustomDomain, DThrow>>;
	register<Throw extends boolean = DThrow>(
		params: CustomDomainsRegisterParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CustomDomain, Throw>>;
	register(
		params: CustomDomainsRegisterParams,
		opts?: CallOptions,
	): Promise<CustomDomain | NeonResult<CustomDomain>> {
		const invalid = validateParams(
			params,
			"functions.customDomains.register",
			{
				projectId: "string",
				branchId: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<CustomDomain>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				registerProjectBranchCustomDomain({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/custom-domains/{domain} */
	delete(params: CustomDomainsDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: CustomDomainsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: CustomDomainsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(
			params,
			"functions.customDomains.delete",
			{
				projectId: "string",
				branchId: "string",
				domain: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, domain } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchCustomDomain({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					domain,
				},
				throwOnError: false,
				signal,
			}),
		);
	}
}
