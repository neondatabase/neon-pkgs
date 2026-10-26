import type {
	NeonAuthCreateIntegrationResponse,
	NeonAuthIntegration,
} from "@neon/sdk";
import chalk from "chalk";
import type yargs from "yargs";
import { codeFromBody, isNeonApiError, retryOnLock } from "../api.js";
import { stripAnsi } from "../human_table.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import {
	NeonAuthEmailVerificationMethod,
	NeonAuthOauthProviderId,
	NeonAuthOauthProviderType,
	NeonAuthSupportedAuthProvider,
} from "../utils/api_enums.js";
import {
	branchIdFromProps,
	fillSingleProject,
	resolveBranchFromProps,
} from "../utils/enrichers.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

// Shared styled output helpers
// chalk 5 does not read NO_COLOR (https://no-color.org); writer.ts strips it the same way.
const writeStyled = (
	text: string,
	stream: NodeJS.WritableStream = process.stdout,
) => {
	stream.write(process.env.NO_COLOR ? stripAnsi(text) : text);
};

const printKvBlock = (
	title: string,
	entries: [string, string | undefined][],
) => {
	const labels = entries.map(([key]) => key.trimEnd());
	const width = Math.max(0, ...labels.map((label) => label.length));
	let text = `\n${chalk.green(title)}\n`;
	entries.forEach(([, value], i) => {
		text += `  ${chalk.green(labels[i].padEnd(width))}  ${value ?? ""}\n`;
	});
	writeStyled(`${text}\n`);
};

const printMessage = (message: string) => {
	writeStyled(`\n${chalk.green(message)}\n\n`);
};

const INTEGRATION_RESPONSE_FIELDS = [
	"auth_provider",
	"db_name",
	"base_url",
	"schema_name",
	"table_name",
	"jwks_url",
] as const;

const INTEGRATION_STATUS_FIELDS = [
	"auth_provider",
	"branch_id",
	"db_name",
	"base_url",
	"created_at",
	"jwks_url",
] as const;

const OAUTH_PROVIDER_FIELDS = ["id", "type", "client_id"] as const;

const ALLOW_LOCALHOST_FIELDS = ["allow_localhost"] as const;

const SUPPORTED_OAUTH_PROVIDERS = [
	NeonAuthOauthProviderId.Google,
	NeonAuthOauthProviderId.Github,
	NeonAuthOauthProviderId.Vercel,
] as const;

const DOMAIN_FIELDS = ["domain"] as const;

const EMAIL_PASSWORD_FIELDS = [
	"enabled",
	"email_verification_method",
	"require_email_verification",
	"auto_sign_in_after_verification",
	"send_verification_email_on_sign_up",
	"send_verification_email_on_sign_in",
	"disable_sign_up",
] as const;

const EMAIL_PROVIDER_FIELDS = [
	"type",
	"host",
	"port",
	"username",
	"sender_email",
	"sender_name",
] as const;

const ORGANIZATION_FIELDS = [
	"enabled",
	"organization_limit",
	"creator_role",
] as const;

const OAUTH_SERVER_FIELDS = [
	"enabled",
	"login_page",
	"consent_page",
	"mcp",
	"resources",
] as const;

const OAUTH_CLIENT_FIELDS = [
	"client_id",
	"name",
	"type",
	"redirect_uris",
	"resources",
	"skip_consent",
	"disabled",
	"created_at",
] as const;

const OAUTH_CLIENT_SECRET_FIELDS = ["client_id", "client_secret"] as const;

const WEBHOOK_FIELDS = [
	"enabled",
	"webhook_url",
	"enabled_events",
	"timeout_seconds",
] as const;

const TEST_EMAIL_FIELDS = ["success", "error_message"] as const;

