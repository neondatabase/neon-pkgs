import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfigFromFile } from "@neon/config-runtime";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import open from "open";
import prompts from "prompts";
import type yargs from "yargs";
import {
	type ClaimableCapability,
	ClaimableClient,
	ClaimableServiceError,
	DEFAULT_CLAIMABLE_ORIGIN,
} from "../claimable/api.js";
import {
	assertionHasExpired,
	listClaimableCredentials,
	readClaimableCredentials,
	removeClaimableCredentials,
	resolveClaimableContext,
	type StoredClaimableCredentials,
	writeClaimableCredentials,
} from "../claimable/state.js";
import { declaredNeonServices } from "../config_services.js";
import {
	applyContext,
	contextBranch,
	ensureGitignored,
	readContextFile,
} from "../context.js";
import { isCi } from "../env.js";
import { mergeEnvFile, resolveEnvFilePath } from "../env_file.js";
import { log } from "../log.js";
import {
	deprecatedServiceMessage,
	NEON_SERVICES,
	type NeonService,
	parseServices,
	servicesFlagValue,
	servicesOption,
} from "../neon_services.js";
import { noPassthrough } from "../utils/flags.js";
import { writer } from "../writer.js";

type ClaimProps = {
	_: (string | number)[];
	output: "yaml" | "json" | "table";
	configDir: string;
	contextFile: string;
	claimableHost: string;
	profile?: string;
	apiKey: string;
	projectId?: string;
};

type CreateProps = ClaimProps & {
	services?: readonly NeonService[];
	config?: string;
	file?: string;
	envPull: boolean;
};

type AcceptProps = ClaimProps & {
	open: boolean;
};

type DeleteProps = ClaimProps & {
	yes: boolean;
};

const CAPABILITY_FOR_SERVICE: Readonly<
	Record<NeonService, ClaimableCapability>
> = {
	postgres: "postgres",
	auth: "auth",
	"data-api": "data_api",
	functions: "functions",
	"object-storage": "storage",
	"ai-gateway": "ai_gateway",
};

const CAPABILITY_ORDER: readonly ClaimableCapability[] = [
	"postgres",
	"data_api",
	"auth",
	"storage",
	"functions",
	"ai_gateway",
];

export const claimableCapabilities = (
	services: readonly NeonService[],
): ClaimableCapability[] => {
	const requested = new Set<ClaimableCapability>(["postgres"]);
	for (const service of services) {
		requested.add(CAPABILITY_FOR_SERVICE[service]);
	}
	return CAPABILITY_ORDER.filter((capability) => requested.has(capability));
};

const CONFIG_FILENAMES = [
	"neon.ts",
	"neon.mts",
	"neon.js",
	"neon.mjs",
] as const;

