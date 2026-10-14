import type {
	DataApiCreateRequest as DataAPICreateRequest,
	DataApiSettings as DataAPISettings,
	DataApiUpdateRequest as DataAPIUpdateRequest,
} from "@neon/sdk";
import type yargs from "yargs";
import { isNeonApiError, retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import {
	branchIdFromProps,
	fillSingleProjectUnlessDbUrl,
	resolveSingleDatabase,
} from "../utils/enrichers.js";
import { writer } from "../writer.js";

const SETTINGS_FIELDS = [
	"db_aggregates_enabled",
	"db_anon_role",
	"db_extra_search_path",
	"db_max_rows",
	"db_schemas",
	"jwt_role_claim_key",
	"jwt_cache_max_lifetime",
	"openapi_mode",
	"server_cors_allowed_origins",
	"server_timing_enabled",
] as const;

type DataApiProps = BranchScopeProps & {
	database?: string;
};

const settingsFlags = {
	"db-aggregates-enabled": {
		type: "boolean",
		describe: "Enable aggregate functions in queries",
	},
	"db-anon-role": {
		type: "string",
		describe: "Database role used for anonymous (unauthenticated) requests",
	},
	"db-extra-search-path": {
		type: "string",
		describe: "Extra schemas appended to the search path",
	},
	"db-max-rows": {
		type: "number",
		describe: "Maximum number of rows returned by a single request",
	},
	"db-schemas": {
		type: "string",
		describe: "Comma-separated list of schemas exposed via the Data API",
	},
	"jwt-role-claim-key": {
		type: "string",
		describe: "JWT claim path used to extract the role",
	},
	"jwt-cache-max-lifetime": {
		type: "number",
		describe: "Maximum JWT cache lifetime in seconds",
	},
	"openapi-mode": {
		type: "string",
		choices: ["ignore-privileges", "disabled"],
		describe: "OpenAPI mode",
	},
	"server-cors-allowed-origins": {
		type: "string",
		describe: "CORS allowed origins",
	},
	"server-timing-enabled": {
		type: "boolean",
		describe: "Enable Server-Timing response headers",
	},
} as const;

export const command = "data-api";
export const describe = "Manage the Neon Data API for a database";
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 data-api <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
			database: {
				describe: "Database name",
				type: "string",
			},
		})
		.middleware(fillSingleProjectUnlessDbUrl as any)
		.command(
			"create",
			"Provision the Neon Data API for a database",
			(yargs) =>
				yargs.options({
					"auth-provider": {
						type: "string",
						choices: ["neon_auth", "external"],
						describe: "Authentication provider",
					},
					"jwks-url": {
						type: "string",
						describe:
							"URL that lists the JWKS (used with external auth)",
					},
					"provider-name": {
						type: "string",
						describe:
							"Name of the auth provider (e.g. Clerk, Stytch, Auth0)",
					},
					"jwt-audience": {
						type: "string",
						describe: "Expected JWT audience claim",
					},
					"add-default-grants": {
						type: "boolean",
						describe:
							"Grant all permissions on tables in the public schema to authenticated users",
					},
					"skip-auth-schema": {
						type: "boolean",
						describe:
							"Skip creating the auth schema and RLS functions",
					},
					...settingsFlags,
				}),
			(args) => create(args as any),
		)
		.command(
			"get",
			"Show the Neon Data API status and settings",
			(yargs) => yargs,
			(args) => get(args as any),
		)
		.command(
			"update",
			"Update Neon Data API settings (merges with current settings by default)",
			(yargs) =>
				yargs.options({
					replace: {
						type: "boolean",
						default: false,
						describe:
							"Replace settings with only the flags provided. Omitted settings revert to server defaults.",
					},
					...settingsFlags,
				}),
			(args) => update(args as any),
		)
		.command(
			"refresh-schema",
			"Refresh the Data API schema cache without changing settings",
			(yargs) => yargs,
			(args) => refreshSchema(args as any),
		)
		.command(
			"delete",
			"Tear down the Neon Data API for a database",
			(yargs) => yargs,
			(args) => deleteDataApi(args as any),
		)
		.command(
			"gen-types",
			"Generate TypeScript types from the database schema",
			(yargs) =>
				yargs
					.options({
						"db-url": {
							type: "string",
							describe:
								"Postgres connection string. Skips the Neon API; defaults to the connection for --project-id, --branch, --role-name and --database",
						},
						"role-name": {
							type: "string",
							describe:
								"Role to connect as. Ignored with --db-url",
						},
						"out-file": {
							type: "string",
							default: "database.types.ts",
							describe: "File to write the types to",
						},
						schema: {
							alias: "s",
							type: "array",
							string: true,
							default: ["public"],
							describe: "Schema to include (repeatable)",
						},
						"postgrest-v9-compat": {
							type: "boolean",
							default: false,
							describe:
								"Disable one-to-one relationship detection",
						},
						"query-timeout": {
							type: "string",
							describe: "Query timeout, such as 30s, 1m or 90s",
						},
					})
					.example(
						"$0 data-api gen-types --db-url postgresql://user:pass@host/db",
						"Generate types from any Postgres",
					),
			async (args) => {
				const { genTypes } = await import("./data_api_gen_types.js");
				await genTypes(args as any);
			},
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

const TOP_LEVEL_CREATE_FIELDS = [
	"auth_provider",
	"jwks_url",
	"provider_name",
	"jwt_audience",
	"add_default_grants",
	"skip_auth_schema",
] as const;

const argKey = (snake: string) => snake.replace(/_/g, "-");

const buildSettings = (
	args: Record<string, unknown>,
): DataAPISettings | undefined => {
	const settings: Record<string, unknown> = {};
	for (const field of SETTINGS_FIELDS) {
		const value = args[argKey(field)];
		if (value === undefined) continue;
		if (field === "db_schemas" && typeof value === "string") {
			settings[field] = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else {
			settings[field] = value;
		}
	}
	return Object.keys(settings).length > 0
		? (settings as DataAPISettings)
		: undefined;
};

const buildCreateBody = (
	args: Record<string, unknown>,
): DataAPICreateRequest => {
	const body: Record<string, unknown> = {};
	for (const field of TOP_LEVEL_CREATE_FIELDS) {
		const value = args[argKey(field)];
		if (value !== undefined) body[field] = value;
	}
	const settings = buildSettings(args);
	if (settings) body.settings = settings;
	return body as DataAPICreateRequest;
};

const create = async (
	props: DataApiProps & Record<string, unknown>,
): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const database = await resolveSingleDatabase({
		apiClient: props.apiClient,
		projectId: props.projectId,
		branchId,
		database: props.database,
	});
	const body = buildCreateBody(props);
	const { data } = await retryOnLock(() =>
		props.apiClient.createProjectBranchDataApi(
			props.projectId,
			branchId,
			database,
			body,
		),
	);
	writer(props).end(data, { fields: ["url"] });
};

const GET_FIELDS = ["url", "status", "db_schemas"] as const;

const get = async (props: DataApiProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const database = await resolveSingleDatabase({
		apiClient: props.apiClient,
		projectId: props.projectId,
		branchId,
		database: props.database,
	});
	const { data } = await props.apiClient.getProjectBranchDataApi(
		props.projectId,
		branchId,
		database,
	);

	// Drop available_schemas from json/yaml output (not part of the public surface).
	const { available_schemas: _ignored, ...publicData } = data;

	// For table output, flatten db_schemas onto the top-level for column rendering.
	const tableRow = {
		url: publicData.url,
		status: publicData.status,
		db_schemas: (publicData.settings?.db_schemas ?? []).join(", "),
	};

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(publicData, {
			fields: ["url", "status", "settings"] as const,
		});
		return;
	}
	writer(props).end(tableRow, { fields: GET_FIELDS });
};