export const command = "neon-auth";
export const describe = "Manage Neon Auth";
export const builder = (argv: yargs.Argv) => {
	return argv
		.usage("$0 neon-auth <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"enable",
			"Enable Neon Auth on a branch",
			(yargs) =>
				yargs.options({
					"database-name": {
						describe: "Database name to use for auth data",
						type: "string",
					},
				}),
			async (args) => {
				await enable(args as any);
			},
		)
		.command(
			"status",
			"Get Neon Auth status for a branch",
			(yargs) => yargs,
			async (args) => {
				await status(args as any);
			},
		)
		.command(
			"disable",
			"Disable Neon Auth on a branch",
			(yargs) =>
				yargs.options({
					"delete-data": {
						describe:
							"Permanently delete all Neon Auth data and schema from the database",
						type: "boolean",
						default: false,
					},
				}),
			async (args) => {
				await disable(args as any);
			},
		)
		.command(
			"oauth-provider",
			`Manage social login providers (${SUPPORTED_OAUTH_PROVIDERS.join(", ")})`,
			(yargs) => {
				return yargs
					.usage(
						"$0 neon-auth oauth-provider <sub-command> [options]",
					)
					.command(
						"list",
						"List OAuth providers",
						(yargs) => yargs,
						async (args) => {
							await oauthProviderList(args as any);
						},
					)
					.command(
						"add",
						"Add an OAuth provider",
						(yargs) =>
							yargs.options({
								"provider-id": {
									describe: `OAuth provider ID. Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(", ")}`,
									type: "string",
									choices: SUPPORTED_OAUTH_PROVIDERS,
									demandOption: true,
								},
								"oauth-client-id": {
									describe:
										"OAuth client ID from your provider app. Omit to use Neon's shared OAuth app.",
									type: "string",
								},
								"oauth-client-secret": {
									describe:
										"OAuth client secret from your provider app. Omit to use Neon's shared OAuth app.",
									type: "string",
								},
							}),
						async (args) => {
							await oauthProviderAdd(args as any);
						},
					)
					.command(
						"update",
						"Update an OAuth provider",
						(yargs) =>
							yargs.options({
								"provider-id": {
									describe: `OAuth provider ID. Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(", ")}`,
									type: "string",
									choices: SUPPORTED_OAUTH_PROVIDERS,
									demandOption: true,
								},
								"oauth-client-id": {
									describe:
										"OAuth client ID from your provider app. Omit to use Neon's shared OAuth app.",
									type: "string",
								},
								"oauth-client-secret": {
									describe:
										"OAuth client secret from your provider app. Omit to use Neon's shared OAuth app.",
									type: "string",
								},
							}),
						async (args) => {
							await oauthProviderUpdate(args as any);
						},
					)
					.command(
						"delete",
						"Delete an OAuth provider",
						(yargs) =>
							yargs.options({
								"provider-id": {
									describe: `OAuth provider ID. Supported values: ${SUPPORTED_OAUTH_PROVIDERS.join(", ")}`,
									type: "string",
									choices: SUPPORTED_OAUTH_PROVIDERS,
									demandOption: true,
								},
							}),
						async (args) => {
							await oauthProviderDelete(args as any);
						},
					);
			},
		)
		.command(
			"oauth-client",
			"Manage clients of this Neon Auth OAuth server (e.g. MCP clients); configure the server with `config oauth-server`",
			(yargs) => {
				return yargs
					.usage("$0 neon-auth oauth-client <sub-command> [options]")
					.command(
						"list",
						"List OAuth clients",
						(yargs) => yargs,
						async (args) => {
							await oauthClientList(args as any);
						},
					)
					.command(
						"create",
						"Create an OAuth client",
						(yargs) =>
							yargs
								.options({
									name: {
										describe: "Display name of the client",
										type: "string",
										demandOption: true,
									},
									type: {
										describe:
											"Client type. Confidential clients receive a secret that is shown only once",
										type: "string",
										choices: [
											"confidential",
											"public",
										] as const,
										demandOption: true,
									},
									"redirect-uris": {
										describe:
											"Redirect URIs the client may use (https, or http on loopback when localhost is allowed)",
										type: "string",
										array: true,
										demandOption: true,
									},
									resources: {
										describe:
											"Protected resource URLs to link the client to; each must be configured with `neon-auth config oauth-server resource add`",
										type: "string",
										array: true,
										demandOption: true,
									},
									"skip-consent": {
										describe:
											"Skip the consent prompt (first-party clients only)",
										type: "boolean",
									},
								})
								.example(
									"$0 neon-auth oauth-client create --name 'My app' --type confidential --redirect-uris https://app.example.com/callback --resources https://api.example.com",
									"Create a confidential client",
								),
						async (args) => {
							await oauthClientCreate(args as any);
						},
					)
					.command(
						"get <client-id>",
						"Get an OAuth client",
						(yargs) =>
							yargs
								.usage(
									"$0 neon-auth oauth-client get <client-id> [options]",
								)
								.positional("client-id", {
									describe: "OAuth client ID",
									type: "string",
									demandOption: true,
								}),
						async (args) => {
							await oauthClientGet(args as any);
						},
					)
					.command(
						"update <client-id>",
						"Update an OAuth client (the type cannot be changed)",
						(yargs) =>
							yargs
								.usage(
									"$0 neon-auth oauth-client update <client-id> [options]",
								)
								.positional("client-id", {
									describe: "OAuth client ID",
									type: "string",
									demandOption: true,
								})
								.options({
									name: {
										describe: "Display name of the client",
										type: "string",
									},
									"redirect-uris": {
										describe:
											"Redirect URIs the client may use; replaces the stored list",
										type: "string",
										array: true,
									},
									resources: {
										describe:
											"Protected resource URLs to link the client to; replaces the stored list (at least one)",
										type: "string",
										array: true,
									},
									"skip-consent": {
										describe:
											"Skip the consent prompt (first-party clients only). Use --no-skip-consent or --skip-consent false to turn off",
										type: "boolean",
									},
									disabled: {
										describe:
											"Disable the client. Use --no-disabled or --disabled false to re-enable",
										type: "boolean",
									},
								}),
						async (args) => {
							await oauthClientUpdate(args as any);
						},
					)
					.command(
						"delete <client-id>",
						"Delete an OAuth client",
						(yargs) =>
							yargs
								.usage(
									"$0 neon-auth oauth-client delete <client-id> [options]",
								)
								.positional("client-id", {
									describe: "OAuth client ID",
									type: "string",
									demandOption: true,
								}),
						async (args) => {
							await oauthClientDelete(args as any);
						},
					)
					.command(
						"rotate-secret <client-id>",
						"Rotate the secret of a confidential client; the old secret stops working immediately",
						(yargs) =>
							yargs
								.usage(
									"$0 neon-auth oauth-client rotate-secret <client-id> [options]",
								)
								.positional("client-id", {
									describe: "OAuth client ID",
									type: "string",
									demandOption: true,
								}),
						async (args) => {
							await oauthClientRotateSecret(args as any);
						},
					);
			},
		)
		.command("domain", "Manage redirect URI trusted domains", (yargs) => {
			return yargs
				.usage("$0 neon-auth domain <sub-command> [options]")
				.command(
					"list",
					"List trusted domains",
					(yargs) => yargs,
					async (args) => {
						await domainList(args as any);
					},
				)
				.command(
					"add <domain>",
					"Add a trusted domain",
					(yargs) =>
						yargs
							.usage("$0 neon-auth domain add <domain> [options]")
							.positional("domain", {
								describe: "Domain to add",
								type: "string",
								demandOption: true,
							}),
					async (args) => {
						await domainAdd(args as any);
					},
				)
				.command(
					"delete <domain>",
					"Delete a trusted domain",
					(yargs) =>
						yargs
							.usage(
								"$0 neon-auth domain delete <domain> [options]",
							)
							.positional("domain", {
								describe: "Domain to delete",
								type: "string",
								demandOption: true,
							}),
					async (args) => {
						await domainDelete(args as any);
					},
				)
				.command(
					"allow-localhost",
					"Manage localhost connection settings",
					(yargs) =>
						yargs
							.usage(
								"$0 neon-auth domain allow-localhost <sub-command> [options]",
							)
							.command(
								"get",
								"Get localhost connection setting",
								(yargs) => yargs,
								async (args) => {
									await allowLocalhostGet(args as any);
								},
							)
							.command(
								"enable",
								"Allow localhost connections",
								(yargs) => yargs,
								async (args) => {
									await allowLocalhostEnable(args as any);
								},
							)
							.command(
								"disable",
								"Restrict localhost connections",
								(yargs) => yargs,
								async (args) => {
									await allowLocalhostDisable(args as any);
								},
							),
				);
		})
		.command("config", "Manage Neon Auth configuration", (yargs) => {
			return yargs
				.usage("$0 neon-auth config <sub-command> [options]")
				.command(
					"email-password",
					"Manage email and password authentication settings",
					(yargs) => {
						return yargs
							.usage(
								"$0 neon-auth config email-password <sub-command> [options]",
							)
							.command(
								"get",
								"Get email and password config",
								(yargs) => yargs,
								async (args) => {
									await emailPasswordGet(args as any);
								},
							)
							.command(
								"update",
								"Update email and password config",
								(yargs) =>
									yargs.options({
										enabled: {
											describe:
												"Enable email and password authentication",
											type: "boolean",
										},
										"email-verification-method": {
											describe:
												"Email verification method",
											type: "string",
											choices: Object.values(
												NeonAuthEmailVerificationMethod,
											),
										},
										"require-email-verification": {
											describe:
												"Require email verification before users can sign in",
											type: "boolean",
										},
										"auto-sign-in-after-verification": {
											describe:
												"Auto sign in users after verifying their email",
											type: "boolean",
										},
										"send-verification-email-on-sign-up": {
											describe:
												"Send verification email on sign up",
											type: "boolean",
										},
										"send-verification-email-on-sign-in": {
											describe:
												"Send verification email on sign in",
											type: "boolean",
										},
										"disable-sign-up": {
											describe:
												"Disable new user sign ups",
											type: "boolean",
										},
									}),
								async (args) => {
									await emailPasswordUpdate(args as any);
								},
							);
					},
				)
				.command(
					"email-provider",
					"Manage email provider configuration",
					(yargs) => {
						return yargs
							.usage(
								"$0 neon-auth config email-provider <sub-command> [options]",
							)
							.command(
								"get",
								"Get email provider config",
								(yargs) => yargs,
								async (args) => {
									await emailProviderGet(args as any);
								},
							)
							.command(
								"update",
								"Update email provider config",
								(yargs) =>
									yargs.options({
										type: {
											describe: "Email provider type",
											type: "string",
											choices: [
												"standard",
												"shared",
											] as const,
											demandOption: true,
										},
										host: {
											describe:
												"SMTP host (required for standard)",
											type: "string",
										},
										port: {
											describe:
												"SMTP port (required for standard)",
											type: "number",
										},
										username: {
											describe:
												"SMTP username (required for standard)",
											type: "string",
										},
										password: {
											describe:
												"SMTP password (required for standard)",
											type: "string",
										},
										"sender-email": {
											describe: "Sender email address",
											type: "string",
										},
										"sender-name": {
											describe: "Sender display name",
											type: "string",
										},
									}),
								async (args) => {
									await emailProviderUpdate(args as any);
								},
							)
							.command(
								"test",
								"Send a test message through the saved custom SMTP provider",
								(yargs) =>
									yargs
										.options({
											"recipient-email": {
												describe:
													"Email address to deliver the test message to",
												type: "string",
												demandOption: true,
												coerce: single(
													"recipient-email",
													{ required: true },
												),
											},
										})
										.strict()
										.check(
											noPassthrough(
												"neon-auth config email-provider test",
											),
										)
										.epilogue(
											[
												"Save the provider first with",
												"`neon neon-auth config email-provider update --type standard`.",
												"A shared provider, a missing configuration, or a",
												"non-Better-Auth integration is rejected by the API.",
											].join("\n"),
										),
								async (args) => {
									await emailProviderTest(args as any);
								},
							);
					},
				)
				.command(
					"organization",
					"Manage organization plugin settings",
					(yargs) => {
						return yargs
							.usage(
								"$0 neon-auth config organization <sub-command> [options]",
							)
							.command(
								"get",
								"Get organization plugin config",
								(yargs) => yargs,
								async (args) => {
									await organizationGet(args as any);
								},
							)
							.command(
								"update",
								"Update organization plugin config",
								(yargs) =>
									yargs.options({
										enabled: {
											describe:
												"Enable the organization plugin",
											type: "boolean",
										},
										limit: {
											describe:
												"Maximum number of organizations a user can create",
											type: "number",
										},
										"creator-role": {
											describe:
												"Role assigned to organization creator",
											type: "string",
											choices: [
												"admin",
												"owner",
											] as const,
										},
									}),
								async (args) => {
									await organizationUpdate(args as any);
								},
							);
					},
				)
				.command(
					"oauth-server",
					"Manage the OAuth 2.1 authorization server (API plugin: oauth_provider)",
					(yargs) => {
						return yargs
							.usage(
								"$0 neon-auth config oauth-server <sub-command> [options]",
							)
							.command(
								"get",
								"Get OAuth server config",
								(yargs) => yargs,
								async (args) => {
									await oauthServerGet(args as any);
								},
							)
							.command(
								"update",
								"Update OAuth server config",
								(yargs) =>
									yargs
										.options({
											enabled: {
												describe:
													"Enable the OAuth server. Use --no-enabled or --enabled false to disable",
												type: "boolean",
											},
											"login-page": {
												describe:
													"URL of the page authorization requests redirect to for sign-in",
												type: "string",
											},
											"consent-page": {
												describe:
													"URL of the page authorization requests redirect to for consent",
												type: "string",
											},
											resources: {
												describe:
													"Protected resource URLs that clients can be linked to; replaces the stored list. Use `resource add|remove` for incremental changes",
												type: "string",
												array: true,
											},
											"mcp-resource": {
												describe:
													"MCP server URL that MCP clients are linked to. Defaults to the stored value when another --mcp-* flag is given. To remove the MCP configuration, use --no-mcp",
												type: "string",
											},
											mcp: {
												describe:
													"Remove the MCP configuration (only --no-mcp is accepted)",
												type: "boolean",
											},
											"mcp-client-id-metadata-documents":
												{
													describe:
														"Allow MCP clients to identify themselves with a Client ID Metadata Document (CIMD) URL. Use --no-mcp-client-id-metadata-documents to disallow",
													type: "boolean",
												},
											"mcp-dynamic-registration": {
												describe:
													"Allow MCP clients to register themselves via dynamic client registration (deprecated in favor of CIMD)",
												type: "boolean",
												hidden: true,
											},
										})
										.example(
											"$0 neon-auth config oauth-server update --enabled --mcp-resource https://example.com/mcp --mcp-client-id-metadata-documents",
											"Enable the OAuth server for an MCP server",
										),
								async (args) => {
									await oauthServerUpdate(args as any);
								},
							)
							.command(
								"resource",
								"Manage the protected resources of the OAuth server. Add and remove read the stored list and write back the full list, so concurrent changes by others can be overwritten",
								(yargs) =>
									yargs
										.usage(
											"$0 neon-auth config oauth-server resource <sub-command> [options]",
										)
										.command(
											"list",
											"List protected resources",
											(yargs) => yargs,
											async (args) => {
												await oauthResourceList(
													args as any,
												);
											},
										)
										.command(
											"add <url...>",
											"Add protected resources (reads the stored list and writes back the full list; concurrent changes by others can be overwritten)",
											(yargs) =>
												yargs.positional("url", {
													describe:
														"Protected resource URLs to add",
													type: "string",
													array: true,
													demandOption: true,
												}),
											async (args) => {
												await oauthResourceAdd(
													args as any,
												);
											},
										)
										.command(
											"remove <url...>",
											"Remove protected resources (reads the stored list and writes back the full list; concurrent changes by others can be overwritten)",
											(yargs) =>
												yargs.positional("url", {
													describe:
														"Protected resource URLs to remove",
													type: "string",
													array: true,
													demandOption: true,
												}),
											async (args) => {
												await oauthResourceRemove(
													args as any,
												);
											},
										),
							);
					},
				)
				.command("webhook", "Manage webhook configuration", (yargs) => {
					return yargs
						.usage(
							"$0 neon-auth config webhook <sub-command> [options]",
						)
						.command(
							"get",
							"Get webhook config",
							(yargs) => yargs,
							async (args) => {
								await webhookGet(args as any);
							},
						)
						.command(
							"update",
							"Update webhook config",
							(yargs) =>
								yargs.options({
									enabled: {
										describe: "Enable webhooks",
										type: "boolean",
										demandOption: true,
									},
									url: {
										describe: "Webhook endpoint URL",
										type: "string",
									},
									"enabled-events": {
										describe: "Events to enable",
										type: "string",
										choices: [
											"user.before_create",
											"user.created",
											"send.otp",
											"send.magic_link",
										] as const,
										array: true,
									},
									timeout: {
										describe:
											"Webhook timeout in seconds (1-10)",
										type: "number",
									},
								}),
							async (args) => {
								await webhookUpdate(args as any);
							},
						);
				});
		})
		.command("plugins", "View Neon Auth plugin configurations", (yargs) => {
			return yargs
				.usage("$0 neon-auth plugins <sub-command> [options]")
				.command(
					"list",
					"List all plugin configurations",
					(yargs) => yargs,
					async (args) => {
						await pluginsList(args as any);
					},
				)
				.command(
					"get <plugin-name>",
					"Get a specific plugin configuration",
					(yargs) =>
						yargs
							.usage(
								"$0 neon-auth plugins get <plugin-name> [options]",
							)
							.positional("plugin-name", {
								describe:
									"Plugin name (e.g. organization, email_provider, email_and_password, oauth_providers, oauth_provider, allow_localhost)",
								type: "string",
								demandOption: true,
							}),
					async (args) => {
						await pluginsGet(args as any);
					},
				);
		})
		.command("user", "Manage Neon Auth users", (yargs) => {
			return yargs
				.usage("$0 neon-auth user <sub-command> [options]")
				.command(
					"create",
					"Create an auth user",
					(yargs) =>
						yargs.options({
							email: {
								describe: "User email address",
								type: "string",
								demandOption: true,
							},
							name: {
								describe:
									"User display name (defaults to email if not provided)",
								type: "string",
							},
						}),
					async (args) => {
						await userCreate(args as any);
					},
				)
				.command(
					"delete <user-id>",
					"Delete an auth user",
					(yargs) =>
						yargs
							.usage(
								"$0 neon-auth user delete <user-id> [options]",
							)
							.positional("user-id", {
								describe: "ID of the user to delete",
								type: "string",
								demandOption: true,
							}),
					async (args) => {
						await userDelete(args as any);
					},
				)
				.command(
					"set-role <user-id>",
					"Set roles for an auth user",
					(yargs) =>
						yargs
							.usage(
								"$0 neon-auth user set-role <user-id> [options]",
							)
							.positional("user-id", {
								describe: "ID of the user to update",
								type: "string",
								demandOption: true,
							})
							.options({
								roles: {
									describe: "Roles to assign",
									type: "string",
									array: true,
									demandOption: true,
								},
							}),
					async (args) => {
						await userSetRole(args as any);
					},
				);
		});
};

