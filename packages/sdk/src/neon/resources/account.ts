import {
	createApiKey,
	getActiveRegions,
	getCurrentUserInfo,
	getCurrentUserOrganizations,
	listApiKeys,
	revokeApiKey,
} from "../../client/sdk.gen.js";
import type {
	ApiKeyCreateResponse,
	ApiKeyRevokeResponse,
	ApiKeysListResponseItem,
	CurrentUserInfoResponse,
	Organization,
	RegionResponse,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

/** Current user / account resource. */
export class User<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /users/me */
	me(): Promise<Outcome<CurrentUserInfoResponse, DThrow>>;
	me<Throw extends boolean = DThrow>(
		opts: CallOptions<Throw>,
	): Promise<Outcome<CurrentUserInfoResponse, Throw>>;
	me(
		opts?: CallOptions,
	): Promise<CurrentUserInfoResponse | NeonResult<CurrentUserInfoResponse>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getCurrentUserInfo({ client, throwOnError: false, signal }),
			(data) => data,
		);
	}

	/** @apiCall GET /users/me/organizations */
	organizations(): Promise<Outcome<Organization[], DThrow>>;
	organizations<Throw extends boolean = DThrow>(
		opts: CallOptions<Throw>,
	): Promise<Outcome<Organization[], Throw>>;
	organizations(
		opts?: CallOptions,
	): Promise<Organization[] | NeonResult<Organization[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getCurrentUserOrganizations({
					client,
					throwOnError: false,
					signal,
				}),
			(data) => data.organizations,
		);
	}
}

/** Active regions. */
export class Regions<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /regions */
	list(): Promise<Outcome<RegionResponse[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		opts: CallOptions<Throw>,
	): Promise<Outcome<RegionResponse[], Throw>>;
	list(
		opts?: CallOptions,
	): Promise<RegionResponse[] | NeonResult<RegionResponse[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getActiveRegions({ client, throwOnError: false, signal }),
			(data) => data.regions,
		);
	}
}

/** Account API keys. */
export class ApiKeys<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /api_keys */
	list(): Promise<Outcome<ApiKeysListResponseItem[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		opts: CallOptions<Throw>,
	): Promise<Outcome<ApiKeysListResponseItem[], Throw>>;
	list(
		opts?: CallOptions,
	): Promise<
		ApiKeysListResponseItem[] | NeonResult<ApiKeysListResponseItem[]>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listApiKeys({ client, throwOnError: false, signal }),
			(data) => data,
		);
	}

	/**
	 * Create an API key. The returned `key` token is shown **once** — store it now.
	 *
	 * @apiCall POST /api_keys
	 */
	create(keyName: string): Promise<Outcome<ApiKeyCreateResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		keyName: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ApiKeyCreateResponse, Throw>>;
	create(
		keyName: string,
		opts?: CallOptions,
	): Promise<ApiKeyCreateResponse | NeonResult<ApiKeyCreateResponse>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createApiKey({
					client,
					body: { key_name: keyName },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /api_keys/{key_id} */
	revoke(keyId: number): Promise<Outcome<ApiKeyRevokeResponse, DThrow>>;
	revoke<Throw extends boolean = DThrow>(
		keyId: number,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ApiKeyRevokeResponse, Throw>>;
	revoke(
		keyId: number,
		opts?: CallOptions,
	): Promise<ApiKeyRevokeResponse | NeonResult<ApiKeyRevokeResponse>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				revokeApiKey({
					client,
					path: { key_id: keyId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
