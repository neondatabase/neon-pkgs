import type { Database, Endpoint, Role } from "@neon/sdk";
import { parseConnectionUri } from "../psql/index.js";
import { PgConnection } from "../psql/wire/connection.js";
import type { BranchScopeProps } from "../types.js";
import { EndpointType } from "./api_enums.js";
import { branchIdFromProps } from "./enrichers.js";
import { parsePITBranch } from "./point_in_time.js";

export const SSL_MODES = [
	"require",
	"verify-ca",
	"verify-full",
	"omit",
] as const;

export type SslMode = (typeof SSL_MODES)[number];

export type ResolveConnectionProps = BranchScopeProps & {
	branch?: string;
	roleName?: string;
	databaseName?: string;
	pooled?: boolean;
	prisma?: boolean;
	endpointType?: EndpointType;
	ssl?: SslMode;
};

export type ResolvedConnection = {
	/** Fully-formed `postgresql://…` connection URI. */
	connectionUri: string;
	host: string;
	role: string;
	password: string;
	database: string;
	/** The encoded query-string (sslmode, options, …), for extended output. */
	options: string;
};

export type InspectQueryScope = "database" | "compute";

export type InspectTarget = {
	database: string;
	connectionUri: string;
};

export type InspectTargetSelection = {
	databases: string[];
	includeDatabaseColumn: boolean;
};

export type SelectInspectTargetsInput = {
	databaseName?: string;
	dbUrlDatabase?: string;
	branchDatabases: readonly string[];
	scope: InspectQueryScope;
};

/**
 * Keep the database column on one-database branches so adding another database
 * does not change the output schema. Compute-wide views run once because every
 * database returns the same rows.
 */
export const selectInspectTargets = (
	input: SelectInspectTargetsInput,
): InspectTargetSelection => {
	if (input.dbUrlDatabase !== undefined) {
		return {
			databases: [input.dbUrlDatabase],
			includeDatabaseColumn: false,
		};
	}
	if (input.databaseName !== undefined) {
		return {
			databases: [input.databaseName],
			includeDatabaseColumn: false,
		};
	}
	if (input.branchDatabases.length === 0) {
		throw new Error("No databases found for the branch");
	}
	const sorted = [...input.branchDatabases].sort((a, b) =>
		a.localeCompare(b),
	);
	if (input.scope === "compute") {
		return { databases: [sorted[0]], includeDatabaseColumn: false };
	}
	return { databases: sorted, includeDatabaseColumn: true };
};

const connectionUriForDatabase = (
	connectionUri: string,
	database: string,
): string => {
	const url = new URL(connectionUri);
	url.pathname = database;
	return url.toString();
};

const listBranchDatabases = async (
	props: ResolveConnectionProps,
): Promise<{ branchId: string; names: string[] }> => {
	const projectId = props.projectId;
	const parsedPIT = props.branch
		? parsePITBranch(props.branch)
		: ({ tag: "head", branch: "" } as const);
	if (props.branch) {
		props.branch = parsedPIT.branch;
	}
	const branchId = await branchIdFromProps(props);
	const {
		data: { databases },
	} = await props.apiClient.listProjectBranchDatabases(projectId, branchId);
	return {
		branchId,
		names: databases.map((d: Database) => d.name),
	};
};

/**
 * Resolve a branch's live Postgres connection details via the Neon API
 * (endpoint → role → password → database → URL, honoring point-in-time,
 * pooling, prisma tuning, and SSL mode). Mirrors how `connection-string`
 * resolves a branch so `inspect db` connects the same way.
 */
export const resolveConnectionUri = async (
	props: ResolveConnectionProps,
): Promise<ResolvedConnection> => {
	const projectId = props.projectId;
	const parsedPIT = props.branch
		? parsePITBranch(props.branch)
		: ({ tag: "head", branch: "" } as const);
	if (props.branch) {
		props.branch = parsedPIT.branch;
	}
	const branchId = await branchIdFromProps(props);

	const {
		data: { endpoints },
	} = await props.apiClient.listProjectBranchEndpoints(projectId, branchId);
	const matchEndpointType = props.endpointType ?? EndpointType.ReadWrite;
	let endpoint = endpoints.find(
		(e: Endpoint) => e.type === matchEndpointType,
	);
	if (!endpoint && props.endpointType == null) {
		endpoint = endpoints[0];
	}
	if (!endpoint) {
		throw new Error(
			`No ${
				props.endpointType ?? ""
			} endpoint found for the branch: ${branchId}`,
		);
	}

	const role: string =
		props.roleName ||
		(await props.apiClient
			.listProjectBranchRoles(projectId, branchId)
			.then(({ data }): string => {
				if (data.roles.length === 0) {
					throw new Error(
						`No roles found for the branch: ${branchId}`,
					);
				}
				if (data.roles.length === 1) {
					return data.roles[0].name;
				}
				throw new Error(
					`Multiple roles found for the branch, please provide one with the --role-name option: ${data.roles
						.map((r: Role) => r.name)
						.join(", ")}`,
				);
			}));

	const {
		data: { databases: branchDatabases },
	} = await props.apiClient.listProjectBranchDatabases(projectId, branchId);

	const database =
		props.databaseName ||
		(() => {
			if (branchDatabases.length === 0) {
				throw new Error(
					`No databases found for the branch: ${branchId}`,
				);
			}
			if (branchDatabases.length === 1) {
				return branchDatabases[0].name;
			}
			throw new Error(
				`Multiple databases found for the branch, please provide one with the --database-name option: ${branchDatabases
					.map((d: Database) => d.name)
					.join(", ")}`,
			);
		})();

	if (!branchDatabases.find((d: Database) => d.name === database)) {
		throw new Error(`Database not found: ${database}`);
	}

	const {
		data: { password },
	} = await props.apiClient.getProjectBranchRolePassword(
		props.projectId,
		endpoint.branch_id,
		role,
	);

	let host = props.pooled
		? endpoint.host.replace(endpoint.id, `${endpoint.id}-pooler`)
		: endpoint.host;
	if (parsedPIT.tag !== "head") {
		host = endpoint.host.replace(endpoint.id, endpoint.branch_id);
	}
	const connectionString = new URL(`postgresql://${host}`);
	connectionString.pathname = database;
	connectionString.username = role;
	connectionString.password = password;

	if (props.prisma) {
		connectionString.searchParams.set("connect_timeout", "30");
		if (props.pooled) {
			connectionString.searchParams.set("pool_timeout", "30");
			connectionString.searchParams.set("pgbouncer", "true");
		}
	}

	const ssl = props.ssl ?? "require";
	if (ssl !== "omit") {
		connectionString.searchParams.set("sslmode", ssl);
		connectionString.searchParams.set("channel_binding", "require");
	}

	if (parsedPIT.tag === "lsn") {
		connectionString.searchParams.set(
			"options",
			`neon_lsn:${parsedPIT.lsn}`,
		);
	} else if (parsedPIT.tag === "timestamp") {
		connectionString.searchParams.set(
			"options",
			`neon_timestamp:${parsedPIT.timestamp}`,
		);
	}

	return {
		connectionUri: connectionString.toString(),
		host,
		role,
		password,
		database,
		options: connectionString.searchParams.toString(),
	};
};

