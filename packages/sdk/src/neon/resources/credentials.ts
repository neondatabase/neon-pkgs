import {
	createCredential,
	listCredentials,
	revokeCredential,
} from "../../client/sdk.gen.js";
import type {
	CreateCredentialRequest,
	CreateCredentialResponse,
	CredentialMeta,
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
			(client) =>
				listCredentials({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
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
			(client) =>
				createCredential({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
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
		return this.#ctx.runVoid(opts, (client) =>
			revokeCredential({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					token_id: tokenId,
				},
				throwOnError: false,
			}),
		);
	}
}
