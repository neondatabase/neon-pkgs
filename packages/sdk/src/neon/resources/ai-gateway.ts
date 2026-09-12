import { getProjectBranchAiGateway } from "../../client/sdk.gen.js";
import type { BranchAiGateway } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

export type AiGatewayGetParams = {
	projectId: string;
	branchId: string;
};

/** Branch-scoped AI Gateway endpoint metadata. */
export class AiGateway<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/ai_gateway */
	get(params: AiGatewayGetParams): Promise<Outcome<BranchAiGateway, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AiGatewayGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BranchAiGateway, Throw>>;
	get(
		params: AiGatewayGetParams,
		opts?: CallOptions,
	): Promise<BranchAiGateway | NeonResult<BranchAiGateway>> {
		const invalid = validateParams(params, "aiGateway.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<BranchAiGateway>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
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
