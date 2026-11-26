import type { NeonClient } from "@neon/sdk";
import { neon, types } from "@neondatabase/serverless";
import * as z from "zod";
import { pathInputDescriptions } from "../../../descriptions.gen.js";
import { NeonToolCallerError } from "../../caller-error.js";
import type {
	NeonToolExecutionContext,
	NeonToolMetadataInput,
} from "../../operation.js";

export const NEON_DEFAULT_DATABASE_NAME = "neondb";

/**
 * `readOnlySafe` for a tool that runs caller SQL means it runs one statement
 * in its own `READ ONLY` transaction when `readOnly` is set.
 */
export const sqlMetadata = (readOnlySafe: boolean): NeonToolMetadataInput => ({
	method: "SQL",
	path: "/projects/{project_id}/connection_uri",
	stability: "stable",
	deprecated: false,
	tags: ["SQL"],
	readOnlySafe,
});

export const DATABASE_NAME_DESCRIPTION = `Database name. Omit for ${NEON_DEFAULT_DATABASE_NAME}, else the first database.`;

export const projectIdField = z
	.string()
	.describe(pathInputDescriptions.project_id);

export const branchIdField = z
	.string()
	.optional()
	.describe(
		`${pathInputDescriptions.branch_id} Omit it for the default branch.`,
	);

export const databaseNameField = z
	.string()
	.optional()
	.describe(DATABASE_NAME_DESCRIPTION);

export const roleNameField = z
	.string()
	.optional()
	.describe("Postgres role to log in as. Omit for the database owner.");

export const COMPUTE_ID_DESCRIPTION =
	"Compute endpoint id (ep-...). Omit for the read-write compute.";

export const computeIdField = z
	.string()
	.optional()
	.describe(COMPUTE_ID_DESCRIPTION);

export interface ConnectionTarget {
	project_id: string;
	branch_id?: string;
	database_name?: string;
	role_name?: string;
	compute_id?: string;
	/** Defaults to `true`, as in `@neon/sdk`. */
	pooled?: boolean;
}

export interface ResolvedConnection {
	uri: string;
	projectId: string;
	/**
	 * Absent when the database and role were given without a branch: the
	 * connection URI API then picks the default branch.
	 */
	branchId?: string;
	databaseName: string;
	roleName: string;
	computeId?: string;
}

/** `neondb` when the branch has it, otherwise the first database. */
export const defaultDatabase = async (
	neonClient: NeonClient<true>,
	ids: { projectId: string; branchId: string },
	signal?: AbortSignal,
) => {
	const databases = await neonClient.postgres.databases.list(ids, {
		signal,
	});
	const first = databases[0];
	if (first === undefined) {
		throw new NeonToolCallerError(
			"No databases found in your project branch",
		);
	}
	return (
		databases.find(
			(database) => database.name === NEON_DEFAULT_DATABASE_NAME,
		) ?? first
	);
};

/**
 * Resolves the connection every SQL tool uses, and the URI `postgres.connectionString`
 * returns. The URI embeds a role password, so the SQL tools keep it inside the tool.
 */
export const resolveConnection = async (
	neonClient: NeonClient<true>,
	target: ConnectionTarget,
	context: NeonToolExecutionContext,
	signal?: AbortSignal,
): Promise<ResolvedConnection> => {
	const projectId = target.project_id;
	let roleName = target.role_name;
	const pinnedRole = context.postgresRole;
	if (pinnedRole !== undefined) {
		if (roleName !== undefined && roleName !== pinnedRole) {
			throw new NeonToolCallerError(
				`This connection is pinned to Postgres role "${pinnedRole}"; role_name "${roleName}" is not allowed.`,
			);
		}
		roleName = pinnedRole;
	}

	let branchId = target.branch_id;
	let databaseName = target.database_name;
	if (databaseName === undefined || roleName === undefined) {
		branchId ??= (
			await neonClient.branches.getDefault({ projectId }, { signal })
		).id;
		if (databaseName === undefined) {
			const database = await defaultDatabase(
				neonClient,
				{ projectId, branchId },
				signal,
			);
			databaseName = database.name;
			roleName ??= database.owner_name;
		} else {
			const database = await neonClient.postgres.databases.get(
				{ projectId, branchId, databaseName },
				{ signal },
			);
			roleName = database.owner_name;
		}
	}

	const uri = await neonClient.postgres.connectionString(
		{
			projectId,
			...(branchId === undefined ? {} : { branchId }),
			databaseName,
			roleName,
			...(target.compute_id === undefined
				? {}
				: { endpointId: target.compute_id }),
			...(target.pooled === undefined ? {} : { pooled: target.pooled }),
		},
		{ signal },
	);
	return {
		uri,
		projectId,
		...(branchId === undefined ? {} : { branchId }),
		databaseName,
		roleName,
		...(target.compute_id === undefined
			? {}
			: { computeId: target.compute_id }),
	};
};

const TEXT_ARRAY_OID: number = 1009;

/** Postgres date/time types the driver parses into a Date, each with its array type. */
const DATE_TIME_ARRAY_OIDS = new Map([
	[types.builtins.DATE, 1182],
	[types.builtins.TIMESTAMP, 1115],
	[types.builtins.TIMESTAMPTZ, 1185],
]);

/**
 * Postgres dates reach year 5874897, timestamps 294276, and both accept `infinity`; a
 * JavaScript Date stops at 275760. The driver turns those values into an Invalid Date,
 * which cannot be serialized, or `Infinity`, which JSON turns into null, so they keep the
 * text Postgres sent.
 */
const parseDateTime =
	(oid: number) =>
	(text: string): unknown => {
		const value = types.getTypeParser(oid)(text);
		return value instanceof Date && !Number.isNaN(value.getTime())
			? value
			: text;
	};

const mapArrayElements = (
	value: unknown,
	parse: (text: string) => unknown,
): unknown => {
	if (Array.isArray(value)) {
		return value.map((element) => mapArrayElements(element, parse));
	}
	return typeof value === "string" ? parse(value) : value;
};

const dateTimeParsers = new Map<number, (text: string) => unknown>();
for (const [oid, arrayOid] of DATE_TIME_ARRAY_OIDS) {
	const parse = parseDateTime(oid);
	dateTimeParsers.set(oid, parse);
	dateTimeParsers.set(arrayOid, (text) =>
		mapArrayElements(types.getTypeParser(TEXT_ARRAY_OID)(text), parse),
	);
}

export const sqlTypes: typeof types = {
	...types,
	getTypeParser: (oid, format) =>
		dateTimeParsers.get(oid) ?? types.getTypeParser(oid, format),
};

/**
 * `neon()` ignores a `types` option and reads it only per query, so `query` adds the
 * parsers to each call. A tagged-template call (sql`...`) does not get them.
 */
export const sqlClient = (uri: string, signal?: AbortSignal) => {
	const sql = neon(
		uri,
		signal === undefined ? {} : { fetchOptions: { signal } },
	);
	const query = sql.query;
	sql.query = (text, params, options) =>
		query(text, params, { types: sqlTypes, ...options });
	return sql;
};
