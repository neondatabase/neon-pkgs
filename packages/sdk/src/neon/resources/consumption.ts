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
import type { RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";

type PerProjectQuery = Omit<
	GetConsumptionHistoryPerProjectData["query"],
	"cursor"
>;
type PerProjectV2Query = Omit<
	GetConsumptionHistoryPerProjectV2Data["query"],
	"cursor"
>;
type PerBranchV2Query = Omit<
	GetConsumptionHistoryPerBranchV2Data["query"],
	"cursor"
>;

/** Consumption history (cursor-paginated). */
export class Consumption {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /consumption_history/projects */
	perProject(
		query: PerProjectQuery,
	): Paginated<ConsumptionHistoryPerProject> {
		return paginate(
			(cursor, signal) =>
				getConsumptionHistoryPerProject({
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

	/** @apiCall GET /consumption_history/v2/projects */
	perProjectV2(
		query: PerProjectV2Query,
	): Paginated<ConsumptionHistoryPerProjectV2> {
		return paginate(
			(cursor, signal) =>
				getConsumptionHistoryPerProjectV2({
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

	/** @apiCall GET /consumption_history/v2/branches */
	perBranchV2(
		query: PerBranchV2Query,
	): Paginated<ConsumptionHistoryPerBranchV2> {
		return paginate(
			(cursor, signal) =>
				getConsumptionHistoryPerBranchV2({
					client: this.#ctx.client,
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.branches ?? [],
				cursor: data?.pagination?.cursor,
			}),
		);
	}
}
