import {
	getConsumptionHistoryPerBranchV2,
	getConsumptionHistoryPerProject,
	getConsumptionHistoryPerProjectV2,
} from "../../client/sdk.gen.js";
import type {
	ConsumptionHistoryPerBranchV2,
	ConsumptionHistoryPerProject,
	ConsumptionHistoryPerProjectV2,
	GetConsumptionHistoryPerBranchV2Data,
	GetConsumptionHistoryPerProjectData,
	GetConsumptionHistoryPerProjectV2Data,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { NeonError } from "../errors.js";
import { type Paginated, paginate } from "../paginate.js";

type PerProjectQuery = Omit<
	GetConsumptionHistoryPerProjectData["query"],
	"cursor"
> & { orgId?: string };

type PerProjectV2Query = Omit<
	GetConsumptionHistoryPerProjectV2Data["query"],
	"cursor" | "org_id"
> & { orgId?: string; org_id?: string };

type PerBranchV2Query = Omit<
	GetConsumptionHistoryPerBranchV2Data["query"],
	"cursor" | "org_id"
> & { orgId?: string; org_id?: string };

const MISSING_ORG = "Pass orgId or set orgId on the client.";

function resolvedOrgId(
	query: { orgId?: string; org_id?: string },
	defaultOrgId: string | undefined,
): string | undefined {
	return query.orgId ?? query.org_id ?? defaultOrgId;
}

/** Consumption history (cursor-paginated). */
export class Consumption {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /consumption_history/projects */
	perProject(
		query: PerProjectQuery,
		opts?: CallOptions,
	): Paginated<ConsumptionHistoryPerProject> {
		const { orgId, org_id, ...rest } = query;
		const resolved = resolvedOrgId(
			{ orgId, org_id },
			this.#ctx.defaults.orgId,
		);
		return paginate(
			(cursor, signal) =>
				getConsumptionHistoryPerProject({
					client: this.#ctx.client,
					query: {
						...rest,
						...(resolved === undefined ? {} : { org_id: resolved }),
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

	/** @apiCall GET /consumption_history/v2/projects */
	perProjectV2(
		query: PerProjectV2Query,
		opts?: CallOptions,
	): Paginated<ConsumptionHistoryPerProjectV2> {
		const { orgId, org_id, ...rest } = query;
		const resolved = resolvedOrgId(
			{ orgId, org_id },
			this.#ctx.defaults.orgId,
		);
		return paginate(
			(cursor, signal) => {
				if (resolved === undefined) {
					return Promise.resolve({
						error: new NeonError(MISSING_ORG, "client"),
					});
				}
				return getConsumptionHistoryPerProjectV2({
					client: this.#ctx.client,
					query: { ...rest, org_id: resolved, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.projects ?? [],
				cursor: data?.pagination?.cursor,
			}),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/** @apiCall GET /consumption_history/v2/branches */
	perBranchV2(
		query: PerBranchV2Query,
		opts?: CallOptions,
	): Paginated<ConsumptionHistoryPerBranchV2> {
		const { orgId, org_id, ...rest } = query;
		const resolved = resolvedOrgId(
			{ orgId, org_id },
			this.#ctx.defaults.orgId,
		);
		return paginate(
			(cursor, signal) => {
				if (resolved === undefined) {
					return Promise.resolve({
						error: new NeonError(MISSING_ORG, "client"),
					});
				}
				return getConsumptionHistoryPerBranchV2({
					client: this.#ctx.client,
					query: { ...rest, org_id: resolved, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.branches ?? [],
				cursor: data?.pagination?.cursor,
			}),
			() => this.#ctx.deadlineFor(opts),
		);
	}
}
