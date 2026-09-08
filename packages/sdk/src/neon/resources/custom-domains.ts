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
import type { NeonResult, Outcome } from "../result.js";

type ListQuery = Omit<
	NonNullable<ListProjectBranchCustomDomainsData["query"]>,
	"cursor"
>;
type RegisterInput = CustomDomainRegisterRequest;

/** Branch-scoped custom domains. v1 can only target a function. */
export class CustomDomains<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/custom-domains (cursor-paginated) */
	list(
		projectId: string,
		branchId: string,
		query?: ListQuery,
	): Paginated<CustomDomain, DThrow>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		query: ListQuery | undefined,
		opts: CallOptions<Throw>,
	): Paginated<CustomDomain, Throw>;
	list(
		projectId: string,
		branchId: string,
		query?: ListQuery,
		opts?: CallOptions,
	): Paginated<CustomDomain, boolean> {
		return paginate(
			(cursor, signal) =>
				listProjectBranchCustomDomains({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				}),
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
		projectId: string,
		branchId: string,
		input: RegisterInput,
	): Promise<Outcome<CustomDomain, DThrow>>;
	register<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: RegisterInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CustomDomain, Throw>>;
	register(
		projectId: string,
		branchId: string,
		input: RegisterInput,
		opts?: CallOptions,
	): Promise<CustomDomain | NeonResult<CustomDomain>> {
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
	delete(
		projectId: string,
		branchId: string,
		domain: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		domain: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		domain: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
