import {
	getProjectOperation,
	listProjectOperations,
} from "../../client/sdk.gen.js";
import type { Operation } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { type Paginated, paginate } from "../paginate.js";
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
	Omit<CallOptions<Throw>, "requestTimeoutMs" | "waitForReadiness">;

/** Operation resource — read operations and wait for them to finish. */
export class Operations<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/operations (cursor-paginated) */
	list(projectId: string, opts?: CallOptions): Paginated<Operation> {
		return paginate(
			(cursor, signal) =>
				listProjectOperations({
					client: this.#ctx.client,
					path: { project_id: projectId },
					query: { cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.operations ?? [],
				cursor: data?.pagination?.cursor,
			}),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/operations/{operation_id} */
	get(
		projectId: string,
		operationId: string,
	): Promise<Outcome<Operation, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		operationId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Operation, Throw>>;
	get(
		projectId: string,
		operationId: string,
		opts?: CallOptions,
	): Promise<Operation | NeonResult<Operation>> {
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
	waitFor(operations: readonly Operation[]): Promise<Outcome<void, DThrow>>;
	waitFor<Throw extends boolean = DThrow>(
		operations: readonly Operation[],
		opts: WaitForForOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	async waitFor(
		operations: readonly Operation[],
		opts?: WaitForForOptions<boolean>,
	): Promise<void | NeonResult<void>> {
		const defaults = this.#ctx.defaults;
		const shouldThrow = opts?.throwOnError ?? defaults.throwOnError;
		const result = await waitForOperations(this.#ctx.client, operations, {
			pollIntervalMs:
				opts?.pollIntervalMs ?? defaults.waitOptions.pollIntervalMs,
			timeoutMs: opts?.timeoutMs ?? defaults.waitOptions.timeoutMs,
			signal: opts?.signal ?? defaults.waitOptions.signal,
		});
		if (!shouldThrow) return result;
		if (result.error) throw result.error;
		return result.data;
	}
}
