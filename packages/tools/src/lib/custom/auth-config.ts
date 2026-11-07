import {
	type Branch,
	NeonApiError,
	type NeonAuthEmailAndPasswordConfig,
	type NeonAuthEmailServerConfigResponse,
	type NeonAuthOauthProvider,
	type NeonAuthPluginConfigs,
	type NeonAuthWebhookConfig,
	type NeonClient,
} from "@neon/sdk";
import * as z from "zod";
import * as zod from "../../generated/zod.gen.js";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";

export const REDACTED_SECRET = "***redacted***";

export const getAuthConfigInputSchema = z.strictObject({
	project_id: zod.zGetNeonAuthPath.shape.project_id,
	branch_id: zod.zGetNeonAuthPath.shape.branch_id
		.describe("Branch ID. If omitted, the project default branch is used.")
		.optional(),
});

/** The API's inverted flags are renamed so `allow_sign_up: true` means sign-up is allowed. */
const emailPasswordSettings = (data: NeonAuthEmailAndPasswordConfig) => ({
	enabled: data.enabled,
	allow_sign_up: !data.disable_sign_up,
	verify_email_on_sign_up: data.send_verification_email_on_sign_up,
	verify_email_on_sign_in: data.send_verification_email_on_sign_in,
	email_verification_method: data.email_verification_method,
	require_email_verification: data.require_email_verification,
	auto_sign_in_after_verification: data.auto_sign_in_after_verification,
	revoke_sessions_on_password_reset: data.revoke_sessions_on_password_reset,
});

const oauthProviderSettings = (provider: NeonAuthOauthProvider) => ({
	id: provider.id,
	type: provider.type,
	client_id: provider.client_id ?? null,
	client_secret: provider.client_secret ? REDACTED_SECRET : null,
	...(provider.microsoft_tenant_id && {
		microsoft_tenant_id: provider.microsoft_tenant_id,
	}),
	...(provider.apple_team_id && { apple_team_id: provider.apple_team_id }),
	...(provider.apple_key_id && { apple_key_id: provider.apple_key_id }),
});

const emailProviderSettings = (data: NeonAuthEmailServerConfigResponse) => {
	if (data.type === "standard") {
		if (
			data.host === undefined ||
			data.port === undefined ||
			data.username === undefined
		) {
			throw new Error(
				"Standard email provider is missing host, port, or username",
			);
		}
		return {
			type: "standard" as const,
			host: data.host,
			port: data.port,
			username: data.username,
			password: REDACTED_SECRET,
			sender_email: data.sender_email,
			sender_name: data.sender_name,
		};
	}
	return {
		type: "shared" as const,
		sender_email: data.sender_email ?? null,
		sender_name: data.sender_name ?? null,
	};
};

const pluginSettings = (data: NeonAuthPluginConfigs) => ({
	organization: data.organization ?? null,
	magic_link: data.magic_link ?? null,
	phone_number: data.phone_number ?? null,
});

type SettingRead<T> =
	| { ok: true; data: T }
	| { ok: false; error: NeonApiError };

const ERROR_SNIPPET_MAX_LENGTH = 200;

