import { type NeonClient, NeonClientError } from "@neon/sdk";
import { neon } from "@neondatabase/serverless";
import * as z from "zod";
import type {
	NeonToolExecutionContext,
	NeonToolMetadata,
} from "../../operation.js";

export const NEON_DEFAULT_DATABASE_NAME = "neondb";

export const SQL_METADATA: NeonToolMetadata = {
	method: "SQL",
	path: "/projects/{project_id}/connection_uri",
	stability: "stable",
	deprecated: false,
	tags: ["SQL"],
};

export const DATABASE_NAME_DESCRIPTION = `The name of the database. If not provided, the default ${NEON_DEFAULT_DATABASE_NAME} or first available database is used.`;

export const projectIdField = z
	.string()
	.describe("The ID of the project to execute the query against");

export const branchIdField = z
	.string()
	.optional()
	.describe(
		"An optional ID of the branch to execute the query against. If not provided the default branch is used.",
	);

export const databaseNameField = z
	.string()
	.optional()
	.describe(DATABASE_NAME_DESCRIPTION);

export const roleNameField = z
	.string()
	.optional()
	.describe(
		"An optional Postgres role to log in as. The server resolves its credentials internally and never returns them. If not provided, the database owner is used. On a connection pinned to a role, omit this or pass that role.",
	);

export const computeIdField = z
	.string()
	.optional()
	.describe(
		"The ID of the compute/endpoint. If not provided, the read-write compute associated with the branch will be used.",
	);

export interface ConnectionTarget {
	project_id: string;
	branch_id?: string;
	database_name?: string;
	role_name?: string;
	compute_id?: string;
}

export interface ResolvedConnection {
	uri: string;
	projectId: string;
	branchId: string;
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
		throw new NeonClientError("No databases found in your project branch");
	}
	return (
		databases.find(
			(database) => database.name === NEON_DEFAULT_DATABASE_NAME,
		) ?? first
	);
};

/**
 * Resolves the connection every SQL tool uses. The URI embeds a role password,
 * so it stays inside the tool and never reaches a result.
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
			throw new NeonClientError(
				`This connection is pinned to Postgres role "${pinnedRole}"; role_name "${roleName}" is not allowed.`,
			);
		}
		roleName = pinnedRole;
	}

	const branchId =
		target.branch_id ??
		(await neonClient.branches.getDefault({ projectId }, { signal })).id;

	let databaseName = target.database_name;
	if (databaseName === undefined) {
		const database = await defaultDatabase(
			neonClient,
			{ projectId, branchId },
			signal,
		);
		databaseName = database.name;
		roleName ??= database.owner_name;
	} else if (roleName === undefined) {
		const database = await neonClient.postgres.databases.get(
			{ projectId, branchId, databaseName },
			{ signal },
		);
		roleName = database.owner_name;
	}

	const uri = await neonClient.postgres.connectionString(
		{
			projectId,
			branchId,
			databaseName,
			roleName,
			...(target.compute_id === undefined
				? {}
				: { endpointId: target.compute_id }),
		},
		{ signal },
	);
	return {
		uri,
		projectId,
		branchId,
		databaseName,
		roleName,
		...(target.compute_id === undefined
			? {}
			: { computeId: target.compute_id }),
	};
};

export const sqlClient = (uri: string, signal?: AbortSignal) =>
	neon(uri, signal === undefined ? {} : { fetchOptions: { signal } });

/**
 * Caller SQL that shares one transaction can escape `READ ONLY` with `COMMIT`
 * or `SET TRANSACTION READ WRITE`, so these tools refuse instead.
 */
export const refuseInReadOnly = (
	context: NeonToolExecutionContext,
	selector: string,
) => {
	if (context.readOnly === true) {
		throw new NeonClientError(
			`${selector} is unavailable in read-only mode because it runs caller SQL that can leave a read-only transaction.`,
		);
	}
};
