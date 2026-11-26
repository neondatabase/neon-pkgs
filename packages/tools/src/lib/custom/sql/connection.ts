import { describeTransportFailure, type NeonClient } from "@neon/sdk";
import {
	NeonDbError,
	type NeonQueryFunction,
	NeonQueryPromise,
	neon,
} from "@neondatabase/serverless";
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

/** The request to the SQL endpoint got no response, so Postgres never answered. */
export const isSqlTransportFailure = (error: NeonDbError): boolean =>
	error.sourceError !== undefined;

// The driver's message stops at `fetch failed`; the reason is on its cause.
const withTransportReason = (error: unknown, signal?: AbortSignal) => {
	if (
		!(error instanceof NeonDbError) ||
		!isSqlTransportFailure(error) ||
		signal?.aborted
	) {
		return error;
	}
	const reason = describeTransportFailure(error.sourceError);
	const described = new NeonDbError(
		`Network error: no response received from the database's SQL endpoint (${reason}). A statement that changes data may have run anyway, so check before you retry it.`,
	);
	described.sourceError = error.sourceError;
	described.cause = error.sourceError;
	return described;
};

type SqlClient = Pick<NeonQueryFunction<false, false>, "query" | "transaction">;

export const sqlClient = (uri: string, signal?: AbortSignal): SqlClient => {
	const sql = neon(
		uri,
		signal === undefined ? {} : { fetchOptions: { signal } },
	);
	const reportTransport = <T>(pending: Promise<T>) =>
		pending.catch((error: unknown) => {
			throw withTransportReason(error, signal);
		});
	return {
		query: (text, params, options) => {
			const pending = sql.query(text, params, options);
			return new NeonQueryPromise(
				(data, opts) => reportTransport(pending.execute(data, opts)),
				pending.queryData,
				pending.opts,
			);
		},
		transaction: (queries, options) =>
			reportTransport(sql.transaction(queries, options)),
	};
};
