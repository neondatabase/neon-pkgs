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
import { type Paginated, paginate } from "../paginate.js";
import type { NeonResult, Outcome } from "../result.js";

/** Branch-scoped Neon Auth OAuth providers (Google, GitHub, …). */
export class AuthOauthProviders<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/oauth_providers */
	list(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Paginated<NeonAuthOauthProvider> {
		return paginate(
			(_cursor, signal) =>
				listBranchNeonAuthOauthProviders({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => ({ items: data?.providers ?? [] }),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/auth/oauth_providers */
	add(
		projectId: string,
		branchId: string,
		input: NeonAuthAddOAuthProviderRequest,
	): Promise<Outcome<NeonAuthOauthProvider, DThrow>>;
	add<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: NeonAuthAddOAuthProviderRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOauthProvider, Throw>>;
	add(
		projectId: string,
		branchId: string,
		input: NeonAuthAddOAuthProviderRequest,
		opts?: CallOptions,
	): Promise<NeonAuthOauthProvider | NeonResult<NeonAuthOauthProvider>> {
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
		projectId: string,
		branchId: string,
		providerId: NeonAuthOauthProviderId,
		input: NeonAuthUpdateOAuthProviderRequest,
	): Promise<Outcome<NeonAuthOauthProvider, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		providerId: NeonAuthOauthProviderId,
		input: NeonAuthUpdateOAuthProviderRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOauthProvider, Throw>>;
	update(
		projectId: string,
		branchId: string,
		providerId: NeonAuthOauthProviderId,
		input: NeonAuthUpdateOAuthProviderRequest,
		opts?: CallOptions,
	): Promise<NeonAuthOauthProvider | NeonResult<NeonAuthOauthProvider>> {
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
		projectId: string,
		branchId: string,
		providerId: NeonAuthOauthProviderId,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		providerId: NeonAuthOauthProviderId,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		providerId: NeonAuthOauthProviderId,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Paginated<NeonAuthRedirectUriWhitelistDomain> {
		return paginate(
			(_cursor, signal) =>
				listBranchNeonAuthTrustedDomains({
					client: this.#ctx.client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => ({ items: data?.domains ?? [] }),
			() => this.#ctx.deadlineFor(opts),
		);
	}

	/** @apiCall POST …/auth/trusted_domains */
	add(
		projectId: string,
		branchId: string,
		input: NeonAuthAddDomainToRedirectUriWhitelistRequest,
	): Promise<Outcome<void, DThrow>>;
	add<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: NeonAuthAddDomainToRedirectUriWhitelistRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	add(
		projectId: string,
		branchId: string,
		input: NeonAuthAddDomainToRedirectUriWhitelistRequest,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
		projectId: string,
		branchId: string,
		input: NeonAuthDeleteDomainFromRedirectUriWhitelistRequest,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: NeonAuthDeleteDomainFromRedirectUriWhitelistRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		input: NeonAuthDeleteDomainFromRedirectUriWhitelistRequest,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
		projectId: string,
		branchId: string,
		input: CreateBranchNeonAuthNewUserRequest,
	): Promise<Outcome<NeonAuthCreateNewUserResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateBranchNeonAuthNewUserRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthCreateNewUserResponse, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CreateBranchNeonAuthNewUserRequest,
		opts?: CallOptions,
	): Promise<
		| NeonAuthCreateNewUserResponse
		| NeonResult<NeonAuthCreateNewUserResponse>
	> {
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
	delete(
		projectId: string,
		branchId: string,
		authUserId: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		authUserId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		authUserId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
		projectId: string,
		branchId: string,
		authUserId: string,
		roles: string[],
	): Promise<Outcome<UpdateNeonAuthUserRoleResponse, DThrow>>;
	updateRole<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		authUserId: string,
		roles: string[],
		opts: CallOptions<Throw>,
	): Promise<Outcome<UpdateNeonAuthUserRoleResponse, Throw>>;
	updateRole(
		projectId: string,
		branchId: string,
		authUserId: string,
		roles: string[],
		opts?: CallOptions,
	): Promise<
		| UpdateNeonAuthUserRoleResponse
		| NeonResult<UpdateNeonAuthUserRoleResponse>
	> {
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
	get(
		projectId: string,
		branchId: string,
	): Promise<Outcome<NeonAuthIntegration, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthIntegration, Throw>>;
	get(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<NeonAuthIntegration | NeonResult<NeonAuthIntegration>> {
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
		projectId: string,
		branchId: string,
		input: EnableNeonAuthIntegrationRequest,
	): Promise<Outcome<NeonAuthCreateIntegrationResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: EnableNeonAuthIntegrationRequest,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthCreateIntegrationResponse, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: EnableNeonAuthIntegrationRequest,
		opts?: CallOptions,
	): Promise<
		| NeonAuthCreateIntegrationResponse
		| NeonResult<NeonAuthCreateIntegrationResponse>
	> {
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
	disable(
		projectId: string,
		branchId: string,
		input?: { deleteData?: boolean },
	): Promise<Outcome<void, DThrow>>;
	disable<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: { deleteData?: boolean } | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	disable(
		projectId: string,
		branchId: string,
		input?: { deleteData?: boolean },
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client, signal) =>
			disableNeonAuth({
				client,
				path: { project_id: projectId, branch_id: branchId },
				body: { delete_data: input?.deleteData },
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/auth/config */
	updateConfig(
		projectId: string,
		branchId: string,
		input: NeonAuthConfigUpdate,
	): Promise<Outcome<NeonAuthConfigResponse, DThrow>>;
	updateConfig<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: NeonAuthConfigUpdate,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthConfigResponse, Throw>>;
	updateConfig(
		projectId: string,
		branchId: string,
		input: NeonAuthConfigUpdate,
		opts?: CallOptions,
	): Promise<NeonAuthConfigResponse | NeonResult<NeonAuthConfigResponse>> {
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