export const handler = (args: yargs.Argv) => {
	return args;
};

// --- Implementation functions ---

type AuthBranchProps = BranchScopeProps & { branchId?: string };

const resolveBranch = async (props: AuthBranchProps) => {
	return props.branchId ?? (await branchIdFromProps(props));
};

/** The branch name is only known when it was resolved from a listing, not from an id. */
const resolveBranchWithName = async (
	props: AuthBranchProps,
): Promise<{ branchId: string; branchName?: string }> => {
	if (props.branchId) {
		return { branchId: props.branchId };
	}
	const { branchId, branch } = await resolveBranchFromProps(props);
	return { branchId, branchName: branch?.name };
};

const enable = async (props: AuthBranchProps & { databaseName?: string }) => {
	const branchId = await resolveBranch(props);
	let data: NeonAuthCreateIntegrationResponse | NeonAuthIntegration;
	let alreadyEnabled = false;
	try {
		({ data } = await retryOnLock(() =>
			props.apiClient.createNeonAuth(props.projectId, branchId, {
				auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
				database_name: props.databaseName,
			}),
		));
	} catch (err) {
		if (!(isNeonApiError(err) && err.status === 409)) throw err;
		try {
			({ data } = await props.apiClient.getNeonAuth(
				props.projectId,
				branchId,
			));
		} catch (readErr) {
			// No integration to show, so the 409 was not "already enabled"; report the API's
			// reason (for example an existing `neon_auth` schema) instead.
			if (isNeonApiError(readErr) && readErr.status === 404) throw err;
			throw readErr;
		}
		alreadyEnabled = true;
	}
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, { fields: INTEGRATION_RESPONSE_FIELDS });
		return;
	}

	// Access type-specific fields loosely — CREATE response has schema/table,
	// GET response (already-enabled path) has db_name instead.
	const d = data as unknown as Record<string, string | undefined>;
	printKvBlock(
		alreadyEnabled ? "Neon Auth is already enabled" : "Neon Auth enabled",
		[
			["Auth Provider:", data.auth_provider],
			...(d.db_name
				? [["Database:", d.db_name] as [string, string]]
				: []),
			["Base URL:", data.base_url],
			...(d.schema_name
				? [["Schema Name:", d.schema_name] as [string, string]]
				: []),
			...(d.table_name
				? [["Table Name:", d.table_name] as [string, string]]
				: []),
			["JWKS URL:", data.jwks_url],
		],
	);
	if (data.base_url) {
		writeStyled(
			`  ${chalk.green("Set this environment variable in your application:")}\n`,
		);
		writeStyled(`  NEON_AUTH_BASE_URL=${data.base_url}\n\n`);
	}
};

