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
export class Consumption<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /consumption_history/projects */
	perProject(
		query: PerProjectQuery,
	): Paginated<ConsumptionHistoryPerProject, DThrow>;
	perProject<Throw extends boolean = DThrow>(
		query: PerProjectQuery,
		opts: CallOptions<Throw>,
	): Paginated<ConsumptionHistoryPerProject, Throw>;
	perProject(
		query: PerProjectQuery,
		opts?: CallOptions,
	): Paginated<ConsumptionHistoryPerProject, boolean> {
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
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /consumption_history/v2/projects */
	perProjectV2(
		query: PerProjectV2Query,
	): Paginated<ConsumptionHistoryPerProjectV2, DThrow>;
	perProjectV2<Throw extends boolean = DThrow>(
		query: PerProjectV2Query,
		opts: CallOptions<Throw>,
	): Paginated<ConsumptionHistoryPerProjectV2, Throw>;
	perProjectV2(
		query: PerProjectV2Query,
		opts?: CallOptions,
	): Paginated<ConsumptionHistoryPerProjectV2, boolean> {
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
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /consumption_history/v2/branches */
	perBranchV2(
		query: PerBranchV2Query,
	): Paginated<ConsumptionHistoryPerBranchV2, DThrow>;
	perBranchV2<Throw extends boolean = DThrow>(
		query: PerBranchV2Query,
		opts: CallOptions<Throw>,
	): Paginated<ConsumptionHistoryPerBranchV2, Throw>;
	perBranchV2(
		query: PerBranchV2Query,
		opts?: CallOptions,
	): Paginated<ConsumptionHistoryPerBranchV2, boolean> {
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
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}
}
