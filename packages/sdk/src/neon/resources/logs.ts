import {
	listProjectBranchLogFields,
	listProjectBranchLogFieldValues,
	queryProjectBranchLogs,
} from "../../client/sdk.gen.js";
import type {
	ListProjectBranchLogFieldValuesData,
	ProjectBranchLogFieldValuesResponse,
	ProjectBranchLogRecord,
	ProjectBranchLogsQueryRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";
import type { NeonResult, Outcome } from "../result.js";

/**
 * Filters for {@link Logs.query}.
 *
 * `cursor` is absent because {@link Paginated} owns paging: the endpoint requires
 * every filter and the time window to be repeated unchanged on each page, and
 * threading the cursor here is what guarantees that.
 */
export type LogQueryInput = Omit<ProjectBranchLogsQueryRequest, "cursor">;

/** Query parameters for {@link Logs.fieldValues}. */
export type LogFieldValuesQuery = NonNullable<
	ListProjectBranchLogFieldValuesData["query"]
>;

/**
 * Branch-scoped logs emitted by the services running on a branch — Neon Functions,
 * object storage, and Postgres computes. Grouped under `neon.logs.*` alongside the
 * other branch-scoped product surfaces.
 *
 * Private Beta. A branch that is not collecting telemetry answers `404` with
 * `reason: "telemetry_not_enabled"` rather than an empty result.
 */
export class Logs<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * Query branch logs (cursor-paginated). Every supplied filter is combined with
	 * `AND`.
	 *
	 * Give the window as either `since` or `start_time` — supplying both is
	 * rejected — and treat `logql` as an alternative to the structured filters
	 * rather than an addition to them. With no window the query covers the last
	 * hour, and seven days is the widest range served.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/logs/query (cursor-paginated)
	 */
	query(
		projectId: string,
		branchId: string,
		input?: LogQueryInput,
		opts?: CallOptions,
	): Paginated<ProjectBranchLogRecord> {
		return paginate(
			(cursor, signal) =>
				queryProjectBranchLogs({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					body: { ...input, cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.logs ?? [],
				// `next_cursor` is present but empty on the last page, so truncation
				// is the flag that ends the walk.
				cursor: data?.is_truncated ? data.next_cursor : undefined,
			}),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/**
	 * List the log fields whose values {@link Logs.fieldValues} can enumerate on
	 * this branch. Computed per branch and grows as fields are observed, so read it
	 * rather than assuming a fixed set.
	 *
	 * @apiCall GET /projects/{project_id}/branches/{branch_id}/logs/fields
	 */
	fields(
		projectId: string,
		branchId: string,
	): Promise<Outcome<string[], DThrow>>;
	fields<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<string[], Throw>>;
	fields(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<string[] | NeonResult<string[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchLogFields({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.fields,
		);
	}

	/**
	 * List the distinct values observed for one log field, for use as a filter.
	 * `fieldName` must be one of the names {@link Logs.fields} reports; anything
	 * else is rejected with `unknown_field`.
	 *
	 * The whole response is returned rather than the bare values because
	 * `is_truncated` decides whether the list can be trusted: when it is `true` the
	 * values are an arbitrary subset, and the window or `source` needs narrowing
	 * before filtering on them.
	 *
	 * @apiCall GET /projects/{project_id}/branches/{branch_id}/logs/fields/{field_name}/values
	 */
	fieldValues(
		projectId: string,
		branchId: string,
		fieldName: string,
		query?: LogFieldValuesQuery,
	): Promise<Outcome<ProjectBranchLogFieldValuesResponse, DThrow>>;
	fieldValues<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		fieldName: string,
		query: LogFieldValuesQuery | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ProjectBranchLogFieldValuesResponse, Throw>>;
	fieldValues(
		projectId: string,
		branchId: string,
		fieldName: string,
		query?: LogFieldValuesQuery,
		opts?: CallOptions,
	): Promise<
		| ProjectBranchLogFieldValuesResponse
		| NeonResult<ProjectBranchLogFieldValuesResponse>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchLogFieldValues({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						field_name: fieldName,
					},
					query,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