const status = async (props: AuthBranchProps) => {
	const { branchId, branchName } = await resolveBranchWithName(props);
	let data: NeonAuthIntegration;
	try {
		({ data } = await props.apiClient.getNeonAuth(
			props.projectId,
			branchId,
		));
	} catch (err) {
		if (isNeonApiError(err) && err.status === 404) {
			printMessage("Neon Auth is not configured for this branch");
			return;
		}
		throw err;
	}

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: INTEGRATION_STATUS_FIELDS });
		return;
	}

	printKvBlock("Neon Auth status", [
		["Auth Provider:", data.auth_provider],
		[
			"Branch:",
			branchName ? `${branchName} (${data.branch_id})` : data.branch_id,
		],
		["Database:", data.db_name],
		["Base URL:", data.base_url],
		["Created At:", data.created_at],
		["JWKS URL:", data.jwks_url],
	]);
};

const disable = async (props: AuthBranchProps & { deleteData: boolean }) => {
	const branchId = await resolveBranch(props);
	await retryOnLock(() =>
		props.apiClient.disableNeonAuth(props.projectId, branchId, {
			delete_data: props.deleteData,
		}),
	);
	printMessage("Neon Auth has been disabled");
};

// --- OAuth provider ---

const SHARED_PROVIDER_DISCLAIMER =
	"Shared keys are created by the Neon team for development only " +
	"and should not be used for production apps. It helps you get started, " +
	"but will show Neon branding (logo and name) on the OAuth consent screen.";

const oauthProviderList = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.listBranchNeonAuthOauthProviders(
		props.projectId,
		branchId,
	);
	if (data.providers.length === 0 && props.output === "table") {
		printMessage("No OAuth providers are configured for this branch.");
		return;
	}
	writer(props).end(data.providers, { fields: OAUTH_PROVIDER_FIELDS });
	const hasShared = data.providers.some(
		(p) => p.type === NeonAuthOauthProviderType.Shared,
	);
	if (hasShared && props.output === "table") {
		writeStyled(
			`\n${chalk.yellow("Caution:")} ${SHARED_PROVIDER_DISCLAIMER}\n\n`,
		);
	}
};

const oauthProviderAdd = async (
	props: AuthBranchProps & {
		providerId: string;
		oauthClientId?: string;
		oauthClientSecret?: string;
	},
) => {
	const branchId = await resolveBranch(props);
	const baseUrlRequest = callbackBaseUrl(props, branchId, props.providerId);
	let data: Awaited<
		ReturnType<typeof props.apiClient.addBranchNeonAuthOauthProvider>
	>["data"];
	try {
		({ data } = await props.apiClient.addBranchNeonAuthOauthProvider(
			props.projectId,
			branchId,
			{
				id: props.providerId as NeonAuthOauthProviderId,
				client_id: props.oauthClientId,
				client_secret: props.oauthClientSecret,
			},
		));
	} catch (err) {
		if (
			isNeonApiError(err) &&
			codeFromBody(err.data) === "INVALID_SHARED_OAUTH_PROVIDER"
		) {
			throw new Error(
				`The "${props.providerId}" provider requires your own OAuth app credentials.\n` +
					`Re-run with --oauth-client-id and --oauth-client-secret to provide them.\n` +
					`Create an OAuth app at your provider and use those credentials.`,
			);
		}
		throw err;
	}
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: OAUTH_PROVIDER_FIELDS });
	} else {
		printKvBlock("OAuth provider added", [
			["ID:", data.id],
			["Type:", data.type],
			...(data.client_id
				? [["Client ID:", data.client_id] as [string, string]]
				: []),
		]);
	}
	printCallbackInstructions(props.providerId, await baseUrlRequest);
};

const oauthProviderUpdate = async (
	props: AuthBranchProps & {
		providerId: string;
		oauthClientId?: string;
		oauthClientSecret?: string;
	},
) => {
	const branchId = await resolveBranch(props);
	const baseUrlRequest = callbackBaseUrl(props, branchId, props.providerId);
	let data: Awaited<
		ReturnType<typeof props.apiClient.updateBranchNeonAuthOauthProvider>
	>["data"];
	try {
		({ data } = await props.apiClient.updateBranchNeonAuthOauthProvider(
			props.projectId,
			branchId,
			props.providerId as NeonAuthOauthProviderId,
			{
				client_id: props.oauthClientId,
				client_secret: props.oauthClientSecret,
			},
		));
	} catch (err) {
		if (
			isNeonApiError(err) &&
			codeFromBody(err.data) === "INVALID_SHARED_OAUTH_PROVIDER"
		) {
			throw new Error(
				`The "${props.providerId}" provider requires your own OAuth app credentials.\n` +
					`Re-run with --oauth-client-id and --oauth-client-secret to provide them.\n` +
					`Create an OAuth app at your provider and use those credentials.`,
			);
		}
		throw err;
	}
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: OAUTH_PROVIDER_FIELDS });
	} else {
		printKvBlock("OAuth provider updated", [
			["ID:", data.id],
			["Type:", data.type],
			...(data.client_id
				? [["Client ID:", data.client_id] as [string, string]]
				: []),
		]);
	}
	printCallbackInstructions(props.providerId, await baseUrlRequest);
};

const CALLBACK_INSTRUCTIONS: Record<
	string,
	{ lead: string; urlLabel: string }
> = {
	github: {
		lead: "Create an OAuth app in the GitHub Developer Portal and add the following authorization callback URL:",
		urlLabel: "callback/github",
	},
	vercel: {
		lead: "Create a Vercel App in your Vercel Dashboard and add the following authorization callback URL:",
		urlLabel: "callback/vercel",
	},
	google: {
		lead: "Get Google credentials by creating an OAuth client in Google Cloud Console > Credentials, and add the following authorized redirect URL:",
		urlLabel: "callback/google",
	},
};

/**
 * Starts the base-URL read for the callback instructions, or resolves to undefined when none
 * apply. It runs alongside the provider write (adding a provider does not change the base URL)
 * and never rejects: a failed read prints no instructions, as before.
 */
const callbackBaseUrl = (
	props: AuthBranchProps,
	branchId: string,
	providerId: string,
): Promise<string | undefined> => {
	if (!CALLBACK_INSTRUCTIONS[providerId]) return Promise.resolve(undefined);
	if (props.output === "json" || props.output === "yaml") {
		return Promise.resolve(undefined);
	}
	return props.apiClient.getNeonAuth(props.projectId, branchId).then(
		({ data }) => data.base_url,
		() => undefined,
	);
};

const printCallbackInstructions = (
	providerId: string,
	baseUrl: string | undefined,
) => {
	const instructions = CALLBACK_INSTRUCTIONS[providerId];
	if (!instructions || !baseUrl) return;
	const callbackUrl = `${baseUrl.replace(/\/$/, "")}/${instructions.urlLabel}`;
	printKvBlock(instructions.lead, [["URL:", callbackUrl]]);
};

