import {
	getProjectOperation,
	listProjectOperations,
} from "../../client/sdk.gen.js";
import type { Operation } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";
import { type WaitForOptions, waitForOperations } from "../wait.js";

/**
 * Options for {@link Operations.waitFor}.
 *
 * `requestTimeoutMs` and `waitForReadiness` are deliberately excluded. Readiness is
 * budgeted by `timeoutMs`, and waiting *is* the readiness step — accepting either would
 * offer a knob that silently did nothing.
 */
export type WaitForForOptions<Throw extends boolean> = WaitForOptions &
	Omit<CallOptions<Throw>, "requestTimeoutMs" | "waitForReadiness" | "wait">;

export type OperationsListParams = { projectId: string };
export type OperationsGetParams = { projectId: string; operationId: string };
export type OperationsWaitForParams = { operations: readonly Operation[] };

/** Operation resource — read operations and wait for them to finish. */
export class Operations<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/operations (cursor-paginated) */
	list(params: OperationsListParams): Paginated<Operation, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: OperationsListParams,
		opts: CallOptions<Throw>,
	): Paginated<Operation, Throw>;
	list(
		params: OperationsListParams,
		opts?: CallOptions,
	): Paginated<Operation, boolean> {
		const invalid = validateParams(params, "operations.list", {
			projectId: "string",
		});
		const { projectId } = invalid ? ({} as OperationsListParams) : params;
		return paginate(
			async (cursor, signal) => {
				if (invalid) throw invalid;
				return listProjectOperations({
					client: this.#ctx.client,
					path: { project_id: projectId },
					query: { cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.operations ?? [],
				cursor: data?.pagination?.cursor,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/operations/{operation_id} */
	get(params: OperationsGetParams): Promise<Outcome<Operation, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: OperationsGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Operation, Throw>>;
	get(
		params: OperationsGetParams,
		opts?: CallOptions,
	): Promise<Operation | NeonResult<Operation>> {
		const invalid = validateParams(params, "operations.get", {
			projectId: "string",
			operationId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Operation>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, operationId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectOperation({
					client,
					path: { project_id: projectId, operation_id: operationId },
					throwOnError: false,
					signal,
				}),
			(data) => data.operation,
		);
	}

	/**
	 * Poll until every given operation reaches a terminal `finished`/`skipped` state.
	 * The primitive behind `waitForReadiness`; use it directly with operations obtained
	 * from any source (e.g. a raw call or a create response).
	 */
	waitFor(params: OperationsWaitForParams): Promise<Outcome<void, DThrow>>;
	waitFor<Throw extends boolean = DThrow>(
		params: OperationsWaitForParams,
		opts: WaitForForOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	async waitFor(
		params: OperationsWaitForParams,
		opts?: WaitForForOptions<boolean>,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "operations.waitFor", {
			operations: "array",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { operations } = params;
		const defaults = this.#ctx.defaults;
		const shouldThrow = opts?.throwOnError ?? defaults.throwOnError;
		const result = await waitForOperations(this.#ctx.client, operations, {
			pollIntervalMs:
				opts?.pollIntervalMs ?? defaults.waitOptions.pollIntervalMs,
			timeoutMs: opts?.timeoutMs ?? defaults.waitOptions.timeoutMs,
			signal: opts?.signal,
		});
		if (!shouldThrow) return result;
		if (result.error) throw result.error;
		return result.data;
	}
}
