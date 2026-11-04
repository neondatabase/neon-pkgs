import {
	addBranchNeonAuthOauthProvider,
	addBranchNeonAuthTrustedDomain,
	createBranchNeonAuthNewUser,
	createNeonAuth,
	createNeonAuthOAuthClient,
	deleteBranchNeonAuthOauthProvider,
	deleteBranchNeonAuthTrustedDomain,
	deleteBranchNeonAuthUser,
	deleteNeonAuthOAuthClient,
	disableNeonAuth,
	getNeonAuth,
	getNeonAuthAllowLocalhost,
	getNeonAuthEmailAndPasswordConfig,
	getNeonAuthEmailProvider,
	getNeonAuthOAuthClient,
	getNeonAuthOAuthProviderPlugin,
	getNeonAuthPhoneNumberPlugin,
	getNeonAuthPluginConfigs,
	getNeonAuthWebhookConfig,
	listBranchNeonAuthOauthProviders,
	listBranchNeonAuthTrustedDomains,
	listNeonAuthOAuthClients,
	rotateNeonAuthOAuthClientSecret,
	sendNeonAuthEmailProviderTest,
	updateBranchNeonAuthOauthProvider,
	updateNeonAuthAllowLocalhost,
	updateNeonAuthConfig,
	updateNeonAuthEmailAndPasswordConfig,
	updateNeonAuthEmailProvider,
	updateNeonAuthMagicLinkPlugin,
	updateNeonAuthOAuthClient,
	updateNeonAuthOAuthProviderPlugin,
	updateNeonAuthOrganizationPlugin,
	updateNeonAuthPhoneNumberPlugin,
	updateNeonAuthUserRole,
	updateNeonAuthWebhookConfig,
} from "../../client/sdk.gen.js";
import type {
	CreateBranchNeonAuthNewUserRequest,
	EnableNeonAuthIntegrationRequest,
	NeonAuthAddDomainToRedirectUriWhitelistRequest,
	NeonAuthAddOAuthProviderRequest,
	NeonAuthAllowLocalhostResponse,
	NeonAuthConfigResponse,
	NeonAuthConfigUpdate,
	NeonAuthCreateIntegrationResponse,
	NeonAuthCreateNewUserResponse,
	NeonAuthDeleteDomainFromRedirectUriWhitelistRequest,
	NeonAuthEmailAndPasswordConfig,
	NeonAuthEmailAndPasswordConfigUpdate,
	NeonAuthEmailServerConfig,
	NeonAuthEmailServerConfigResponse,
	NeonAuthIntegration,
	NeonAuthMagicLinkConfig,
	NeonAuthMagicLinkConfigUpdate,
	NeonAuthOAuthClient,
	NeonAuthOAuthClientCreated,
	NeonAuthOAuthClientCreateRequest,
	NeonAuthOAuthClientSecret,
	NeonAuthOAuthClientUpdateRequest,
	NeonAuthOAuthProviderConfig,
	NeonAuthOAuthProviderConfigUpdate,
	NeonAuthOauthProvider,
	NeonAuthOauthProviderId,
	NeonAuthOrganizationConfig,
	NeonAuthOrganizationConfigUpdate,
	NeonAuthPhoneNumberConfig,
	NeonAuthPhoneNumberConfigUpdate,
	NeonAuthPluginConfigs,
	NeonAuthRedirectUriWhitelistDomain,
	NeonAuthUpdateOAuthProviderRequest,
	NeonAuthWebhookConfig,
	SendNeonAuthEmailProviderTestRequest,
	SendNeonAuthTestEmailResponse,
	UpdateNeonAuthAllowLocalhostRequest,
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

export type AuthOauthServerGetParams = BranchParams;
export type AuthOauthServerUpdateParams = BranchParams &
	NeonAuthOAuthProviderConfigUpdate;

export type AuthOauthClientsListParams = BranchParams;
export type AuthOauthClientsGetParams = BranchParams & { clientId: string };
export type AuthOauthClientsCreateParams = BranchParams &
	NeonAuthOAuthClientCreateRequest;
export type AuthOauthClientsUpdateParams = BranchParams & {
	clientId: string;
} & NeonAuthOAuthClientUpdateRequest;
export type AuthOauthClientsDeleteParams = BranchParams & {
	clientId: string;
};
export type AuthOauthClientsRotateSecretParams = BranchParams & {
	clientId: string;
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

export type AuthAllowLocalhostGetParams = BranchParams;
export type AuthAllowLocalhostUpdateParams = BranchParams &
	UpdateNeonAuthAllowLocalhostRequest;

export type AuthEmailAndPasswordGetParams = BranchParams;
export type AuthEmailAndPasswordUpdateParams = BranchParams &
	NeonAuthEmailAndPasswordConfigUpdate;

export type AuthEmailProviderGetParams = BranchParams;
export type AuthEmailProviderUpdateParams = BranchParams &
	NeonAuthEmailServerConfig;
export type AuthEmailProviderSendTestParams = BranchParams &
	SendNeonAuthEmailProviderTestRequest;

export type AuthPluginsGetParams = BranchParams;
export type AuthPluginsMagicLinkUpdateParams = BranchParams &
	NeonAuthMagicLinkConfigUpdate;
export type AuthPluginsOrganizationUpdateParams = BranchParams &
	NeonAuthOrganizationConfigUpdate;
export type AuthPluginsPhoneNumberGetParams = BranchParams;
export type AuthPluginsPhoneNumberUpdateParams = BranchParams &
	NeonAuthPhoneNumberConfigUpdate;

export type AuthWebhooksGetParams = BranchParams;
export type AuthWebhooksUpdateParams = BranchParams & NeonAuthWebhookConfig;

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

/**
 * Branch-scoped Neon Auth OAuth provider plugin. Enabling it makes Neon Auth an OAuth 2.1
 * authorization server (including MCP clients), distinct from the social-login `oauthProviders`.
 */
export class AuthOauthServer<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/plugins/oauth-provider */
	get(
		params: AuthOauthServerGetParams,
	): Promise<Outcome<NeonAuthOAuthProviderConfig, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthOauthServerGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthProviderConfig, Throw>>;
	get(
		params: AuthOauthServerGetParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthOAuthProviderConfig | NeonResult<NeonAuthOAuthProviderConfig>
	> {
		const invalid = validateParams(params, "auth.oauthServer.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthProviderConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthOAuthProviderPlugin({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/plugins/oauth-provider */
	update(
		params: AuthOauthServerUpdateParams,
	): Promise<Outcome<NeonAuthOAuthProviderConfig, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthOauthServerUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthProviderConfig, Throw>>;
	update(
		params: AuthOauthServerUpdateParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthOAuthProviderConfig | NeonResult<NeonAuthOAuthProviderConfig>
	> {
		const invalid = validateParams(params, "auth.oauthServer.update", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthProviderConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthOAuthProviderPlugin({
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

/**
 * Branch-scoped OAuth clients of the Neon Auth OAuth provider plugin (see `oauthServer`).
 * `create` and `rotateSecret` return the client secret once; it cannot be read again.
 */
export class AuthOauthClients<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/oauth-provider/clients */
	list(
		params: AuthOauthClientsListParams,
	): Promise<Outcome<NeonAuthOAuthClient[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: AuthOauthClientsListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthClient[], Throw>>;
	list(
		params: AuthOauthClientsListParams,
		opts?: CallOptions,
	): Promise<NeonAuthOAuthClient[] | NeonResult<NeonAuthOAuthClient[]>> {
		const invalid = validateParams(params, "auth.oauthClients.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthClient[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listNeonAuthOAuthClients({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.clients,
		);
	}

	/** @apiCall GET …/auth/oauth-provider/clients/{client_id} */
	get(
		params: AuthOauthClientsGetParams,
	): Promise<Outcome<NeonAuthOAuthClient, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthOauthClientsGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthClient, Throw>>;
	get(
		params: AuthOauthClientsGetParams,
		opts?: CallOptions,
	): Promise<NeonAuthOAuthClient | NeonResult<NeonAuthOAuthClient>> {
		const invalid = validateParams(params, "auth.oauthClients.get", {
			projectId: "string",
			branchId: "string",
			clientId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthClient>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, clientId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthOAuthClient({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						client_id: clientId,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall POST …/auth/oauth-provider/clients */
	create(
		params: AuthOauthClientsCreateParams,
	): Promise<Outcome<NeonAuthOAuthClientCreated, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: AuthOauthClientsCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthClientCreated, Throw>>;
	create(
		params: AuthOauthClientsCreateParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthOAuthClientCreated | NeonResult<NeonAuthOAuthClientCreated>
	> {
		const invalid = validateParams(params, "auth.oauthClients.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthClientCreated>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createNeonAuthOAuthClient({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/oauth-provider/clients/{client_id} */
	update(
		params: AuthOauthClientsUpdateParams,
	): Promise<Outcome<NeonAuthOAuthClient, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthOauthClientsUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthClient, Throw>>;
	update(
		params: AuthOauthClientsUpdateParams,
		opts?: CallOptions,
	): Promise<NeonAuthOAuthClient | NeonResult<NeonAuthOAuthClient>> {
		const invalid = validateParams(params, "auth.oauthClients.update", {
			projectId: "string",
			branchId: "string",
			clientId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthClient>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, clientId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthOAuthClient({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						client_id: clientId,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE …/auth/oauth-provider/clients/{client_id} */
	delete(
		params: AuthOauthClientsDeleteParams,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: AuthOauthClientsDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: AuthOauthClientsDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "auth.oauthClients.delete", {
			projectId: "string",
			branchId: "string",
			clientId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, clientId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteNeonAuthOAuthClient({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					client_id: clientId,
				},
				throwOnError: false,
				signal,
			}),
		);
	}

	/** @apiCall POST …/auth/oauth-provider/clients/{client_id}/rotate_secret */
	rotateSecret(
		params: AuthOauthClientsRotateSecretParams,
	): Promise<Outcome<NeonAuthOAuthClientSecret, DThrow>>;
	rotateSecret<Throw extends boolean = DThrow>(
		params: AuthOauthClientsRotateSecretParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOAuthClientSecret, Throw>>;
	rotateSecret(
		params: AuthOauthClientsRotateSecretParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthOAuthClientSecret | NeonResult<NeonAuthOAuthClientSecret>
	> {
		const invalid = validateParams(
			params,
			"auth.oauthClients.rotateSecret",
			{
				projectId: "string",
				branchId: "string",
				clientId: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<NeonAuthOAuthClientSecret>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, clientId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				rotateNeonAuthOAuthClientSecret({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						client_id: clientId,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
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

/** Branch-scoped Neon Auth setting that accepts requests from localhost origins. */
export class AuthAllowLocalhost<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/allow_localhost */
	get(
		params: AuthAllowLocalhostGetParams,
	): Promise<Outcome<NeonAuthAllowLocalhostResponse, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthAllowLocalhostGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthAllowLocalhostResponse, Throw>>;
	get(
		params: AuthAllowLocalhostGetParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthAllowLocalhostResponse
		| NeonResult<NeonAuthAllowLocalhostResponse>
	> {
		const invalid = validateParams(params, "auth.allowLocalhost.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthAllowLocalhostResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthAllowLocalhost({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/allow_localhost */
	update(
		params: AuthAllowLocalhostUpdateParams,
	): Promise<Outcome<NeonAuthAllowLocalhostResponse, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthAllowLocalhostUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthAllowLocalhostResponse, Throw>>;
	update(
		params: AuthAllowLocalhostUpdateParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthAllowLocalhostResponse
		| NeonResult<NeonAuthAllowLocalhostResponse>
	> {
		const invalid = validateParams(params, "auth.allowLocalhost.update", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthAllowLocalhostResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthAllowLocalhost({
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

/** Branch-scoped Neon Auth email and password sign-in settings. */
export class AuthEmailAndPassword<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/email_and_password */
	get(
		params: AuthEmailAndPasswordGetParams,
	): Promise<Outcome<NeonAuthEmailAndPasswordConfig, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthEmailAndPasswordGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthEmailAndPasswordConfig, Throw>>;
	get(
		params: AuthEmailAndPasswordGetParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthEmailAndPasswordConfig
		| NeonResult<NeonAuthEmailAndPasswordConfig>
	> {
		const invalid = validateParams(params, "auth.emailAndPassword.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthEmailAndPasswordConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthEmailAndPasswordConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/email_and_password */
	update(
		params: AuthEmailAndPasswordUpdateParams,
	): Promise<Outcome<NeonAuthEmailAndPasswordConfig, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthEmailAndPasswordUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthEmailAndPasswordConfig, Throw>>;
	update(
		params: AuthEmailAndPasswordUpdateParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthEmailAndPasswordConfig
		| NeonResult<NeonAuthEmailAndPasswordConfig>
	> {
		const invalid = validateParams(params, "auth.emailAndPassword.update", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthEmailAndPasswordConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthEmailAndPasswordConfig({
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

/**
 * Branch-scoped Neon Auth email provider: Neon's shared sender or your own SMTP server.
 * `update` responses carry an empty `password`; `get` may return it, depending on the
 * caller's permissions.
 */
export class AuthEmailProvider<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/email_provider */
	get(
		params: AuthEmailProviderGetParams,
	): Promise<Outcome<NeonAuthEmailServerConfigResponse, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthEmailProviderGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthEmailServerConfigResponse, Throw>>;
	get(
		params: AuthEmailProviderGetParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthEmailServerConfigResponse
		| NeonResult<NeonAuthEmailServerConfigResponse>
	> {
		const invalid = validateParams(params, "auth.emailProvider.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthEmailServerConfigResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthEmailProvider({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/email_provider */
	update(
		params: AuthEmailProviderUpdateParams,
	): Promise<Outcome<NeonAuthEmailServerConfigResponse, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthEmailProviderUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthEmailServerConfigResponse, Throw>>;
	update(
		params: AuthEmailProviderUpdateParams,
		opts?: CallOptions,
	): Promise<
		| NeonAuthEmailServerConfigResponse
		| NeonResult<NeonAuthEmailServerConfigResponse>
	> {
		const invalid = validateParams(params, "auth.emailProvider.update", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthEmailServerConfigResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthEmailProvider({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall POST …/auth/email_provider/test */
	sendTest(
		params: AuthEmailProviderSendTestParams,
	): Promise<Outcome<SendNeonAuthTestEmailResponse, DThrow>>;
	sendTest<Throw extends boolean = DThrow>(
		params: AuthEmailProviderSendTestParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<SendNeonAuthTestEmailResponse, Throw>>;
	sendTest(
		params: AuthEmailProviderSendTestParams,
		opts?: CallOptions,
	): Promise<
		| SendNeonAuthTestEmailResponse
		| NeonResult<SendNeonAuthTestEmailResponse>
	> {
		const invalid = validateParams(params, "auth.emailProvider.sendTest", {
			projectId: "string",
			branchId: "string",
			recipient_email: "string",
		});
		if (invalid) {
			return invalidParamsResult<SendNeonAuthTestEmailResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, recipient_email } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				sendNeonAuthEmailProviderTest({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { recipient_email },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}

/** Branch-scoped Neon Auth magic link plugin. Read it through `plugins.get`. */
export class AuthPluginsMagicLink<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/auth/plugins/magic-link */
	update(
		params: AuthPluginsMagicLinkUpdateParams,
	): Promise<Outcome<NeonAuthMagicLinkConfig, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthPluginsMagicLinkUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthMagicLinkConfig, Throw>>;
	update(
		params: AuthPluginsMagicLinkUpdateParams,
		opts?: CallOptions,
	): Promise<NeonAuthMagicLinkConfig | NeonResult<NeonAuthMagicLinkConfig>> {
		const invalid = validateParams(
			params,
			"auth.plugins.magicLink.update",
			{
				projectId: "string",
				branchId: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<NeonAuthMagicLinkConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthMagicLinkPlugin({
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

/**
 * Branch-scoped Neon Auth organization plugin (Better Auth organizations inside your app,
 * not Neon organizations). Read it through `plugins.get`.
 */
export class AuthPluginsOrganization<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/auth/plugins/organization */
	update(
		params: AuthPluginsOrganizationUpdateParams,
	): Promise<Outcome<NeonAuthOrganizationConfig, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthPluginsOrganizationUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthOrganizationConfig, Throw>>;
	update(
		params: AuthPluginsOrganizationUpdateParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthOrganizationConfig | NeonResult<NeonAuthOrganizationConfig>
	> {
		const invalid = validateParams(
			params,
			"auth.plugins.organization.update",
			{
				projectId: "string",
				branchId: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<NeonAuthOrganizationConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthOrganizationPlugin({
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

/** Branch-scoped Neon Auth phone number (SMS OTP) plugin. */
export class AuthPluginsPhoneNumber<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/plugins/phone-number */
	get(
		params: AuthPluginsPhoneNumberGetParams,
	): Promise<Outcome<NeonAuthPhoneNumberConfig, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthPluginsPhoneNumberGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthPhoneNumberConfig, Throw>>;
	get(
		params: AuthPluginsPhoneNumberGetParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthPhoneNumberConfig | NeonResult<NeonAuthPhoneNumberConfig>
	> {
		const invalid = validateParams(params, "auth.plugins.phoneNumber.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthPhoneNumberConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthPhoneNumberPlugin({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PATCH …/auth/plugins/phone-number */
	update(
		params: AuthPluginsPhoneNumberUpdateParams,
	): Promise<Outcome<NeonAuthPhoneNumberConfig, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthPluginsPhoneNumberUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthPhoneNumberConfig, Throw>>;
	update(
		params: AuthPluginsPhoneNumberUpdateParams,
		opts?: CallOptions,
	): Promise<
		NeonAuthPhoneNumberConfig | NeonResult<NeonAuthPhoneNumberConfig>
	> {
		const invalid = validateParams(
			params,
			"auth.plugins.phoneNumber.update",
			{
				projectId: "string",
				branchId: "string",
			},
		);
		if (invalid) {
			return invalidParamsResult<NeonAuthPhoneNumberConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthPhoneNumberPlugin({
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

/**
 * Branch-scoped Neon Auth plugins. `get` returns every plugin's configuration in one
 * response, including the email provider (with its `password` field) and the OAuth
 * providers (with `client_secret`).
 */
export class AuthPlugins<DThrow extends boolean> {
	readonly #ctx: RequestContext;
	readonly magicLink: AuthPluginsMagicLink<DThrow>;
	readonly organization: AuthPluginsOrganization<DThrow>;
	readonly phoneNumber: AuthPluginsPhoneNumber<DThrow>;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.magicLink = new AuthPluginsMagicLink<DThrow>(ctx);
		this.organization = new AuthPluginsOrganization<DThrow>(ctx);
		this.phoneNumber = new AuthPluginsPhoneNumber<DThrow>(ctx);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/plugins */
	get(
		params: AuthPluginsGetParams,
	): Promise<Outcome<NeonAuthPluginConfigs, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthPluginsGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthPluginConfigs, Throw>>;
	get(
		params: AuthPluginsGetParams,
		opts?: CallOptions,
	): Promise<NeonAuthPluginConfigs | NeonResult<NeonAuthPluginConfigs>> {
		const invalid = validateParams(params, "auth.plugins.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthPluginConfigs>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthPluginConfigs({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}

/** Branch-scoped Neon Auth webhook. `update` replaces the whole configuration. */
export class AuthWebhooks<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/auth/webhooks */
	get(
		params: AuthWebhooksGetParams,
	): Promise<Outcome<NeonAuthWebhookConfig, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: AuthWebhooksGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthWebhookConfig, Throw>>;
	get(
		params: AuthWebhooksGetParams,
		opts?: CallOptions,
	): Promise<NeonAuthWebhookConfig | NeonResult<NeonAuthWebhookConfig>> {
		const invalid = validateParams(params, "auth.webhooks.get", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthWebhookConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getNeonAuthWebhookConfig({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall PUT …/auth/webhooks */
	update(
		params: AuthWebhooksUpdateParams,
	): Promise<Outcome<NeonAuthWebhookConfig, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: AuthWebhooksUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonAuthWebhookConfig, Throw>>;
	update(
		params: AuthWebhooksUpdateParams,
		opts?: CallOptions,
	): Promise<NeonAuthWebhookConfig | NeonResult<NeonAuthWebhookConfig>> {
		const invalid = validateParams(params, "auth.webhooks.update", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<NeonAuthWebhookConfig>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateNeonAuthWebhookConfig({
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

/**
 * Branch-scoped Neon Auth. Enable/disable the integration, tune its config, and manage
 * OAuth providers, the OAuth server (provider plugin) and its clients, trusted domains,
 * users, sign-in settings, the email provider, plugins, and the webhook. The legacy
 * project-scoped auth endpoints are deprecated and stay raw-only.
 */
export class Auth<DThrow extends boolean> {
	readonly #ctx: RequestContext;
	readonly oauthProviders: AuthOauthProviders<DThrow>;
	readonly oauthServer: AuthOauthServer<DThrow>;
	readonly oauthClients: AuthOauthClients<DThrow>;
	readonly trustedDomains: AuthTrustedDomains<DThrow>;
	readonly users: AuthUsers<DThrow>;
	readonly allowLocalhost: AuthAllowLocalhost<DThrow>;
	readonly emailAndPassword: AuthEmailAndPassword<DThrow>;
	readonly emailProvider: AuthEmailProvider<DThrow>;
	readonly plugins: AuthPlugins<DThrow>;
	readonly webhooks: AuthWebhooks<DThrow>;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.oauthProviders = new AuthOauthProviders<DThrow>(ctx);
		this.oauthServer = new AuthOauthServer<DThrow>(ctx);
		this.oauthClients = new AuthOauthClients<DThrow>(ctx);
		this.trustedDomains = new AuthTrustedDomains<DThrow>(ctx);
		this.users = new AuthUsers<DThrow>(ctx);
		this.allowLocalhost = new AuthAllowLocalhost<DThrow>(ctx);
		this.emailAndPassword = new AuthEmailAndPassword<DThrow>(ctx);
		this.emailProvider = new AuthEmailProvider<DThrow>(ctx);
		this.plugins = new AuthPlugins<DThrow>(ctx);
		this.webhooks = new AuthWebhooks<DThrow>(ctx);
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