const oauthProviderDelete = async (
	props: AuthBranchProps & { providerId: string },
) => {
	const branchId = await resolveBranch(props);
	await props.apiClient.deleteBranchNeonAuthOauthProvider(
		props.projectId,
		branchId,
		props.providerId as NeonAuthOauthProviderId,
	);
	printMessage(`OAuth provider "${props.providerId}" deleted`);
};

// --- Domains ---

const domainList = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.listBranchNeonAuthTrustedDomains(
		props.projectId,
		branchId,
	);
	if (data.domains.length === 0 && props.output === "table") {
		printMessage("No trusted domains are configured for this branch.");
		return;
	}
	writer(props).end(data.domains, { fields: DOMAIN_FIELDS });
};

const validateDomainUri = (domain: string) => {
	let url: URL;
	try {
		url = new URL(domain);
	} catch {
		throw new Error(
			`Invalid domain URI "${domain}". Must be a full URI including scheme, e.g. https://${domain}`,
		);
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error(
			`Invalid domain URI "${domain}". Must use http or https scheme, e.g. https://${url.host}`,
		);
	}
};

const domainAdd = async (props: AuthBranchProps & { domain: string }) => {
	validateDomainUri(props.domain);
	const branchId = await resolveBranch(props);
	await props.apiClient.addBranchNeonAuthTrustedDomain(
		props.projectId,
		branchId,
		{
			domain: props.domain,
			auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
		},
	);
	printMessage(`Domain "${props.domain}" added`);
};

const domainDelete = async (props: AuthBranchProps & { domain: string }) => {
	validateDomainUri(props.domain);
	const branchId = await resolveBranch(props);
	const { data: existing } =
		await props.apiClient.listBranchNeonAuthTrustedDomains(
			props.projectId,
			branchId,
		);
	if (!existing.domains.some((d) => d.domain === props.domain)) {
		throw new Error(
			`Domain "${props.domain}" is not in the trusted domains list.`,
		);
	}
	await props.apiClient.deleteBranchNeonAuthTrustedDomain(
		props.projectId,
		branchId,
		{
			auth_provider: NeonAuthSupportedAuthProvider.BetterAuth,
			domains: [{ domain: props.domain }],
		},
	);
	printMessage(`Domain "${props.domain}" deleted`);
};

// --- Allow localhost ---

const allowLocalhostGet = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthAllowLocalhost(
		props.projectId,
		branchId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: ALLOW_LOCALHOST_FIELDS });
		return;
	}
	printKvBlock("Localhost connection settings", [
		["Allow localhost:", String(data.allow_localhost)],
	]);
};

const allowLocalhostEnable = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	await props.apiClient.updateNeonAuthAllowLocalhost(
		props.projectId,
		branchId,
		{
			allow_localhost: true,
		},
	);
	printMessage("Localhost connections allowed");
};

const allowLocalhostDisable = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	await props.apiClient.updateNeonAuthAllowLocalhost(
		props.projectId,
		branchId,
		{
			allow_localhost: false,
		},
	);
	printMessage("Localhost connections restricted");
};

// --- Email and password ---

const printEmailPasswordEntries = (data: {
	enabled: boolean;
	email_verification_method: string;
	require_email_verification: boolean;
	auto_sign_in_after_verification: boolean;
	send_verification_email_on_sign_up: boolean;
	send_verification_email_on_sign_in: boolean;
	disable_sign_up: boolean;
}): [string, string][] => [
	["Enabled:", String(data.enabled)],
	["Verification Method:", data.email_verification_method],
	["Require Verification:", String(data.require_email_verification)],
	[
		"Auto Sign In After Verify:  ",
		String(data.auto_sign_in_after_verification),
	],
	[
		"Send Email On Sign Up:      ",
		String(data.send_verification_email_on_sign_up),
	],
	[
		"Send Email On Sign In:      ",
		String(data.send_verification_email_on_sign_in),
	],
	["Disable Sign Up:", String(data.disable_sign_up)],
];

const emailPasswordGet = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthEmailAndPasswordConfig(
		props.projectId,
		branchId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: EMAIL_PASSWORD_FIELDS });
		return;
	}
	printKvBlock(
		"Email & password auth configuration",
		printEmailPasswordEntries(data),
	);
};

const emailPasswordUpdate = async (
	props: AuthBranchProps & {
		enabled?: boolean;
		emailVerificationMethod?: string;
		requireEmailVerification?: boolean;
		autoSignInAfterVerification?: boolean;
		sendVerificationEmailOnSignUp?: boolean;
		sendVerificationEmailOnSignIn?: boolean;
		disableSignUp?: boolean;
	},
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.updateNeonAuthEmailAndPasswordConfig(
		props.projectId,
		branchId,
		{
			enabled: props.enabled,
			email_verification_method:
				props.emailVerificationMethod as NeonAuthEmailVerificationMethod,
			require_email_verification: props.requireEmailVerification,
			auto_sign_in_after_verification: props.autoSignInAfterVerification,
			send_verification_email_on_sign_up:
				props.sendVerificationEmailOnSignUp,
			send_verification_email_on_sign_in:
				props.sendVerificationEmailOnSignIn,
			disable_sign_up: props.disableSignUp,
		},
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: EMAIL_PASSWORD_FIELDS });
		return;
	}
	printKvBlock(
		"Email & password auth configuration updated",
		printEmailPasswordEntries(data),
	);
};

// --- Email provider ---

const printEmailProviderEntries = (data: {
	type: string;
	host?: string;
	port?: number;
	username?: string;
	sender_email?: string;
	sender_name?: string;
}): [string, string | undefined][] => [
	["Type:", data.type],
	...(data.type === "standard"
		? ([
				["Host:", data.host],
				[
					"Port:          ",
					data.port != null ? String(data.port) : undefined,
				],
				["Username:", data.username],
			] as [string, string | undefined][])
		: []),
	["Sender Email:", data.sender_email],
	["Sender Name:", data.sender_name],
];

const emailProviderGet = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthEmailProvider(
		props.projectId,
		branchId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, {
			fields: EMAIL_PROVIDER_FIELDS as any,
		});
		return;
	}
	printKvBlock(
		"Email provider configuration",
		printEmailProviderEntries(data as any),
	);
};

const emailProviderUpdate = async (
	props: AuthBranchProps & {
		type: string;
		host?: string;
		port?: number;
		username?: string;
		password?: string;
		senderEmail?: string;
		senderName?: string;
	},
) => {
	if (
		props.type === "standard" &&
		(!props.host || !props.port || !props.username || !props.password)
	) {
		throw new Error(
			"--host, --port, --username, and --password are required for standard email provider",
		);
	}
	const warnSharedSender =
		props.type === "shared" && (props.senderEmail || props.senderName);
	const branchId = await resolveBranch(props);
	let config: any;
	if (props.type === "standard") {
		config = {
			type: "standard",
			host: props.host,
			port: props.port,
			username: props.username,
			password: props.password,
			sender_email: props.senderEmail,
			sender_name: props.senderName,
		};
	} else {
		config = {
			type: "shared",
		};
	}
	const { data } = await props.apiClient.updateNeonAuthEmailProvider(
		props.projectId,
		branchId,
		config,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, {
			fields: EMAIL_PROVIDER_FIELDS as any,
		});
	} else {
		printKvBlock(
			"Email provider configuration updated",
			printEmailProviderEntries(data as any),
		);
	}
	if (warnSharedSender) {
		writeStyled(
			`${chalk.yellow("Warning:")} --sender-email and --sender-name are ignored for the shared email provider. ` +
				`These values only take effect with --type standard.\n\n`,
			process.stderr,
		);
	}
};

const emailProviderTest = async (
	props: AuthBranchProps & {
		recipientEmail: string;
	},
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.sendNeonAuthEmailProviderTest(
		props.projectId,
		branchId,
		{ recipient_email: props.recipientEmail },
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: TEST_EMAIL_FIELDS });
		if (!data.success) {
			throw new Error(
				emailProviderTestFailureMessage(
					props.recipientEmail,
					data.error_message,
				),
			);
		}
		return;
	}
	if (data.success) {
		printMessage(
			`Test email dispatched to ${props.recipientEmail} using the custom SMTP provider saved on this branch.`,
		);
		return;
	}
	throw new Error(
		emailProviderTestFailureMessage(
			props.recipientEmail,
			data.error_message,
		),
	);
};

