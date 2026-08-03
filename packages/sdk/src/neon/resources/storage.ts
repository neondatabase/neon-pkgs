import { getProjectBranchStorage } from "../../client/sdk.gen.js";
import type { BranchStorage } from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";
import { BucketObjects } from "./bucket-objects.js";
import { Buckets } from "./buckets.js";

/**
 * Branch-scoped object storage: branch storage state, buckets, and bucket objects.
 * Grouped under `neon.storage.*` so it stays distinct from the Postgres data plane.
 */
export class Storage<DThrow extends boolean> {
	readonly buckets: Buckets<DThrow>;
	readonly objects: BucketObjects<DThrow>;
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.buckets = new Buckets(ctx);
		this.objects = new BucketObjects(ctx);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/storage */
	get(
		projectId: string,
		branchId: string,
	): Promise<Outcome<BranchStorage, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BranchStorage, Throw>>;
	get(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<BranchStorage | NeonResult<BranchStorage>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchStorage({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
