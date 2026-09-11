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
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = BucketCreateRequest;

export type BucketsListParams = { projectId: string; branchId: string };
export type BucketsCreateParams = {
	projectId: string;
	branchId: string;
} & CreateInput;
export type BucketsDeleteParams = {
	projectId: string;
	branchId: string;
	bucketName: string;
};

/** Branch-scoped object-storage buckets. */
export class Buckets<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/buckets */
	list(params: BucketsListParams): Promise<Outcome<Bucket[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: BucketsListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Bucket[], Throw>>;
	list(
		params: BucketsListParams,
		opts?: CallOptions,
	): Promise<Bucket[] | NeonResult<Bucket[]>> {
		const invalid = validateParams(params, "storage.buckets.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Bucket[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchBuckets({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.buckets,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/buckets */
	create(params: BucketsCreateParams): Promise<Outcome<Bucket, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: BucketsCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Bucket, Throw>>;
	create(
		params: BucketsCreateParams,
		opts?: CallOptions,
	): Promise<Bucket | NeonResult<Bucket>> {
		const invalid = validateParams(params, "storage.buckets.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Bucket>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchBucket({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data.bucket,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name} */
	delete(params: BucketsDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: BucketsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: BucketsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "storage.buckets.delete", {
			projectId: "string",
			branchId: "string",
			bucketName: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, bucketName } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchBucket({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					bucket_name: bucketName,
				},
				throwOnError: false,
				signal,
			}),
		);
	}
}

export type { BucketAccessLevel };
