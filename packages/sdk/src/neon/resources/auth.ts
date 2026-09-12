import {
	addBranchNeonAuthOauthProvider,
	addBranchNeonAuthTrustedDomain,
	createBranchNeonAuthNewUser,
	createNeonAuth,
	deleteBranchNeonAuthOauthProvider,
	deleteBranchNeonAuthTrustedDomain,
	deleteBranchNeonAuthUser,
	disableNeonAuth,
	getNeonAuth,
	listBranchNeonAuthOauthProviders,
	listBranchNeonAuthTrustedDomains,
	updateBranchNeonAuthOauthProvider,
	updateNeonAuthConfig,
	updateNeonAuthUserRole,
} from "../../client/sdk.gen.js";
import type {
	CreateBranchNeonAuthNewUserRequest,
	EnableNeonAuthIntegrationRequest,
	NeonAuthAddDomainToRedirectUriWhitelistRequest,
	NeonAuthAddOAuthProviderRequest,
	NeonAuthConfigResponse,
	NeonAuthConfigUpdate,
	NeonAuthCreateIntegrationResponse,
	NeonAuthCreateNewUserResponse,
	NeonAuthDeleteDomainFromRedirectUriWhitelistRequest,
	NeonAuthIntegration,
	NeonAuthOauthProvider,
	NeonAuthOauthProviderId,
	NeonAuthRedirectUriWhitelistDomain,
	NeonAuthUpdateOAuthProviderRequest,
	UpdateNeonAuthUserRoleResponse,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

type BranchParams = { projectId: string; branchId: string };

export type AuthOauthProvidersListParams = BranchParams;
export type AuthOauthProvidersAddParams = BranchParams &
	NeonAuthAddOAuthProviderRequest;
export type AuthOauthProvidersUpdateParams = BranchParams & {
	providerId: NeonAuthOauthProviderId;
} & NeonAuthUpdateOAuthProviderRequest;
export type AuthOauthProvidersDeleteParams = BranchParams & {
	providerId: NeonAuthOauthProviderId;
};

export type AuthTrustedDomainsListParams = BranchParams;
export type AuthTrustedDomainsAddParams = BranchParams &
	NeonAuthAddDomainToRedirectUriWhitelistRequest;
export type AuthTrustedDomainsDeleteParams = BranchParams &
	NeonAuthDeleteDomainFromRedirectUriWhitelistRequest;

export type AuthUsersCreateParams = BranchParams &
	CreateBranchNeonAuthNewUserRequest;
export type AuthUsersDeleteParams = BranchParams & { authUserId: string };
export type AuthUsersUpdateRoleParams = BranchParams & {
	authUserId: string;
	roles: string[];
};

export type AuthGetParams = BranchParams;
export type AuthCreateParams = BranchParams & EnableNeonAuthIntegrationRequest;
export type AuthDisableParams = BranchParams & { deleteData?: boolean };
export type AuthUpdateConfigParams = BranchParams & NeonAuthConfigUpdate;

/** Branch-scoped Neon Auth OAuth providers (Google, GitHub, …). */
export class AuthOauthProviders<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/oauth_providers */
	list(
		params: AuthOauthProvidersListParams,
	): Promise<Outcome<NeonAuthOauthProvider[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: AuthOauthProvidersListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOauthProvider[], Throw>>;
	list(
		params: AuthOauthProvidersListParams,
		opts?: CallOptions,
	): Promise<NeonAuthOauthProvider[] | NeonResult<NeonAuthOauthProvider[]>> {
		const invalid = validateParams(params, "auth.oauthProviders.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOauthProvider[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listBranchNeonAuthOauthProviders({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.providers,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/auth/oauth_providers */
	add(
		params: AuthOauthProvidersAddParams,
	): Promise<Outcome<NeonAuthOauthProvider, DThrow>>;
	add<Throw extends boolean = DThrow>(
		params: AuthOauthProvidersAddParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOauthProvider, Throw>>;
	add(
		params: AuthOauthProvidersAddParams,
		opts?: CallOptions,
	): Promise<NeonAuthOauthProvider | NeonResult<NeonAuthOauthProvider>> {
		const invalid = validateParams(params, "auth.oauthProviders.add", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOauthProvider>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				addBranchNeonAuthOauthProvider({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/oauth_providers/{oauth_provider_id} */
	update(
		params: AuthOauthProvidersUpdateParams,
	): Promise<Outcome<NeonAuthOauthProvider, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthOauthProvidersUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOauthProvider, Throw>>;
	update(
		params: AuthOauthProvidersUpdateParams,
		opts?: CallOptions,
	): Promise<NeonAuthOauthProvider | NeonResult<NeonAuthOauthProvider>> {
		const invalid = validateParams(params, "auth.oauthProviders.update", {
			projectId: "string",
			branchId: "string",
			providerId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOauthProvider>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, providerId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateBranchNeonAuthOauthProvider({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						oauth_provider_id: providerId,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE …/auth/oauth_providers/{oauth_provider_id} */
	delete(
		params: AuthOauthProvidersDeleteParams,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: AuthOauthProvidersDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: AuthOauthProvidersDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "auth.oauthProviders.delete", {
			projectId: "string",
			branchId: "string",
			providerId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, providerId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteBranchNeonAuthOauthProvider({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					oauth_provider_id: providerId,
				},
				throwOnError: false,
				signal,
			}),
		);
	}
}

/** Branch-scoped Neon Auth trusted domains (redirect URI whitelist). */
export class AuthTrustedDomains<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET …/auth/trusted_domains */
	list(
		params: AuthTrustedDomainsListParams,
	): Promise<Outcome<NeonAuthRedirectUriWhitelistDomain[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: AuthTrustedDomainsListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthRedirectUriWhitelistDomain[], Throw>>;
	list(
		params: AuthTrustedDomainsListParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthRedirectUriWhitelistDomain[]
		| NeonResult<NeonAuthRedirectUriWhitelistDomain[]>
	> {
		const invalid = validateParams(params, "auth.trustedDomains.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthRedirectUriWhitelistDomain[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listBranchNeonAuthTrustedDomains({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.domains,
		);
	}

	/** @apiCall POST …/auth/trusted_domains */
	add(params: AuthTrustedDomainsAddParams): Promise<Outcome<void, DThrow>>;
	add<Throw extends boolean = DThrow>(
		params: AuthTrustedDomainsAddParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	add(
		params: AuthTrustedDomainsAddParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "auth.trustedDomains.add", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			addBranchNeonAuthTrustedDomain({
				client,
				path: { project_id: projectId, branch_id: branchId },
				body: input,
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall DELETE …/auth/trusted_domains */
	delete(
		params: AuthTrustedDomainsDeleteParams,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: AuthTrustedDomainsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: AuthTrustedDomainsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "auth.trustedDomains.delete", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteBranchNeonAuthTrustedDomain({
				client,
				path: { project_id: projectId, branch_id: branchId },
				body: input,
				throwOnError: false,
				signal,
			}),
		);
	}
}

/** Branch-scoped Neon Auth users. */
export class AuthUsers<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall POST …/auth/users */
	create(
		params: AuthUsersCreateParams,
	): Promise<Outcome<NeonAuthCreateNewUserResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: AuthUsersCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthCreateNewUserResponse, Throw>>;
	create(
		params: AuthUsersCreateParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthCreateNewUserResponse
		| NeonResult<NeonAuthCreateNewUserResponse>
	> {
		const invalid = validateParams(params, "auth.users.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthCreateNewUserResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createBranchNeonAuthNewUser({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE …/auth/users/{auth_user_id} */
	delete(params: AuthUsersDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: AuthUsersDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: AuthUsersDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "auth.users.delete", {
			projectId: "string",
			branchId: "string",
			authUserId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, authUserId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteBranchNeonAuthUser({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					auth_user_id: authUserId,
				},
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall PATCH …/auth/users/{auth_user_id}/role */
	updateRole(
		params: AuthUsersUpdateRoleParams,
	): Promise<Outcome<UpdateNeonAuthUserRoleResponse, DThrow>>;
	updateRole<Throw extends boolean = DThrow>(
		params: AuthUsersUpdateRoleParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<UpdateNeonAuthUserRoleResponse, Throw>>;
	updateRole(
		params: AuthUsersUpdateRoleParams,
		opts?: CallOptions,
	): Promise<
		| UpdateNeonAuthUserRoleResponse
		| NeonResult<UpdateNeonAuthUserRoleResponse>
	> {
		const invalid = validateParams(params, "auth.users.updateRole", {
			projectId: "string",
			branchId: "string",
			authUserId: "string",
			roles: "array",
		});
		if (invalid) {
			return invalidParamsResult<UpdateNeonAuthUserRoleResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, authUserId, roles } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthUserRole({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						auth_user_id: authUserId,
					},
					body: { roles },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}

/**
 * Branch-scoped Neon Auth. Enable/disable the integration, tune its config, and manage
 * OAuth providers, trusted domains, and users. The legacy project-scoped auth endpoints are
 * deprecated and stay raw-only.
 */
export class Auth<DThrow extends boolean> {
	readonly #ctx: RequestContext;
	readonly oauthProviders: AuthOauthProviders<DThrow>;
	readonly trustedDomains: AuthTrustedDomains<DThrow>;
	readonly users: AuthUsers<DThrow>;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.oauthProviders = new AuthOauthProviders<DThrow>(ctx);
		this.trustedDomains = new AuthTrustedDomains<DThrow>(ctx);
		this.users = new AuthUsers<DThrow>(ctx);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth */
	get(params: AuthGetParams): Promise<Outcome<NeonAuthIntegration, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthIntegration, Throw>>;
	get(
		params: AuthGetParams,
		opts?: CallOptions,
	): Promise<NeonAuthIntegration | NeonResult<NeonAuthIntegration>> {
		const invalid = validateParams(params, "auth.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthIntegration>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuth({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/auth */
	create(
		params: AuthCreateParams,
	): Promise<Outcome<NeonAuthCreateIntegrationResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: AuthCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthCreateIntegrationResponse, Throw>>;
	create(
		params: AuthCreateParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthCreateIntegrationResponse
		| NeonResult<NeonAuthCreateIntegrationResponse>
	> {
		const invalid = validateParams(params, "auth.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthCreateIntegrationResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createNeonAuth({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/auth */
	disable(params: AuthDisableParams): Promise<Outcome<void, DThrow>>;
	disable<Throw extends boolean = DThrow>(
		params: AuthDisableParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	disable(
		params: AuthDisableParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "auth.disable", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, deleteData } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			disableNeonAuth({
				client,
				path: { project_id: projectId, branch_id: branchId },
				body: { delete_data: deleteData },
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/auth/config */
	updateConfig(
		params: AuthUpdateConfigParams,
	): Promise<Outcome<NeonAuthConfigResponse, DThrow>>;
	updateConfig<Throw extends boolean = DThrow>(
		params: AuthUpdateConfigParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthConfigResponse, Throw>>;
	updateConfig(
		params: AuthUpdateConfigParams,
		opts?: CallOptions,
	): Promise<NeonAuthConfigResponse | NeonResult<NeonAuthConfigResponse>> {
		const invalid = validateParams(params, "auth.updateConfig", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthConfigResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