export type ResolveInspectTargetsProps = ResolveConnectionProps & {
	dbUrl?: string;
};

export type ResolvedInspectTargets = {
	targets: InspectTarget[];
	includeDatabaseColumn: boolean;
};

export const resolveInspectTargets = async (
	props: ResolveInspectTargetsProps,
	scope: InspectQueryScope,
): Promise<ResolvedInspectTargets> => {
	if (props.dbUrl) {
		const parsed = parseConnectionUri(props.dbUrl);
		const selection = selectInspectTargets({
			dbUrlDatabase: parsed.database,
			branchDatabases: [],
			scope,
		});
		return {
			targets: [
				{
					database: selection.databases[0],
					connectionUri: props.dbUrl,
				},
			],
			includeDatabaseColumn: selection.includeDatabaseColumn,
		};
	}

	if (props.databaseName !== undefined) {
		const resolved = await resolveConnectionUri(props);
		return {
			targets: [
				{
					database: resolved.database,
					connectionUri: resolved.connectionUri,
				},
			],
			includeDatabaseColumn: false,
		};
	}

	const { branchId, names } = await listBranchDatabases(props);
	if (names.length === 0) {
		throw new Error(`No databases found for the branch: ${branchId}`);
	}
	const selection = selectInspectTargets({
		branchDatabases: names,
		scope,
	});
	const first = await resolveConnectionUri({
		...props,
		databaseName: selection.databases[0],
	});
	return {
		targets: selection.databases.map((database) => ({
			database,
			connectionUri: connectionUriForDatabase(
				first.connectionUri,
				database,
			),
		})),
		includeDatabaseColumn: selection.includeDatabaseColumn,
	};
};

const rowsFrom = (result: {
	fields: { name: string }[];
	rows: unknown[][];
}): Record<string, unknown>[] => {
	const names = result.fields.map((f) => f.name);
	return result.rows.map((row) => {
		const obj: Record<string, unknown> = {};
		names.forEach((name, i) => {
			obj[name] = row[i];
		});
		return obj;
	});
};

export type RunInspectQueryOptions = {
	/**
	 * Extension the query depends on. When set, the runner checks
	 * `pg_extension` first and throws an actionable error if it isn't installed.
	 */
	requiresExtension?: string;
};

/**
 * Connect to `connectionUri` with the embedded wire client, run a single
 * read-only `sql`, and return the rows as objects keyed by column name (so the
 * shared `writer` can render them by field). The connection is always closed,
 * even on error.
 */
export const runInspectQuery = async (
	connectionUri: string,
	sql: string,
	options: RunInspectQueryOptions = {},
): Promise<Record<string, unknown>[]> => {
	const opts = parseConnectionUri(connectionUri);
	let connection: PgConnection;
	try {
		connection = await PgConnection.connect(opts);
	} catch (err) {
		// Give the failure a Postgres-specific message. The raw socket error
		// (e.g. ECONNREFUSED) would otherwise be mislabeled by the top-level
		// `isNetworkError` handler as a "Could not reach the Neon API" hint —
		// misleading for `inspect db`, which talks to Postgres, not the API.
		// We intentionally do not chain `cause` so that classifier can't match
		// the socket `code`; the underlying reason is preserved in the message.
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Could not connect to Postgres at ${opts.host}:${opts.port}: ${reason}`,
		);
	}
	try {
		const ext = options.requiresExtension;
		if (ext) {
			// `ext` is an internal constant from INSPECT_QUERIES, never user input,
			// so interpolating it into the literal is safe.
			const check = await connection.query(
				`SELECT 1 FROM pg_extension WHERE extname = '${ext}';`,
			);
			if (check.rows.length === 0) {
				throw new Error(
					`This query needs the "${ext}" extension, which is not installed. ` +
						`Enable it with: CREATE EXTENSION ${ext};`,
				);
			}
		}
		const result = await connection.query(sql);
		return rowsFrom(result);
	} finally {
		await connection.close();
	}
};
