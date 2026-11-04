import {
	createOrgApiKey,
	createOrganizationInvitations,
	deleteOrganizationSpendingLimit,
	getOrganization,
	getOrganizationInvitations,
	getOrganizationMember,
	getOrganizationMembers,
	getOrganizationSpendingLimit,
	listOrgApiKeys,
	removeOrganizationMember,
	revokeOrgApiKey,
	setOrganizationSpendingLimit,
	updateOrganizationMember,
} from "../../client/sdk.gen.js";
import type {
	GetOrganizationMembersData,
	Invitation,
	Member,
	MemberRole,
	MemberWithUser,
	OrgApiKeyCreateResponse,
	OrgApiKeyRevokeResponse,
	OrgApiKeysListResponseItem,
	Organization,
	OrganizationInviteCreateRequest,
	SpendingLimitResponse,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { NeonClientError } from "../errors.js";
import { type Paginated, paginate } from "../paginate.js";
import {
	invalidParamsResult,
	validateCallOptions,
	validateParams,
} from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

/** Every organization call takes an org; it defaults to the client's `orgId`. */
export interface OrganizationParams {
	orgId?: string;
}
export type OrganizationGetParams = OrganizationParams;
export type OrganizationMemberListParams = OrganizationParams &
	Omit<NonNullable<GetOrganizationMembersData["query"]>, "cursor">;
export interface OrganizationMemberGetParams extends OrganizationParams {
	memberId: string;
}
export interface OrganizationMemberUpdateParams extends OrganizationParams {
	memberId: string;
	role: MemberRole;
}
export interface OrganizationMemberRemoveParams extends OrganizationParams {
	memberId: string;
}
export type OrganizationInvitationListParams = OrganizationParams;
export interface OrganizationInvitationCreateParams extends OrganizationParams {
	invitations: OrganizationInviteCreateRequest[];
}
export type OrganizationSpendingLimitGetParams = OrganizationParams;
export interface OrganizationSpendingLimitSetParams extends OrganizationParams {
	/** Monthly cap in cents. Must be positive; use `delete` to clear it. */
	spendingLimitCents: number;
}
export type OrganizationSpendingLimitDeleteParams = OrganizationParams;
export type OrganizationApiKeyListParams = OrganizationParams;
export interface OrganizationApiKeyCreateParams extends OrganizationParams {
	keyName: string;
	/** Restrict the key to one project in the organization. */
	projectId?: string;
}
export interface OrganizationApiKeyRevokeParams extends OrganizationParams {
	keyId: number;
}

/**
 * Validate the named parameters, then resolve the org from them or the client.
 * Returns the org id, or the client error to report before any request is sent.
 */
function resolveOrg(
	ctx: RequestContext,
	params: unknown,
	method: string,
	required: Record<string, "string" | "number" | "array"> = {},
): { orgId: string; error?: undefined } | { error: NeonClientError } {
	const invalid = validateParams(params, method, required);
	if (invalid) return { error: invalid };
	const given =
		typeof params === "object" && params !== null && "orgId" in params
			? params.orgId
			: undefined;
	if (given !== undefined && typeof given !== "string") {
		return {
			error: new NeonClientError(
				`${method} requires orgId to be a string.`,
			),
		};
	}
	const orgId = given ?? ctx.defaults.orgId;
	if (!orgId) {
		return {
			error: new NeonClientError(
				`${method} requires orgId. Pass it in the parameter object or set orgId on the client.`,
			),
		};
	}
	return { orgId };
}

/** Members of an organization and their organization role. */
export class OrganizationMembers<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * List members with the user each one belongs to (cursor-paginated).
	 *
	 * @apiCall GET /organizations/{org_id}/members (cursor-paginated)
	 */
	list(
		params?: OrganizationMemberListParams,
	): Paginated<MemberWithUser, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: OrganizationMemberListParams | undefined,
		opts: CallOptions<Throw>,
	): Paginated<MemberWithUser, Throw>;
	list(
		params: OrganizationMemberListParams = {},
		opts?: CallOptions,
	): Paginated<MemberWithUser, boolean> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.members.list",
		);
		const error = resolved.error ?? validateCallOptions(opts);
		const orgId = resolved.error ? "" : resolved.orgId;
		const query = error
			? {}
			: {
					sort_by: params.sort_by,
					sort_order: params.sort_order,
					limit: params.limit,
				};
		return paginate(
			async (cursor, signal) => {
				if (error) throw error;
				return getOrganizationMembers({
					client: this.#ctx.client,
					path: { org_id: orgId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.members ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
			this.#ctx.client,
		);
	}

	/** @apiCall GET /organizations/{org_id}/members/{member_id} */
	get(params: OrganizationMemberGetParams): Promise<Outcome<Member, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: OrganizationMemberGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Member, Throw>>;
	get(
		params: OrganizationMemberGetParams,
		opts?: CallOptions,
	): Promise<Member | NeonResult<Member>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.members.get",
			{ memberId: "string" },
		);
		if (resolved.error)
			return invalidParamsResult<Member>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getOrganizationMember({
					client,
					path: { org_id: orgId, member_id: params.memberId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Change a member's organization role. Admin only.
	 *
	 * @apiCall PATCH /organizations/{org_id}/members/{member_id}
	 */
	update(
		params: OrganizationMemberUpdateParams,
	): Promise<Outcome<Member, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: OrganizationMemberUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Member, Throw>>;
	update(
		params: OrganizationMemberUpdateParams,
		opts?: CallOptions,
	): Promise<Member | NeonResult<Member>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.members.update",
			{ memberId: "string", role: "string" },
		);
		if (resolved.error)
			return invalidParamsResult<Member>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateOrganizationMember({
					client,
					path: { org_id: orgId, member_id: params.memberId },
					body: { role: params.role },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Remove a member from the organization. Admin only; the last admin cannot be removed.
	 *
	 * @apiCall DELETE /organizations/{org_id}/members/{member_id}
	 */
	remove(
		params: OrganizationMemberRemoveParams,
	): Promise<Outcome<void, DThrow>>;
	remove<Throw extends boolean = DThrow>(
		params: OrganizationMemberRemoveParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	remove(
		params: OrganizationMemberRemoveParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.members.remove",
			{ memberId: "string" },
		);
		if (resolved.error)
			return invalidParamsResult<void>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				removeOrganizationMember({
					client,
					path: { org_id: orgId, member_id: params.memberId },
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}
}

/** Invitations to join an organization. */
export class OrganizationInvitations<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /organizations/{org_id}/invitations */
	list(
		params?: OrganizationInvitationListParams,
	): Promise<Outcome<Invitation[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: OrganizationInvitationListParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Invitation[], Throw>>;
	list(
		params: OrganizationInvitationListParams = {},
		opts?: CallOptions,
	): Promise<Invitation[] | NeonResult<Invitation[]>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.invitations.list",
		);
		if (resolved.error)
			return invalidParamsResult<Invitation[]>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getOrganizationInvitations({
					client,
					path: { org_id: orgId },
					throwOnError: false,
					signal,
				}),
			(data) => data.invitations,
		);
	}

	/**
	 * Invite people by email, each with an organization role. Every invitee is emailed;
	 * one who already has a Neon account joins immediately.
	 *
	 * @apiCall POST /organizations/{org_id}/invitations
	 */
	create(
		params: OrganizationInvitationCreateParams,
	): Promise<Outcome<Invitation[], DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: OrganizationInvitationCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Invitation[], Throw>>;
	create(
		params: OrganizationInvitationCreateParams,
		opts?: CallOptions,
	): Promise<Invitation[] | NeonResult<Invitation[]>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.invitations.create",
			{ invitations: "array" },
		);
		if (resolved.error)
			return invalidParamsResult<Invitation[]>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createOrganizationInvitations({
					client,
					path: { org_id: orgId },
					body: { invitations: params.invitations },
					throwOnError: false,
					signal,
				}),
			(data) => data.invitations,
		);
	}
}

/**
 * The organization's monthly spending limit (Launch and Scale plans). The limit only
 * sends notifications at 80% and 100%; computes keep running past it.
 */
export class OrganizationSpendingLimit<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * `spending_limit_cents` is `null` when no limit is set.
	 *
	 * @apiCall GET /organizations/{org_id}/billing/spending_limit
	 */
	get(
		params?: OrganizationSpendingLimitGetParams,
	): Promise<Outcome<SpendingLimitResponse, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: OrganizationSpendingLimitGetParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<SpendingLimitResponse, Throw>>;
	get(
		params: OrganizationSpendingLimitGetParams = {},
		opts?: CallOptions,
	): Promise<SpendingLimitResponse | NeonResult<SpendingLimitResponse>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.spendingLimit.get",
		);
		if (resolved.error)
			return invalidParamsResult<SpendingLimitResponse>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getOrganizationSpendingLimit({
					client,
					path: { org_id: orgId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Set the monthly limit. Admin only.
	 *
	 * @apiCall PUT /organizations/{org_id}/billing/spending_limit
	 */
	set(
		params: OrganizationSpendingLimitSetParams,
	): Promise<Outcome<SpendingLimitResponse, DThrow>>;
	set<Throw extends boolean = DThrow>(
		params: OrganizationSpendingLimitSetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<SpendingLimitResponse, Throw>>;
	set(
		params: OrganizationSpendingLimitSetParams,
		opts?: CallOptions,
	): Promise<SpendingLimitResponse | NeonResult<SpendingLimitResponse>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.spendingLimit.set",
			{ spendingLimitCents: "number" },
		);
		if (resolved.error)
			return invalidParamsResult<SpendingLimitResponse>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				setOrganizationSpendingLimit({
					client,
					path: { org_id: orgId },
					body: { spending_limit_cents: params.spendingLimitCents },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Clear the limit. Admin only; idempotent.
	 *
	 * @apiCall DELETE /organizations/{org_id}/billing/spending_limit
	 */
	delete(
		params?: OrganizationSpendingLimitDeleteParams,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: OrganizationSpendingLimitDeleteParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: OrganizationSpendingLimitDeleteParams = {},
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.spendingLimit.delete",
		);
		if (resolved.error)
			return invalidParamsResult<void>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				deleteOrganizationSpendingLimit({
					client,
					path: { org_id: orgId },
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}
}

/** API keys owned by an organization rather than a user. */
export class OrganizationApiKeys<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /organizations/{org_id}/api_keys */
	list(
		params?: OrganizationApiKeyListParams,
	): Promise<Outcome<OrgApiKeysListResponseItem[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: OrganizationApiKeyListParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<OrgApiKeysListResponseItem[], Throw>>;
	list(
		params: OrganizationApiKeyListParams = {},
		opts?: CallOptions,
	): Promise<
		OrgApiKeysListResponseItem[] | NeonResult<OrgApiKeysListResponseItem[]>
	> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.apiKeys.list",
		);
		if (resolved.error)
			return invalidParamsResult<OrgApiKeysListResponseItem[]>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listOrgApiKeys({
					client,
					path: { org_id: orgId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Create an organization API key, optionally limited to one project. The returned
	 * `key` token is shown **once** — store it now.
	 *
	 * @apiCall POST /organizations/{org_id}/api_keys
	 */
	create(
		params: OrganizationApiKeyCreateParams,
	): Promise<Outcome<OrgApiKeyCreateResponse, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: OrganizationApiKeyCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<OrgApiKeyCreateResponse, Throw>>;
	create(
		params: OrganizationApiKeyCreateParams,
		opts?: CallOptions,
	): Promise<OrgApiKeyCreateResponse | NeonResult<OrgApiKeyCreateResponse>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.apiKeys.create",
			{ keyName: "string" },
		);
		if (resolved.error)
			return invalidParamsResult<OrgApiKeyCreateResponse>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		const { keyName, projectId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createOrgApiKey({
					client,
					path: { org_id: orgId },
					body: {
						key_name: keyName,
						...(projectId === undefined
							? {}
							: { project_id: projectId }),
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/** @apiCall DELETE /organizations/{org_id}/api_keys/{key_id} */
	revoke(
		params: OrganizationApiKeyRevokeParams,
	): Promise<Outcome<OrgApiKeyRevokeResponse, DThrow>>;
	revoke<Throw extends boolean = DThrow>(
		params: OrganizationApiKeyRevokeParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<OrgApiKeyRevokeResponse, Throw>>;
	revoke(
		params: OrganizationApiKeyRevokeParams,
		opts?: CallOptions,
	): Promise<OrgApiKeyRevokeResponse | NeonResult<OrgApiKeyRevokeResponse>> {
		const resolved = resolveOrg(
			this.#ctx,
			params,
			"organizations.apiKeys.revoke",
			{ keyId: "number" },
		);
		if (resolved.error)
			return invalidParamsResult<OrgApiKeyRevokeResponse>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				revokeOrgApiKey({
					client,
					path: { org_id: orgId, key_id: params.keyId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}

/** Organization details, members, invitations, spending limit, and API keys. */
export class Organizations<DThrow extends boolean> {
	readonly #ctx: RequestContext;
	readonly members: OrganizationMembers<DThrow>;
	readonly invitations: OrganizationInvitations<DThrow>;
	readonly spendingLimit: OrganizationSpendingLimit<DThrow>;
	readonly apiKeys: OrganizationApiKeys<DThrow>;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
		this.members = new OrganizationMembers<DThrow>(ctx);
		this.invitations = new OrganizationInvitations<DThrow>(ctx);
		this.spendingLimit = new OrganizationSpendingLimit<DThrow>(ctx);
		this.apiKeys = new OrganizationApiKeys<DThrow>(ctx);
	}

	/** @apiCall GET /organizations/{org_id} */
	get(params?: OrganizationGetParams): Promise<Outcome<Organization, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: OrganizationGetParams | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Organization, Throw>>;
	get(
		params: OrganizationGetParams = {},
		opts?: CallOptions,
	): Promise<Organization | NeonResult<Organization>> {
		const resolved = resolveOrg(this.#ctx, params, "organizations.get");
		if (resolved.error)
			return invalidParamsResult<Organization>(
				resolved.error,
				this.#ctx.shouldThrow(opts),
			);
		const { orgId } = resolved;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getOrganization({
					client,
					path: { org_id: orgId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