const emailProviderTestFailureMessage = (
	recipientEmail: string,
	errorMessage: string | undefined,
) => {
	const header = `Test email could NOT be sent to ${recipientEmail} using the custom SMTP provider saved on this branch.`;
	return errorMessage ? `${header}\nUpstream error: ${errorMessage}` : header;
};

// --- Organization plugin ---

const printOrganizationEntries = (data: {
	enabled: boolean;
	organization_limit: number;
	creator_role: string;
}): [string, string][] => [
	["Enabled:", String(data.enabled)],
	["Org Limit:", String(data.organization_limit)],
	["Creator Role:", data.creator_role],
];

const organizationGet = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthPluginConfigs(
		props.projectId,
		branchId,
	);
	const org = data.organization;
	if (!org) {
		if (props.output === "json" || props.output === "yaml") {
			writer(props).end({} as any, {
				fields: ORGANIZATION_FIELDS as any,
			});
			return;
		}
		printMessage("No organization plugin config found.");
		return;
	}
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(org as any, { fields: ORGANIZATION_FIELDS as any });
		return;
	}
	printKvBlock("Organization configuration", printOrganizationEntries(org));
};

const organizationUpdate = async (
	props: AuthBranchProps & {
		enabled?: boolean;
		limit?: number;
		creatorRole?: string;
	},
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.updateNeonAuthOrganizationPlugin(
		props.projectId,
		branchId,
		{
			enabled: props.enabled,
			organization_limit: props.limit,
			creator_role: props.creatorRole as "admin" | "owner",
		},
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, { fields: ORGANIZATION_FIELDS as any });
		return;
	}
	printKvBlock(
		"Organization configuration updated",
		printOrganizationEntries(data),
	);
};

// --- OAuth server (API plugin: oauth_provider) ---

type OAuthServerConfig = {
	enabled: boolean;
	login_page?: string;
	consent_page?: string;
	mcp?: {
		resource?: string;
		dynamic_registration?: boolean;
		client_id_metadata_documents?: boolean;
	};
	resources?: { identifier: string }[];
};

const optionalBool = (v: boolean | undefined) =>
	v === undefined ? undefined : String(v);

const printOAuthServerEntries = (
	data: OAuthServerConfig,
): [string, string | undefined][] => [
	["Enabled:", String(data.enabled)],
	["Login Page:", data.login_page],
	["Consent Page:", data.consent_page],
	["MCP Resource:", data.mcp?.resource],
	["MCP CIMD:", optionalBool(data.mcp?.client_id_metadata_documents)],
	["MCP Dynamic Reg:", optionalBool(data.mcp?.dynamic_registration)],
	["Resources:", (data.resources ?? []).map((r) => r.identifier).join(", ")],
];

/** The API rejects an empty PATCH, so fail before any request with the flags that would do something. */
const requireUpdateFields = (provided: unknown[], flags: string[]) => {
	if (provided.every((value) => value === undefined)) {
		throw new Error(
			`Nothing to update. Pass at least one of ${flags.join(", ")}.`,
		);
	}
};

const oauthServerGet = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthOAuthProviderPlugin(
		props.projectId,
		branchId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, { fields: OAUTH_SERVER_FIELDS as any });
		return;
	}
	printKvBlock("OAuth server configuration", printOAuthServerEntries(data));
};

type OAuthServerUpdateProps = AuthBranchProps & {
	enabled?: boolean;
	loginPage?: string;
	consentPage?: string;
	resources?: string[];
	mcp?: boolean;
	mcpResource?: string;
	mcpDynamicRegistration?: boolean;
	mcpClientIdMetadataDocuments?: boolean;
};

/**
 * The API requires `mcp.resource` whenever `mcp` is sent and keeps stored booleans that are
 * omitted, so only the resource is filled in from the stored config.
 */
const resolveMcpUpdate = async (
	props: OAuthServerUpdateProps,
	getStoredMcp: () => Promise<OAuthServerConfig["mcp"]>,
) => {
	const {
		mcpResource,
		mcpDynamicRegistration: dynamicRegistration,
		mcpClientIdMetadataDocuments: clientIdMetadataDocuments,
	} = props;
	if (
		mcpResource === undefined &&
		dynamicRegistration === undefined &&
		clientIdMetadataDocuments === undefined
	) {
		return undefined;
	}
	const resource = mcpResource ?? (await getStoredMcp())?.resource;
	if (!resource) {
		throw new Error(
			"No MCP resource is configured yet. Pass --mcp-resource <url> together with the other --mcp-* flags.",
		);
	}
	return {
		resource,
		dynamic_registration: dynamicRegistration,
		client_id_metadata_documents: clientIdMetadataDocuments,
	};
};

/**
 * Order-preserving dedupe after trimming: padded input would otherwise miss stored values
 * and reach the API as a distinct string, and repeats would be sent as duplicates.
 */
const unique = (values: string[]) => [
	...new Set(values.map((value) => value.trim())),
];

/** yargs negation turns `--no-<flag>` on an array option into `[false]`, which bypasses empty-array checks. */
const isNegatedList = (values: unknown) =>
	values === false || (Array.isArray(values) && values.includes(false));

const hasBlank = (values?: string[]) =>
	values?.some((value) => value.trim() === "") ?? false;

/** Fails before any request when a list flag was passed with no values or a blank one. */
const requireNonEmptyLists = (lists: [flag: string, values?: string[]][]) => {
	for (const [flag, values] of lists) {
		if (isNegatedList(values)) {
			throw new Error(
				`--no-${flag.slice(2)} is not supported. ${flag} must list at least one value.`,
			);
		}
		if (values?.length === 0) {
			throw new Error(`${flag} must list at least one value.`);
		}
		if (hasBlank(values)) {
			throw new Error(`${flag} must not contain empty values.`);
		}
	}
};

/**
 * yargs negation turns `--no-<flag>` on a string option into `false`, and `--flag ""` yields an
 * empty string; both would otherwise crash on `.trim()` or be sent to the API.
 */
const requireNonBlankString = (flag: string, value: unknown, hint: string) => {
	if (value === false) {
		throw new Error(`--no-${flag.slice(2)} is not supported. ${hint}`);
	}
	if (typeof value === "string" && value.trim() === "") {
		throw new Error(`${flag} must not be empty.`);
	}
};

const requireNonBlankUrls = (urls: string[]) => {
	if (hasBlank(urls)) {
		throw new Error("URLs must not be empty.");
	}
};

/** The MCP resource is linked to MCP clients on its own, so it cannot also be a protected resource. */
const rejectMcpResourceCollision = (
	urls: string[],
	mcpResource: string | undefined,
) => {
	if (mcpResource && urls.includes(mcpResource)) {
		throw new Error(
			`${mcpResource} is the MCP resource and cannot also be a protected resource.`,
		);
	}
};

/** Checked before any request so a malformed invocation never reaches the API. */
const validateOAuthServerUpdate = (props: OAuthServerUpdateProps) => {
	requireNonBlankString(
		"--login-page",
		props.loginPage,
		"Pass --login-page <url>.",
	);
	requireNonBlankString(
		"--consent-page",
		props.consentPage,
		"Pass --consent-page <url>.",
	);
	if (props.mcp === true) {
		throw new Error(
			"--mcp cannot be enabled. Configure MCP with --mcp-resource <url>, or remove it with --no-mcp.",
		);
	}
	if (
		props.mcp === false &&
		(props.mcpResource !== undefined ||
			props.mcpClientIdMetadataDocuments !== undefined ||
			props.mcpDynamicRegistration !== undefined)
	) {
		throw new Error(
			"--no-mcp cannot be combined with --mcp-resource, --mcp-client-id-metadata-documents or --mcp-dynamic-registration.",
		);
	}
	if ((props.mcpResource as unknown) === false) {
		throw new Error(
			"--no-mcp-resource is not supported. To remove the MCP configuration, use --no-mcp.",
		);
	}
	if (props.mcpResource?.trim() === "") {
		throw new Error(
			"--mcp-resource must not be empty. To remove the MCP configuration, use --no-mcp.",
		);
	}
	if (isNegatedList(props.resources)) {
		throw new Error(
			"--no-resources is not supported. To remove resources, use `neon-auth config oauth-server resource remove <url...>`.",
		);
	}
	if (props.resources?.length === 0) {
		throw new Error(
			"--resources must list at least one URL. To remove resources, use `neon-auth config oauth-server resource remove <url...>`.",
		);
	}
	if (hasBlank(props.resources)) {
		throw new Error("--resources must not contain empty values.");
	}
};

