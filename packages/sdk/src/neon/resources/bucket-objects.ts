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
import type { NeonResult, Outcome } from "../result.js";

type ListQuery = Omit<
	NonNullable<ListProjectBranchBucketObjectsData["query"]>,
	"cursor"
>;

/** Objects inside a branch bucket. */
export class BucketObjects<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects */
	list(
		projectId: string,
		branchId: string,
		bucketName: string,
		query?: ListQuery & { cursor?: string },
	): Promise<Outcome<BucketObjectsListResponse, DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		bucketName: string,
		query: (ListQuery & { cursor?: string }) | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BucketObjectsListResponse, Throw>>;
	list(
		projectId: string,
		branchId: string,
		bucketName: string,
		query?: ListQuery & { cursor?: string },
		opts?: CallOptions,
	): Promise<
		BucketObjectsListResponse | NeonResult<BucketObjectsListResponse>
	> {
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
	get(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
	): Promise<Outcome<Blob, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Blob, Throw>>;
	get(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		opts?: CallOptions,
	): Promise<Blob | NeonResult<Blob>> {
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
	delete(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
		projectId: string,
		branchId: string,
		bucketName: string,
		prefix: string,
	): Promise<Outcome<BucketObjectsDeletePrefixResponse, DThrow>>;
	deleteByPrefix<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		bucketName: string,
		prefix: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BucketObjectsDeletePrefixResponse, Throw>>;
	deleteByPrefix(
		projectId: string,
		branchId: string,
		bucketName: string,
		prefix: string,
		opts?: CallOptions,
	): Promise<
		| BucketObjectsDeletePrefixResponse
		| NeonResult<BucketObjectsDeletePrefixResponse>
	> {
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
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		input: PresignRequest,
	): Promise<Outcome<PresignResponse, DThrow>>;
	presign<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		input: PresignRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<PresignResponse, Throw>>;
	presign(
		projectId: string,
		branchId: string,
		bucketName: string,
		objectKey: string,
		input: PresignRequest,
		opts?: CallOptions,
	): Promise<PresignResponse | NeonResult<PresignResponse>> {
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