const update = async (
	props: DataApiProps & { replace: boolean } & Record<string, unknown>,
): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const database = await resolveSingleDatabase({
		apiClient: props.apiClient,
		projectId: props.projectId,
		branchId,
		database: props.database,
	});

	const userSettings = buildSettings(props);

	if (!userSettings) {
		throw new Error(
			"No settings flags provided. Pass at least one setting flag to update, or use `data-api refresh-schema` to refresh the schema cache without changing settings.",
		);
	}

	let settings: DataAPISettings | undefined;
	if (props.replace) {
		settings = userSettings;
	} else {
		let current: DataAPISettings | undefined;
		try {
			const { data } = await props.apiClient.getProjectBranchDataApi(
				props.projectId,
				branchId,
				database,
			);
			current = data.settings ?? undefined;
		} catch (err: unknown) {
			if (isNeonApiError(err) && err.status === 404) {
				throw new Error(
					`Data API is not provisioned for ${database} on branch ${branchId}. Run \`${getCliName()} data-api create\` first.`,
				);
			}
			throw err;
		}
		if (!current) {
			throw new Error(
				`Could not read current Data API settings for ${database} on branch ${branchId}. Retry, or pass --replace to overwrite.`,
			);
		}
		settings = { ...current, ...(userSettings ?? {}) };
	}

	const body: DataAPIUpdateRequest = {};
	if (settings) body.settings = settings;

	try {
		await retryOnLock(() =>
			props.apiClient.updateProjectBranchDataApi(
				props.projectId,
				branchId,
				database,
				body,
			),
		);
	} catch (err: unknown) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				`Data API is not provisioned for ${database} on branch ${branchId}. Run \`${getCliName()} data-api create\` first.`,
			);
		}
		throw err;
	}
	log.info(`Data API settings updated for ${database} on branch ${branchId}`);
};

const refreshSchema = async (props: DataApiProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const database = await resolveSingleDatabase({
		apiClient: props.apiClient,
		projectId: props.projectId,
		branchId,
		database: props.database,
	});
	try {
		await retryOnLock(() =>
			props.apiClient.updateProjectBranchDataApi(
				props.projectId,
				branchId,
				database,
				{},
			),
		);
	} catch (err: unknown) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				`Data API is not provisioned for ${database} on branch ${branchId}. Run \`${getCliName()} data-api create\` first.`,
			);
		}
		throw err;
	}
	log.info(
		`Data API schema cache refreshed for ${database} on branch ${branchId}`,
	);
};

const deleteDataApi = async (props: DataApiProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const database = await resolveSingleDatabase({
		apiClient: props.apiClient,
		projectId: props.projectId,
		branchId,
		database: props.database,
	});
	try {
		await retryOnLock(() =>
			props.apiClient.deleteProjectBranchDataApi(
				props.projectId,
				branchId,
				database,
			),
		);
	} catch (err: unknown) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				`Data API is not provisioned for ${database} on branch ${branchId}.`,
			);
		}
		throw err;
	}
	log.info(`Data API deleted for ${database} on branch ${branchId}`);
};