/** A short, single-line hint from an API error body, so an HTML error page never lands in the result. */
const errorBodySnippet = (body: unknown): string | undefined => {
	let text: string | undefined;
	if (typeof body === "string") {
		text = body;
	} else if (typeof body === "object" && body !== null) {
		for (const key of ["message", "error", "detail"]) {
			const value: unknown = Reflect.get(body, key);
			if (typeof value === "string") {
				text = value;
				break;
			}
		}
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removes control characters from API error bodies
	const cleaned = text?.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > ERROR_SNIPPET_MAX_LENGTH
		? `${cleaned.slice(0, ERROR_SNIPPET_MAX_LENGTH)}…`
		: cleaned;
};

const describeReadError = (error: NeonApiError): string => {
	const snippet =
		error.status === 404 ? undefined : errorBodySnippet(error.body);
	return `${error.status} ${snippet ? `${error.message}: ${snippet}` : error.message}`;
};

/** Email provider, plugins, and webhook are optional reads: an API error is reported under `_errors` instead of failing the tool. */
const optionalRead = async <T>(
	read: () => Promise<T>,
): Promise<SettingRead<T>> => {
	try {
		return { ok: true, data: await read() };
	} catch (error) {
		if (error instanceof NeonApiError) return { ok: false, error };
		throw error;
	}
};

export const readAuthConfig = async (
	neon: NeonClient<true>,
	input: z.output<typeof getAuthConfigInputSchema>,
	signal?: AbortSignal,
) => {
	const projectId = input.project_id;
	let defaultBranch: Branch | undefined;
	let branchId: string;
	if (input.branch_id === undefined) {
		defaultBranch = await neon.branches.getDefault(
			{ projectId },
			{ signal },
		);
		branchId = defaultBranch.id;
	} else {
		branchId = input.branch_id;
	}
	const ids = { projectId, branchId };

	const integration = await neon.auth.get(ids, { signal });
	const [
		domains,
		localhost,
		emailPassword,
		oauthProviders,
		emailProvider,
		plugins,
		webhook,
		branch,
	] = await Promise.all([
		neon.auth.trustedDomains.list(ids, { signal }),
		neon.auth.allowLocalhost.get(ids, { signal }),
		neon.auth.emailAndPassword.get(ids, { signal }),
		neon.auth.oauthProviders.list(ids, { signal }),
		optionalRead(() => neon.auth.emailProvider.get(ids, { signal })),
		optionalRead(() => neon.auth.plugins.get(ids, { signal })),
		optionalRead(() => neon.auth.webhooks.get(ids, { signal })),
		defaultBranch ?? neon.branches.get(ids, { signal }),
	]);

	const errors: Record<string, string> = {};
	let emailProviderValue: ReturnType<typeof emailProviderSettings> | null =
		null;
	if (emailProvider.ok) {
		emailProviderValue = emailProviderSettings(emailProvider.data);
	} else if (emailProvider.error.status !== 404) {
		errors.email_provider = describeReadError(emailProvider.error);
	}
	let pluginsValue: ReturnType<typeof pluginSettings> | null = null;
	if (plugins.ok) {
		pluginsValue = pluginSettings(plugins.data);
	} else {
		errors.plugins = describeReadError(plugins.error);
	}
	let webhookValue: NeonAuthWebhookConfig | null = null;
	if (webhook.ok) {
		webhookValue = webhook.data;
	} else {
		errors.webhook = describeReadError(webhook.error);
	}

	return {
		project_id: projectId,
		branch_id: branchId,
		branch_name: branch.name,
		base_url: integration.base_url ?? null,
		jwks_url: integration.jwks_url,
		db_name: integration.db_name,
		integration: {
			auth_provider: integration.auth_provider,
			auth_provider_project_id: integration.auth_provider_project_id,
			branch_id: integration.branch_id,
			db_name: integration.db_name,
			created_at: integration.created_at,
			owned_by: integration.owned_by,
			jwks_url: integration.jwks_url,
			base_url: integration.base_url,
			...(integration.transfer_status !== undefined && {
				transfer_status: integration.transfer_status,
			}),
		},
		trusted_origins: domains.map((entry) => entry.domain),
		allow_localhost: localhost.allow_localhost,
		auth_methods: { email_password: emailPasswordSettings(emailPassword) },
		oauth_providers: oauthProviders.map(oauthProviderSettings),
		email_provider: emailProviderValue,
		plugins: pluginsValue,
		webhook: webhookValue,
		...(Object.keys(errors).length > 0 && { _errors: errors }),
	};
};

export const getAuthConfigTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "auth.getConfig",
			id: publishedId("auth.getConfig"),
			title: "Get Neon Auth configuration",
			description:
				'Read Neon Auth config for a branch: trusted origins, localhost access, email and password, OAuth providers, email provider, the organization, magic link, and phone number plugins, and the webhook. OAuth and SMTP secrets are redacted as "***redacted***". Omit branch_id to read the default branch. Requires Neon Auth on the branch (auth.create).',
			inputSchema: getAuthConfigInputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/projects/{project_id}/branches/{branch_id}/auth",
				stability: "stable",
				deprecated: false,
				tags: ["Auth"],
			},
		},
		readAuthConfig,
	);
