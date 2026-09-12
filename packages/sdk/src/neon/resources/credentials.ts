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
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = CreateCredentialRequest;

export type CredentialsListParams = { projectId: string; branchId: string };
export type CredentialsCreateParams = {
	projectId: string;
	branchId: string;
} & CreateInput;
export type CredentialsRevokeParams = {
	projectId: string;
	branchId: string;
	tokenId: string;
};
export type CredentialsRevealParams = CredentialsRevokeParams;
export type CredentialsRotateParams = CredentialsRevokeParams;

/** Branch-scoped scoped credentials. */
export class Credentials<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/credentials */
	list(
		params: CredentialsListParams,
	): Promise<Outcome<CredentialMeta[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: CredentialsListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CredentialMeta[], Throw>>;
	list(
		params: CredentialsListParams,
		opts?: CallOptions,
	): Promise<CredentialMeta[] | NeonResult<CredentialMeta[]>> {
		const invalid = validateParams(params, "credentials.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<CredentialMeta[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
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
		params: CredentialsCreateParams,
	): Promise<Outcome<CreateCredentialResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: CredentialsCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CreateCredentialResponse, Throw>>;
	create(
		params: CredentialsCreateParams,
		opts?: CallOptions,
	): Promise<
		CreateCredentialResponse | NeonResult<CreateCredentialResponse>
	> {
		const invalid = validateParams(params, "credentials.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<CreateCredentialResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
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
	revoke(params: CredentialsRevokeParams): Promise<Outcome<void, DThrow>>;
	revoke<Throw extends boolean = DThrow>(
		params: CredentialsRevokeParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	revoke(
		params: CredentialsRevokeParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "credentials.revoke", {
			projectId: "string",
			branchId: "string",
			tokenId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, tokenId } = params;
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

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/credentials/{token_id}/reveal */
	reveal(
		params: CredentialsRevealParams,
	): Promise<Outcome<CredentialSecret, DThrow>>;
	reveal<Throw extends boolean = DThrow>(
		params: CredentialsRevealParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CredentialSecret, Throw>>;
	reveal(
		params: CredentialsRevealParams,
		opts?: CallOptions,
	): Promise<CredentialSecret | NeonResult<CredentialSecret>> {
		const invalid = validateParams(params, "credentials.reveal", {
			projectId: "string",
			branchId: "string",
			tokenId: "string",
		});
		if (invalid) {
			return invalidParamsResult<CredentialSecret>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, tokenId } = params;
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

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/credentials/{token_id}/rotate */
	rotate(
		params: CredentialsRotateParams,
	): Promise<Outcome<RotateCredentialResponse, DThrow>>;
	rotate<Throw extends boolean = DThrow>(
		params: CredentialsRotateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<RotateCredentialResponse, Throw>>;
	rotate(
		params: CredentialsRotateParams,
		opts?: CallOptions,
	): Promise<
		RotateCredentialResponse | NeonResult<RotateCredentialResponse>
	> {
		const invalid = validateParams(params, "credentials.rotate", {
			projectId: "string",
			branchId: "string",
			tokenId: "string",
		});
		if (invalid) {
			return invalidParamsResult<RotateCredentialResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, tokenId } = params;
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
