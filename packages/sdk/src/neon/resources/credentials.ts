import {
	createCredential,
	listCredentials,
	revokeCredential,
} from "../../client/sdk.gen.js";
import type {
	CreateCredentialResponse,
	CredentialMeta,
	CredentialScope,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

export interface CredentialCreateInput {
	name?: string;
	scopes: Array<CredentialScope>;
}

function mapCredentialCreate(input: CredentialCreateInput) {
	return {
		...(input.name !== undefined ? { name: input.name } : {}),
		scopes: input.scopes,
		principal_type: "user" as const,
	};
}

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
		input: CredentialCreateInput,
	): Promise<Outcome<CreateCredentialResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CredentialCreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<CreateCredentialResponse, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CredentialCreateInput,
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
					body: mapCredentialCreate(input),
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
}