const oauthServerUpdate = async (props: OAuthServerUpdateProps) => {
	requireUpdateFields(
		[
			props.enabled,
			props.loginPage,
			props.consentPage,
			props.resources,
			props.mcp,
			props.mcpResource,
			props.mcpClientIdMetadataDocuments,
			props.mcpDynamicRegistration,
		],
		[
			"--enabled",
			"--login-page",
			"--consent-page",
			"--resources",
			"--no-mcp",
			"--mcp-resource",
			"--mcp-client-id-metadata-documents",
		],
	);
	validateOAuthServerUpdate(props);
	const loginPage = props.loginPage?.trim();
	const consentPage = props.consentPage?.trim();
	const mcpResource = props.mcpResource?.trim();
	const branchId = await resolveBranch(props);
	let storedMcp: Promise<OAuthServerConfig["mcp"]> | undefined;
	const getStoredMcp = () =>
		(storedMcp ??= props.apiClient
			.getNeonAuthOAuthProviderPlugin(props.projectId, branchId)
			.then(({ data }) => data.mcp));
	// The API clears the MCP configuration when `resource` is the empty string.
	const mcp =
		props.mcp === false
			? { resource: "" }
			: await resolveMcpUpdate({ ...props, mcpResource }, getStoredMcp);
	const resources = props.resources && unique(props.resources);
	if (resources && props.mcp !== false) {
		rejectMcpResourceCollision(
			resources,
			mcp?.resource ?? (await getStoredMcp())?.resource,
		);
	}
	if (props.mcpDynamicRegistration !== undefined) {
		log.warning(
			"--mcp-dynamic-registration is deprecated. Use --mcp-client-id-metadata-documents instead.",
		);
	}
	const { data } = await props.apiClient.updateNeonAuthOAuthProviderPlugin(
		props.projectId,
		branchId,
		{
			enabled: props.enabled,
			login_page: loginPage,
			consent_page: consentPage,
			mcp,
			resources: resources?.map((identifier) => ({ identifier })),
		},
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, { fields: OAUTH_SERVER_FIELDS as any });
		return;
	}
	printKvBlock(
		"OAuth server configuration updated",
		printOAuthServerEntries(data),
	);
};

// --- OAuth server resources ---

const getStoredOAuthServer = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthOAuthProviderPlugin(
		props.projectId,
		branchId,
	);
	return {
		branchId,
		mcpResource: data.mcp?.resource,
		stored: (data.resources ?? []).map((r) => r.identifier),
	};
};

const reportOAuthResources = (
	props: AuthBranchProps,
	resources: { identifier: string }[],
) => {
	if (resources.length === 0 && props.output === "table") {
		printMessage("No protected resources are configured");
		return;
	}
	writer(props).end(resources, { fields: ["identifier"] });
};

/** The API replaces the whole list, so every change is a full-list PATCH. */
const replaceOAuthResources = async (
	props: AuthBranchProps,
	branchId: string,
	identifiers: string[],
) => {
	const { data } = await props.apiClient.updateNeonAuthOAuthProviderPlugin(
		props.projectId,
		branchId,
		{ resources: identifiers.map((identifier) => ({ identifier })) },
	);
	reportOAuthResources(props, data.resources ?? []);
};

const oauthResourceList = async (props: AuthBranchProps) => {
	const { stored } = await getStoredOAuthServer(props);
	reportOAuthResources(
		props,
		stored.map((identifier) => ({ identifier })),
	);
};

const oauthResourceAdd = async (props: AuthBranchProps & { url: string[] }) => {
	requireNonBlankUrls(props.url);
	const urls = unique(props.url);
	const { branchId, mcpResource, stored } = await getStoredOAuthServer(props);
	rejectMcpResourceCollision(urls, mcpResource);
	const existing = urls.filter((url) => stored.includes(url));
	if (existing.length > 0) {
		log.warning(`Already configured, skipped: ${existing.join(", ")}`);
	}
	const added = urls.filter((url) => !stored.includes(url));
	if (added.length === 0) {
		reportOAuthResources(
			props,
			stored.map((identifier) => ({ identifier })),
		);
		return;
	}
	await replaceOAuthResources(props, branchId, [...stored, ...added]);
};

const oauthResourceRemove = async (
	props: AuthBranchProps & { url: string[] },
) => {
	requireNonBlankUrls(props.url);
	const requested = unique(props.url);
	const { branchId, stored } = await getStoredOAuthServer(props);
	const unknown = requested.filter((url) => !stored.includes(url));
	if (unknown.length > 0) {
		log.warning(`Not configured, skipped: ${unknown.join(", ")}`);
	}
	const urls = requested.filter((url) => stored.includes(url));
	if (urls.length === 0) {
		reportOAuthResources(
			props,
			stored.map((identifier) => ({ identifier })),
		);
		return;
	}
	await replaceOAuthResources(
		props,
		branchId,
		stored.filter((url) => !urls.includes(url)),
	);
	// Clients keep the removed resource in their own list, so their token
	// requests for it may start failing. The lookup only feeds this warning, so
	// a failure must not undo the report of a removal that already succeeded.
	let linked: OAuthClient[];
	try {
		const { data } = await props.apiClient.listNeonAuthOAuthClients(
			props.projectId,
			branchId,
		);
		linked = data.clients.filter((client) =>
			client.resources.some((resource) => urls.includes(resource)),
		);
	} catch (err) {
		log.debug(
			"Could not look up clients linked to the removed resource: %s",
			err,
		);
		log.warning(
			"Removed, but could not check for clients still linked to it.",
		);
		return;
	}
	if (linked.length > 0) {
		log.warning(
			`Clients still linked to a removed resource: ${linked
				.map((client) => `"${client.name}" (${client.client_id})`)
				.join(
					", ",
				)}. Their token requests for that resource may fail until it is added again.`,
		);
	}
};

// --- OAuth clients ---

type OAuthClient = {
	client_id: string;
	name: string;
	type: string;
	redirect_uris: string[];
	resources: string[];
	skip_consent: boolean;
	disabled: boolean;
	created_at?: string;
};

const printOAuthClientEntries = (
	data: OAuthClient,
): [string, string | undefined][] => [
	["Client ID:", data.client_id],
	["Name:", data.name],
	["Type:", data.type],
	["Redirect URIs:", data.redirect_uris.join(", ")],
	["Resources:", data.resources.join(", ")],
	["Skip Consent:", String(data.skip_consent)],
	["Disabled:", String(data.disabled)],
	["Created At:", data.created_at],
];

const oauthClientList = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.listNeonAuthOAuthClients(
		props.projectId,
		branchId,
	);
	if (data.clients.length === 0 && props.output === "table") {
		printMessage("No OAuth clients are configured for this branch.");
		return;
	}
	writer(props).end(data.clients, { fields: OAUTH_CLIENT_FIELDS });
};

/**
 * The secret is shown only once, so human output keeps it on its own last line of stdout
 * and the notice goes to stderr. Structured output keeps it in the object for scripts.
 */
const reportOAuthClientSecret = (
	props: AuthBranchProps,
	data: { client_secret?: string; [field: string]: unknown },
	fields: readonly string[],
	entries: [string, string | undefined][],
	title: string,
) => {
	if (props.output === "table") {
		printKvBlock(title, entries);
		if (data.client_secret) {
			writeStyled(`${data.client_secret}\n`);
		}
	} else {
		writer(props).end(data as never, { fields: fields as never });
	}
	if (data.client_secret) {
		log.warning("Store this secret now: it is not shown again.");
	}
};

