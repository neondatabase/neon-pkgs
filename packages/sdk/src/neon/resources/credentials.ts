import {
	createCredential,
	listCredentials,
	revealCredential,
	revokeCredential,
	rotateCredential,
} from "../../client/sdk.gen.js";
import type {
	CreateCredentialRequest,
	CreateCredentialResponse,
	CredentialMeta,
	CredentialSecret,
	RotateCredentialResponse,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = CreateCredentialRequest;

/** Branch-scoped scoped credentials. */
export class Credentials<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/credentials */
	list(
		projectId: string,
		branchId: string,
	): Promise<Outcome<CredentialMeta[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CredentialMeta[], Throw>>;
	list(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<CredentialMeta[] | NeonResult<CredentialMeta[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listCredentials({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.credentials,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/credentials */
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
	): Promise<Outcome<CreateCredentialResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CreateCredentialResponse, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts?: CallOptions,
	): Promise<
		CreateCredentialResponse | NeonResult<CreateCredentialResponse>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createCredential({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/credentials/{token_id} */
	revoke(
		projectId: string,
		branchId: string,
		tokenId: string,
	): Promise<Outcome<void, DThrow>>;
	revoke<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		tokenId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	revoke(
		projectId: string,
		branchId: string,
		tokenId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client, signal) =>
			revokeCredential({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					token_id: tokenId,
				},
				throwOnError: false,
				signal,
			}),
		);
	}

	/**
	 * Reveal an existing credential's live secrets (`api_token`,
	 * `s3_secret_access_key`). 404 if revoked/expired or not in this project;
	 * 409 if the credential predates secret retrieval — rotate it to obtain one.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/credentials/{token_id}/reveal
	 */
	reveal(
		projectId: string,
		branchId: string,
		tokenId: string,
	): Promise<Outcome<CredentialSecret, DThrow>>;
	reveal<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		tokenId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CredentialSecret, Throw>>;
	reveal(
		projectId: string,
		branchId: string,
		tokenId: string,
		opts?: CallOptions,
	): Promise<CredentialSecret | NeonResult<CredentialSecret>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				revealCredential({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						token_id: tokenId,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Rotate an existing credential: mint new `api_token` /
	 * `s3_secret_access_key` (returned once) while keeping `token_id`, `scopes`
	 * and `branch_id` unchanged.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/credentials/{token_id}/rotate
	 */
	rotate(
		projectId: string,
		branchId: string,
		tokenId: string,
	): Promise<Outcome<RotateCredentialResponse, DThrow>>;
	rotate<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		tokenId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<RotateCredentialResponse, Throw>>;
	rotate(
		projectId: string,
		branchId: string,
		tokenId: string,
		opts?: CallOptions,
	): Promise<
		RotateCredentialResponse | NeonResult<RotateCredentialResponse>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				rotateCredential({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						token_id: tokenId,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
