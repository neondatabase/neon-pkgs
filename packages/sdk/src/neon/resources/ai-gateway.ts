import { getProjectBranchAiGateway } from "../../client/sdk.gen.js";
import type { BranchAiGateway } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

/** Branch-scoped AI Gateway endpoint metadata. */
export class AiGateway<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/ai_gateway */
	get(
		projectId: string,
		branchId: string,
	): Promise<Outcome<BranchAiGateway, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BranchAiGateway, Throw>>;
	get(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<BranchAiGateway | NeonResult<BranchAiGateway>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchAiGateway({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
