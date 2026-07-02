import {
	createProjectBranchBucket,
	deleteProjectBranchBucket,
	listProjectBranchBuckets,
} from "../../client/sdk.gen.js";
import type {
	Bucket,
	BucketAccessLevel,
	BucketCreateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = BucketCreateRequest;

/** Branch-scoped object-storage buckets. */
export class Buckets<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/buckets */
	list(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Bucket[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Bucket[], Throw>>;
	list(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Bucket[] | NeonResult<Bucket[]>> {
		return this.#ctx.run(
			opts,
			(client) =>
				listProjectBranchBuckets({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data.buckets,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/buckets */
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
	): Promise<Outcome<Bucket, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Bucket, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts?: CallOptions,
	): Promise<Bucket | NeonResult<Bucket>> {
		return this.#ctx.run(
			opts,
			(client) =>
				createProjectBranchBucket({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
				}),
			(data) => data.bucket,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name} */
	delete(
		projectId: string,
		branchId: string,
		bucketName: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		bucketName: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		bucketName: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client) =>
			deleteProjectBranchBucket({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					bucket_name: bucketName,
				},
				throwOnError: false,
			}),
		);
	}
}

export type { BucketAccessLevel };