export const findNeonConfig = (cwd = process.cwd()): string | undefined => {
	let current = resolve(cwd);
	const stop = resolve(homedir());
	while (true) {
		for (const name of CONFIG_FILENAMES) {
			const candidate = join(current, name);
			if (existsSync(candidate)) return candidate;
		}
		if (existsSync(join(current, ".git")) || current === stop)
			return undefined;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
};

const servicesFromConfig = async (
	explicitPath: string | undefined,
): Promise<NeonService[]> => {
	const path = explicitPath ?? findNeonConfig();
	if (!path) return [];
	const { config } = await loadConfigFromFile({ path });
	return declaredNeonServices(config);
};

const removeFileIfPresent = (path: string): void => {
	try {
		unlinkSync(path);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
};

const failureMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const CLAIM_LIST_FIELDS = [
	"project_id",
	"branch_id",
	"expires_at",
	"origin",
] as const;

export const CLAIM_CREATE_FIELDS = [
	"project_id",
	"branch_id",
	"state",
	"expires_at",
	"granted_capabilities",
	"denied_capabilities",
	"env_file",
] as const;

export const claimCreateFields = (
	denied: readonly unknown[],
): (typeof CLAIM_CREATE_FIELDS)[number][] =>
	CLAIM_CREATE_FIELDS.filter(
		(field) => field !== "denied_capabilities" || denied.length > 0,
	);

export const command = "claim";
export const aliases = ["claimable"];
export const describe = "Create and claim temporary Neon projects";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 claim <sub-command> [options]")
		.option("claimable-host", {
			describe: "Claimable Neon service origin",
			type: "string",
			default:
				process.env.CLAIMABLE_NEON_HOST ?? DEFAULT_CLAIMABLE_ORIGIN,
			hidden: true,
		})
		.command(
			"create",
			"Create a temporary Neon project without an account",
			(y) =>
				y
					.option(
						"service",
						servicesOption({
							key: "service",
							allowed: NEON_SERVICES,
							describe:
								"Services to request for the claimable project",
							also: "Postgres is always included. Services unavailable before claim are recorded and reported.",
						}),
					)
					.option("file", {
						describe:
							"Target dotenv file. Defaults to an existing .env, otherwise .env.local",
						type: "string",
					})
					.option("config", {
						describe:
							"Path to neon.ts. Defaults to walking up from the current directory",
						type: "string",
					})
					.option("env-pull", {
						describe:
							"Write the provisioned DATABASE_URL and service URLs to a dotenv file",
						type: "boolean",
						default: true,
					})
					.strict()
					.check(noPassthrough("claim create")),
			async (args) => {
				const rawServices = servicesFlagValue(args.service);
				const services = rawServices
					? parseServices(rawServices, {
							allowed: NEON_SERVICES,
							flag: "--service",
							onDeprecated: (used, canonical) =>
								log.warning(
									deprecatedServiceMessage(used, canonical),
								),
						})
					: [];
				const configuredServices = await servicesFromConfig(
					typeof args.config === "string" ? args.config : undefined,
				);
				await create({
					...(args as unknown as CreateProps),
					services: [
						...new Set([...services, ...configuredServices]),
					],
				});
			},
		)
		.command(
			"status [project-id]",
			"Show a claimable project's lifecycle and claim status",
			(y) =>
				y
					.positional("project-id", {
						describe:
							"Project from `neon claim list`. Defaults to the project linked in this directory",
						type: "string",
					})
					.strict()
					.check(noPassthrough("claim status")),
			async (args) => await status(args as unknown as ClaimProps),
		)
		.command(
			"accept [project-id]",
			"Create a claim code and open the URL where a human signs in and takes the project",
			(y) =>
				y
					.positional("project-id", {
						describe:
							"Project from `neon claim list`. Defaults to the project linked in this directory",
						type: "string",
					})
					.option("open", {
						describe: "Open the verification URL in a browser",
						type: "boolean",
						default: true,
					})
					.strict()
					.check(noPassthrough("claim accept")),
			async (args) => await accept(args as unknown as AcceptProps),
		)
		.command(
			"list",
			"List claimable projects saved on this machine",
			(y) => y.strict().check(noPassthrough("claim list")),
			async (args) => list(args as unknown as ClaimProps),
		)
		.command(
			"delete [project-id]",
			"Permanently delete an unclaimed project, or drop a local record that can no longer reach the service",
			(y) =>
				y
					.positional("project-id", {
						describe:
							"Project from `neon claim list`. Defaults to the project linked in this directory",
						type: "string",
					})
					.option("yes", {
						alias: "y",
						describe: "Skip the confirmation prompt",
						type: "boolean",
						default: false,
					})
					.strict()
					.check(noPassthrough("claim delete")),
			async (args) => await deleteProject(args as unknown as DeleteProps),
		)
		.demandCommand(1, "Run `neon claim --help` to see the subcommands.");

export const handler = (_args: yargs.Arguments) => {
	/* Yargs requires a handler for command groups. */
};

const rejectExplicitAccountCredential = (props: ClaimProps): void => {
	const inputs = credentialInputs();
	if (inputs.apiKeyFlag.trim() !== "" || props.profile?.trim()) {
		throw new Error(
			"Claimable Neon does not use a Neon account credential. Remove --api-key or --profile.",
		);
	}
};

const resolveTarget = (
	props: ClaimProps,
): {
	projectId: string;
	credentials: StoredClaimableCredentials;
	client: ClaimableClient;
	contextMatches: boolean;
} => {
	rejectExplicitAccountCredential(props);
	const requested = props.projectId?.trim();
	const context = readContextFile(props.contextFile);
	const linked = resolveClaimableContext(context);
	const projectId = requested || linked?.projectId;
	if (projectId === undefined) {
		throw new Error(
			"This directory is not linked to a claimable project. Pass a project id from `neon claim list`, or run `neon claim create` first.",
		);
	}
	const credentials = readClaimableCredentials(props.configDir, projectId);
	if (credentials === null) {
		throw new Error(
			`The identity assertion for ${projectId} is missing. The project cannot be managed from this machine; claim it through its existing verification URL or run \`neon link\` after it is claimed.`,
		);
	}
	const client = new ClaimableClient(credentials.origin);
	const contextMatches = linked?.projectId === projectId;
	if (
		contextMatches &&
		linked !== null &&
		client.origin !== new ClaimableClient(linked.origin).origin
	) {
		throw new Error(
			"The .neon context and saved identity assertion name different Claimable Neon services. Delete .neon or the assertion file and run `neon claim create` in a new directory.",
		);
	}
	return { projectId, credentials, client, contextMatches };
};

const requireLiveIdentity = (credentials: StoredClaimableCredentials): void => {
	if (assertionHasExpired(credentials)) {
		throw new Error(
			`The identity assertion for ${credentials.projectId} has expired. Run \`neon claim delete ${credentials.projectId} --yes\` to drop the local record.`,
		);
	}
};

const isUnusableIdentity = (error: unknown): error is ClaimableServiceError =>
	error instanceof ClaimableServiceError &&
	(error.code === "invalid_grant" ||
		error.code === "project_expired" ||
		error.code === "not_found");

const clearLocalRecord = (
	props: ClaimProps,
	projectId: string,
	contextMatches: boolean,
): void => {
	removeClaimableCredentials(props.configDir, projectId);
	if (contextMatches && existsSync(props.contextFile)) {
		applyContext(props.contextFile, {});
	}
};

const create = async (props: CreateProps): Promise<void> => {
	rejectExplicitAccountCredential(props);
	const existing = readContextFile(props.contextFile);
	if (existing.projectId || existing.orgId || existing.claimable) {
		throw new Error(
			`${props.contextFile} already links this directory to a Neon project. Run \`neon claim create\` from an unlinked directory.`,
		);
	}
	const contextFileExisted = existsSync(props.contextFile);
	const envFile = props.envPull
		? resolveEnvFilePath(process.cwd(), props.file)
		: undefined;
	const envFileExisted = envFile ? existsSync(envFile) : false;
	const previousEnv =
		envFileExisted && envFile ? readFileSync(envFile) : undefined;

	const client = new ClaimableClient(props.claimableHost);
	const registration = await client.register({
		capabilities: claimableCapabilities(props.services ?? []),
		source: "neon_cli",
	});
	const stored: StoredClaimableCredentials = {
		version: 1,
		origin: client.origin,
		registrationId: registration.registrationId,
		projectId: registration.project.id,
		branchId: registration.project.branchId,
		identityAssertion: registration.identityAssertion,
		expiresAt: registration.project.expiresAt,
		assertionExpires: registration.assertionExpires,
	};
	let localStateWritten = false;
	let contextWritten = false;
	let envWriteAttempted = false;
	let accessToken: string | undefined;
	try {
		// Save the assertion first so failed cleanup can still be retried.
		writeClaimableCredentials(props.configDir, stored);
		localStateWritten = true;
		applyContext(props.contextFile, {
			projectId: registration.project.id,
			branch: registration.project.branchId,
			claimable: { version: 1, origin: client.origin },
		});
		contextWritten = true;

		const token = await client.exchange(registration.identityAssertion);
		accessToken = token.accessToken;
		const credentials = await client.credentials(
			registration.project.id,
			token.accessToken,
		);
		if (
			credentials.projectId !== registration.project.id ||
			credentials.branchId !== registration.project.branchId
		) {
			throw new Error(
				"Claimable Neon returned credentials for a different project. The project was not kept.",
			);
		}

		if (envFile) {
			const env = {
				DATABASE_URL: credentials.databaseUrl,
				...(credentials.services.dataApi
					? { NEON_DATA_API_URL: credentials.services.dataApi.url }
					: {}),
				...(credentials.services.auth
					? {
							NEON_AUTH_BASE_URL:
								credentials.services.auth.baseUrl,
							NEON_AUTH_JWKS_URL:
								credentials.services.auth.jwksUrl,
						}
					: {}),
			};
			envWriteAttempted = true;
			mergeEnvFile(envFile, env);
			ensureGitignored(envFile);
		}

		const granted = registration.capabilities
			.filter((decision) => decision.granted)
			.map((decision) => decision.capability);
		const denied = registration.capabilities
			.filter((decision) => !decision.granted)
			.map((decision) => ({
				capability: decision.capability,
				reason: decision.reason,
				message: decision.message,
			}));
		writer(props).end(
			{
				project_id: registration.project.id,
				branch_id: registration.project.branchId,
				state: "unclaimed",
				expires_at: registration.project.expiresAt,
				granted_capabilities: granted,
				denied_capabilities: denied,
				...(envFile ? { env_file: envFile } : {}),
			},
			{
				fields: claimCreateFields(denied),
				renderColumns: {
					denied_capabilities: (row) =>
						row.denied_capabilities
							.map(
								(decision) =>
									`${decision.capability}: ${decision.message}`,
							)
							.join(", "),
				},
			},
		);
	} catch (error) {
		let remoteDeleted = false;
		try {
			const cleanupToken =
				accessToken ??
				(await client.exchange(registration.identityAssertion))
					.accessToken;
			await client.deleteProject(registration.project.id, cleanupToken);
			remoteDeleted = true;
		} catch (cleanupError) {
			log.error(
				"Claimable project %s could not be cleaned up after create failed: %s",
				registration.project.id,
				failureMessage(cleanupError),
			);
			if (localStateWritten && contextWritten) {
				log.error(
					"Retry cleanup with `neon claim delete --yes` from this directory.",
				);
			}
		}

		if (remoteDeleted) {
			try {
				if (localStateWritten) {
					removeClaimableCredentials(
						props.configDir,
						registration.project.id,
					);
				}
				if (contextWritten) {
					if (contextFileExisted) {
						applyContext(props.contextFile, existing);
					} else {
						removeFileIfPresent(props.contextFile);
					}
				}
				if (envWriteAttempted && envFile) {
					if (envFileExisted && previousEnv) {
						writeFileSync(envFile, previousEnv);
					} else {
						removeFileIfPresent(envFile);
					}
				}
			} catch (rollbackError) {
				log.error(
					"Project cleanup succeeded, but local rollback failed: %s",
					failureMessage(rollbackError),
				);
			}
		}
		throw error;
	}
};

const status = async (props: ClaimProps): Promise<void> => {
	const { projectId, credentials, client, contextMatches } =
		resolveTarget(props);
	if (assertionHasExpired(credentials)) {
		writer(props).end(
			{
				project_id: projectId,
				state: "expired",
				reconciled: false,
				project_expires_at: credentials.expiresAt,
			},
			{
				fields: [
					"project_id",
					"state",
					"reconciled",
					"project_expires_at",
				],
			},
		);
		return;
	}
	try {
		const token = await client.exchange(credentials.identityAssertion);
		let claimState = "unclaimed";
		let reconciled = false;
		let claimExpiresAt: string | undefined;
		try {
			const claim = await client.claimStatus(
				projectId,
				token.accessToken,
			);
			claimState = claim.state;
			reconciled = claim.reconciled;
			claimExpiresAt = claim.expiresAt;
		} catch (error) {
			if (
				!(error instanceof ClaimableServiceError) ||
				error.code !== "not_found"
			) {
				throw error;
			}
		}
		if (reconciled) {
			finishClaimedContext(props, projectId, contextMatches);
		}
		writer(props).end(
			{
				project_id: projectId,
				state: claimState,
				reconciled,
				project_expires_at: credentials.expiresAt,
				...(claimExpiresAt ? { claim_expires_at: claimExpiresAt } : {}),
			},
			{
				fields: [
					"project_id",
					"state",
					"reconciled",
					"project_expires_at",
					"claim_expires_at",
				],
			},
		);
	} catch (error) {
		if (
			error instanceof ClaimableServiceError &&
			error.code === "project_claimed"
		) {
			finishClaimedContext(props, projectId, contextMatches);
			writer(props).end(
				{
					project_id: projectId,
					state: "claimed",
					reconciled: true,
				},
				{ fields: ["project_id", "state", "reconciled"] },
			);
			return;
		}
		if (isUnusableIdentity(error)) {
			writer(props).end(
				{
					project_id: projectId,
					state: "expired",
					reconciled: false,
					project_expires_at: credentials.expiresAt,
				},
				{
					fields: [
						"project_id",
						"state",
						"reconciled",
						"project_expires_at",
					],
				},
			);
			return;
		}
		throw error;
	}
};

const accept = async (props: AcceptProps): Promise<void> => {
	const { projectId, credentials, client } = resolveTarget(props);
	requireLiveIdentity(credentials);
	const token = await client.exchange(credentials.identityAssertion);
	const claim = await client.createClaim(projectId, token.accessToken);

	writer(props).end(
		{
			project_id: projectId,
			user_code: claim.userCode,
			verification_url: claim.verificationUriComplete,
			expires_in_seconds: claim.expiresIn,
		},
		{
			fields: [
				"project_id",
				"user_code",
				"verification_url",
				"expires_in_seconds",
			],
		},
	);

	if (props.open && !isCi()) {
		open(claim.verificationUriComplete).catch(() => {
			log.info(
				"Could not open a browser. Open %s",
				claim.verificationUriComplete,
			);
		});
	} else if (props.open) {
		log.info(
			"Browser opening is disabled in CI. Open %s",
			claim.verificationUriComplete,
		);
	}
};

const list = (props: ClaimProps): void => {
	rejectExplicitAccountCredential(props);
	const projects = listClaimableCredentials(props.configDir).map((item) => ({
		project_id: item.projectId,
		branch_id: item.branchId,
		expires_at: item.expiresAt,
		origin: item.origin,
	}));
	writer(props).end(projects, {
		fields: CLAIM_LIST_FIELDS,
		emptyMessage: "No Claimable Neon projects are saved on this machine.",
	});
};

const deleteProject = async (props: DeleteProps): Promise<void> => {
	const { projectId, credentials, client, contextMatches } =
		resolveTarget(props);
	if (!props.yes) {
		if (isCi() || !process.stdin.isTTY) {
			throw new Error(
				"Deleting a claimable project requires confirmation. Re-run interactively or pass --yes.",
			);
		}
		const { proceed } = await prompts({
			type: "confirm",
			name: "proceed",
			message: `Permanently delete ${projectId}?`,
			initial: false,
		});
		if (!proceed) {
			log.info("Claimable project was not deleted.");
			return;
		}
	}
	if (assertionHasExpired(credentials)) {
		clearLocalRecord(props, projectId, contextMatches);
		writer(props).end(
			{ project_id: projectId, state: "cleared" },
			{ fields: ["project_id", "state"] },
		);
		return;
	}
	try {
		const token = await client.exchange(credentials.identityAssertion);
		await client.deleteProject(projectId, token.accessToken);
	} catch (error) {
		if (!isUnusableIdentity(error)) {
			throw error;
		}
		clearLocalRecord(props, projectId, contextMatches);
		writer(props).end(
			{ project_id: projectId, state: "cleared" },
			{ fields: ["project_id", "state"] },
		);
		return;
	}
	clearLocalRecord(props, projectId, contextMatches);
	writer(props).end(
		{ project_id: projectId, state: "deleted" },
		{ fields: ["project_id", "state"] },
	);
};

const finishClaimedContext = (
	props: ClaimProps,
	projectId: string,
	contextMatches: boolean,
): void => {
	removeClaimableCredentials(props.configDir, projectId);
	if (contextMatches && existsSync(props.contextFile)) {
		const context = readContextFile(props.contextFile);
		applyContext(props.contextFile, {
			projectId: context.projectId,
			...(contextBranch(context)
				? { branch: contextBranch(context) }
				: {}),
		});
	}
	log.info(
		"Dropped the local identity assertion. The next command needs `neon auth` or `neon link`.",
	);
};