const oauthClientCreate = async (
	props: AuthBranchProps & {
		name: string;
		type: "confidential" | "public";
		redirectUris: string[];
		resources: string[];
		skipConsent?: boolean;
	},
) => {
	requireNonBlankString("--name", props.name, "Pass --name <name>.");
	requireNonEmptyLists([
		["--redirect-uris", props.redirectUris],
		["--resources", props.resources],
	]);
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.createNeonAuthOAuthClient(
		props.projectId,
		branchId,
		{
			name: props.name.trim(),
			type: props.type,
			redirect_uris: unique(props.redirectUris),
			resources: unique(props.resources),
			skip_consent: props.skipConsent,
		},
	);
	reportOAuthClientSecret(
		props,
		data,
		[...OAUTH_CLIENT_FIELDS, "client_secret"],
		printOAuthClientEntries(data),
		"OAuth client",
	);
};

const oauthClientGet = async (
	props: AuthBranchProps & { clientId: string },
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthOAuthClient(
		props.projectId,
		branchId,
		props.clientId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: OAUTH_CLIENT_FIELDS });
		return;
	}
	printKvBlock("OAuth client", printOAuthClientEntries(data));
};

const oauthClientUpdate = async (
	props: AuthBranchProps & {
		clientId: string;
		name?: string;
		redirectUris?: string[];
		resources?: string[];
		skipConsent?: boolean;
		disabled?: boolean;
	},
) => {
	requireNonBlankString("--name", props.name, "Pass --name <name>.");
	requireNonEmptyLists([
		["--redirect-uris", props.redirectUris],
		["--resources", props.resources],
	]);
	requireUpdateFields(
		[
			props.name,
			props.redirectUris,
			props.resources,
			props.skipConsent,
			props.disabled,
		],
		[
			"--name",
			"--redirect-uris",
			"--resources",
			"--skip-consent",
			"--disabled",
		],
	);
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.updateNeonAuthOAuthClient(
		props.projectId,
		branchId,
		props.clientId,
		{
			name: props.name?.trim(),
			redirect_uris: props.redirectUris && unique(props.redirectUris),
			resources: props.resources && unique(props.resources),
			skip_consent: props.skipConsent,
			disabled: props.disabled,
		},
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: OAUTH_CLIENT_FIELDS });
		return;
	}
	printKvBlock("OAuth client updated", printOAuthClientEntries(data));
};

const oauthClientDelete = async (
	props: AuthBranchProps & { clientId: string },
) => {
	const branchId = await resolveBranch(props);
	await props.apiClient.deleteNeonAuthOAuthClient(
		props.projectId,
		branchId,
		props.clientId,
	);
	printMessage(`OAuth client "${props.clientId}" deleted`);
};

const oauthClientRotateSecret = async (
	props: AuthBranchProps & { clientId: string },
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.rotateNeonAuthOAuthClientSecret(
		props.projectId,
		branchId,
		props.clientId,
	);
	reportOAuthClientSecret(
		props,
		data,
		OAUTH_CLIENT_SECRET_FIELDS,
		[["Client ID:", data.client_id]],
		"OAuth client secret",
	);
};

// --- Webhook ---

const printWebhookEntries = (data: {
	enabled: boolean;
	webhook_url?: string;
	enabled_events?: string[];
	timeout_seconds?: number;
}): [string, string][] => [
	["Enabled:", String(data.enabled)],
	["URL:", data.webhook_url ?? ""],
	["Events:", (data.enabled_events ?? []).join(", ")],
	[
		"Timeout (sec):  ",
		data.timeout_seconds != null ? String(data.timeout_seconds) : "",
	],
];

const webhookGet = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthWebhookConfig(
		props.projectId,
		branchId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: WEBHOOK_FIELDS });
		return;
	}
	printKvBlock("Webhook configuration", printWebhookEntries(data));
};

const webhookUpdate = async (
	props: AuthBranchProps & {
		enabled: boolean;
		url?: string;
		enabledEvents?: string[];
		timeout?: number;
	},
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.updateNeonAuthWebhookConfig(
		props.projectId,
		branchId,
		{
			enabled: props.enabled,
			webhook_url: props.url,
			enabled_events: props.enabledEvents as
				| (
						| "user.before_create"
						| "user.created"
						| "send.otp"
						| "send.magic_link"
				  )[]
				| undefined,
			timeout_seconds: props.timeout,
		},
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: WEBHOOK_FIELDS });
		return;
	}
	printKvBlock("Webhook configuration updated", printWebhookEntries(data));
};

// --- Plugins ---

const pluginTitle = (name: string): string =>
	name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) +
	" configuration";

const formatValue = (v: unknown): string => {
	if (v == null) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return JSON.stringify(v);
};

const pluginsList = async (props: AuthBranchProps) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthPluginConfigs(
		props.projectId,
		branchId,
	);
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data as any, {
			fields: Object.keys(data) as any,
		});
		return;
	}
	const summarize = (value: unknown): string => {
		if (value == null) return "not configured";
		if (typeof value === "boolean") return String(value);
		if (typeof value === "string") return value;
		if (typeof value === "number") return String(value);
		if (Array.isArray(value))
			return value.length === 1
				? "1 item"
				: `${String(value.length)} items`;
		if (typeof value === "object") {
			const obj = value as Record<string, unknown>;
			if ("enabled" in obj) return obj.enabled ? "enabled" : "disabled";
			if ("type" in obj) return formatValue(obj.type);
		}
		return JSON.stringify(value);
	};
	const entries: [string, string][] = Object.entries(data).map(
		([key, value]) => [key, summarize(value)],
	);
	printKvBlock("Neon Auth plugins", entries);
};

const pluginsGet = async (props: AuthBranchProps & { pluginName: string }) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.getNeonAuthPluginConfigs(
		props.projectId,
		branchId,
	);
	const plugin = (data as any)[props.pluginName];
	if (plugin === undefined) {
		const available = Object.keys(data).join(", ");
		throw new Error(
			`Unknown plugin "${props.pluginName}". Available plugins: ${available}`,
		);
	}
	if (props.output === "json" || props.output === "yaml") {
		const fields =
			typeof plugin === "object" && !Array.isArray(plugin)
				? Object.keys(plugin)
				: [];
		writer(props).end(plugin, { fields: fields as any });
		return;
	}
	if (
		typeof plugin === "object" &&
		!Array.isArray(plugin) &&
		plugin != null
	) {
		const entries: [string, string][] = Object.entries(plugin).map(
			([k, v]) => [`${k}:`, formatValue(v)],
		);
		printKvBlock(pluginTitle(props.pluginName), entries);
	} else if (Array.isArray(plugin)) {
		const entries: [string, string][] = plugin.map((item, i) => [
			`[${i}]:`,
			typeof item === "object" ? JSON.stringify(item) : String(item),
		]);
		printKvBlock(pluginTitle(props.pluginName), entries);
	} else {
		printKvBlock(pluginTitle(props.pluginName), [
			["Value:", String(plugin)],
		]);
	}
};

// --- User ---

const userCreate = async (
	props: AuthBranchProps & { email: string; name?: string },
) => {
	const branchId = await resolveBranch(props);
	const requestBody = {
		email: props.email,
		name: props.name ?? props.email,
	};
	const { data } = await props.apiClient.createBranchNeonAuthNewUser(
		props.projectId,
		branchId,
		requestBody,
	);
	const displayName =
		requestBody.name !== props.email ? requestBody.name : undefined;
	printKvBlock("User created", [
		["ID:", data.id],
		["Email:", requestBody.email],
		...(displayName ? [["Name:", displayName] as [string, string]] : []),
	]);
};

const userDelete = async (props: AuthBranchProps & { userId: string }) => {
	const branchId = await resolveBranch(props);
	await props.apiClient.deleteBranchNeonAuthUser(
		props.projectId,
		branchId,
		props.userId,
	);
	printMessage(`User "${props.userId}" deleted`);
};

const userSetRole = async (
	props: AuthBranchProps & { userId: string; roles: string[] },
) => {
	const branchId = await resolveBranch(props);
	const { data } = await props.apiClient.updateNeonAuthUserRole(
		props.projectId,
		branchId,
		props.userId,
		{ roles: props.roles },
	);
	printKvBlock("Roles updated", [
		["User ID:", data.id],
		["Roles:", props.roles.join(", ")],
	]);
};
