import {
	deleteProjectBranchBucketObject,
	deleteProjectBranchBucketObjectsByPrefix,
	getProjectBranchBucketObject,
	listProjectBranchBucketObjects,
	presignProjectBranchBucketObject,
} from "../../client/sdk.gen.js";
import type {
	BucketObjectsDeletePrefixResponse,
	BucketObjectsListResponse,
	ListProjectBranchBucketObjectsData,
	PresignRequest,
	PresignResponse,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type ListQuery = Omit<
	NonNullable<ListProjectBranchBucketObjectsData["query"]>,
	"cursor"
>;

export type BucketObjectsListParams = {
	projectId: string;
	branchId: string;
	bucketName: string;
} & ListQuery & { cursor?: string };
export type BucketObjectsGetParams = {
	projectId: string;
	branchId: string;
	bucketName: string;
	objectKey: string;
};
export type BucketObjectsDeleteParams = BucketObjectsGetParams;
export type BucketObjectsDeleteByPrefixParams = {
	projectId: string;
	branchId: string;
	bucketName: string;
	prefix: string;
};
export type BucketObjectsPresignParams = BucketObjectsGetParams &
	PresignRequest;

/** Objects inside a branch bucket. */
export class BucketObjects<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects */
	list(
		params: BucketObjectsListParams,
	): Promise<Outcome<BucketObjectsListResponse, DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: BucketObjectsListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BucketObjectsListResponse, Throw>>;
	list(
		params: BucketObjectsListParams,
		opts?: CallOptions,
	): Promise<
		BucketObjectsListResponse | NeonResult<BucketObjectsListResponse>
	> {
		const invalid = validateParams(params, "storage.objects.list", {
			projectId: "string",
			branchId: "string",
			bucketName: "string",
		});
		if (invalid) {
			return invalidParamsResult<BucketObjectsListResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, bucketName, ...query } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchBucketObjects({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						bucket_name: bucketName,
					},
					query,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects/{object_key}/download */
	get(params: BucketObjectsGetParams): Promise<Outcome<Blob, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: BucketObjectsGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Blob, Throw>>;
	get(
		params: BucketObjectsGetParams,
		opts?: CallOptions,
	): Promise<Blob | NeonResult<Blob>> {
		const invalid = validateParams(params, "storage.objects.get", {
			projectId: "string",
			branchId: "string",
			bucketName: "string",
			objectKey: "string",
		});
		if (invalid) {
			return invalidParamsResult<Blob>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, bucketName, objectKey } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchBucketObject({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						bucket_name: bucketName,
						object_key: objectKey,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects/{object_key} */
	delete(params: BucketObjectsDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: BucketObjectsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: BucketObjectsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "storage.objects.delete", {
			projectId: "string",
			branchId: "string",
			bucketName: "string",
			objectKey: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, bucketName, objectKey } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchBucketObject({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					bucket_name: bucketName,
					object_key: objectKey,
				},
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects-by-prefix */
	deleteByPrefix(
		params: BucketObjectsDeleteByPrefixParams,
	): Promise<Outcome<BucketObjectsDeletePrefixResponse, DThrow>>;
	deleteByPrefix<Throw extends boolean = DThrow>(
		params: BucketObjectsDeleteByPrefixParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BucketObjectsDeletePrefixResponse, Throw>>;
	deleteByPrefix(
		params: BucketObjectsDeleteByPrefixParams,
		opts?: CallOptions,
	): Promise<
		| BucketObjectsDeletePrefixResponse
		| NeonResult<BucketObjectsDeletePrefixResponse>
	> {
		const invalid = validateParams(
			params,
			"storage.objects.deleteByPrefix",
			{
				projectId: "string",
				branchId: "string",
				bucketName: "string",
				prefix: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<BucketObjectsDeletePrefixResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, bucketName, prefix } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				deleteProjectBranchBucketObjectsByPrefix({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						bucket_name: bucketName,
					},
					query: { prefix },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects/{object_key}/presign */
	presign(
		params: BucketObjectsPresignParams,
	): Promise<Outcome<PresignResponse, DThrow>>;
	presign<Throw extends boolean = DThrow>(
		params: BucketObjectsPresignParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<PresignResponse, Throw>>;
	presign(
		params: BucketObjectsPresignParams,
		opts?: CallOptions,
	): Promise<PresignResponse | NeonResult<PresignResponse>> {
		const invalid = validateParams(params, "storage.objects.presign", {
			projectId: "string",
			branchId: "string",
			bucketName: "string",
			objectKey: "string",
		});
		if (invalid) {
			return invalidParamsResult<PresignResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, bucketName, objectKey, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				presignProjectBranchBucketObject({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						bucket_name: bucketName,
						object_key: objectKey,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
