import type { Branch, NeonClient } from "@neon/sdk";
import * as z from "zod";
import { pathInputDescriptions } from "../../../descriptions.gen.js";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import type { NeonToolExecutionContext } from "../../operation.js";
import { consoleBaseUrl, DEFAULT_API_BASE_URL } from "../resources.js";
import {
	databaseNameField,
	projectIdField,
	resolveConnection,
	SQL_METADATA,
	sqlClient,
} from "./connection.js";
import type { Row } from "./rows.js";
import { sqlReadAnnotations } from "./schema.js";

export const describeBranchInputSchema = z.strictObject({
	project_id: projectIdField,
	branch_id: z.string().describe(pathInputDescriptions.branch_id),
	database_name: databaseNameField,
});

// One SELECT over the system catalogs: every database, then the current
// database's schemas and objects as an indented tree. It creates nothing, so it
// needs no CREATE privilege and runs in a READ ONLY transaction.
const DESCRIBE_DATABASE_QUERY = `
WITH RECURSIVE
    schemas AS (
        SELECT
            n.nspname AS object_name,
            1 AS level,
            n.nspname AS path,
            'SCHEMA' AS object_type
        FROM pg_namespace n
        WHERE n.nspname NOT LIKE 'pg_%'
        AND n.nspname != 'information_schema'
    ),

    objects AS (
        SELECT
            c.relname AS object_name,
            2 AS level,
            s.path || ' → ' || c.relname AS path,
            CASE c.relkind
                WHEN 'r' THEN 'TABLE'
                WHEN 'v' THEN 'VIEW'
                WHEN 'm' THEN 'MATERIALIZED VIEW'
                WHEN 'i' THEN 'INDEX'
                WHEN 'S' THEN 'SEQUENCE'
                WHEN 'f' THEN 'FOREIGN TABLE'
            END AS object_type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN schemas s ON n.nspname = s.object_name
        WHERE c.relkind IN ('r','v','m','i','S','f')

        UNION ALL

        SELECT
            p.proname AS object_name,
            2 AS level,
            s.path || ' → ' || p.proname AS path,
            'FUNCTION' AS object_type
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN schemas s ON n.nspname = s.object_name
    ),

    combined AS (
        SELECT * FROM schemas
        UNION ALL
        SELECT * FROM objects
    )

SELECT tree_structure FROM (
    SELECT 0 AS part, NULL::text AS path, ':file_folder: ' || datname || ' (DATABASE)' AS tree_structure
    FROM pg_database
    WHERE datistemplate = false

    UNION ALL

    SELECT 1 AS part, path,
        REPEAT('    ', level) ||
        CASE
            WHEN level = 1 THEN '└── :open_file_folder: '
            ELSE '    └── ' ||
                CASE object_type
                    WHEN 'TABLE' THEN ':bar_chart: '
                    WHEN 'VIEW' THEN ':eye: '
                    WHEN 'MATERIALIZED VIEW' THEN ':newspaper: '
                    WHEN 'FUNCTION' THEN ':zap: '
                    WHEN 'INDEX' THEN ':mag: '
                    WHEN 'SEQUENCE' THEN ':1234: '
                    WHEN 'FOREIGN TABLE' THEN ':globe_with_meridians: '
                    ELSE ''
                END
        END || object_name || ' (' || object_type || ')' AS tree_structure
    FROM combined
) tree
ORDER BY part, path;
`;

export const branchConsoleUrl = (
	consoleUrl: string,
	projectId: string,
	branchId: string,
) =>
	new URL(
		`/app/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
		consoleUrl,
	).toString();

const branchInfo = (branch: Branch, consoleLink: string) => `Branch Details: 
Name: ${branch.name}
ID: ${branch.id}
Parent Branch: ${branch.parent_id}
Default: ${branch.default}
Protected: ${branch.protected ? "Yes" : "No"}

${branch.created_by ? `Created By: ${branch.created_by.name}` : ""}
Created: ${new Date(branch.created_at).toLocaleDateString()}
Updated: ${new Date(branch.updated_at).toLocaleDateString()}

Compute Usage: ${branch.compute_time_seconds} seconds
Written Data: ${branch.written_data_bytes} bytes
Data Transfer: ${branch.data_transfer_bytes} bytes

Console Link: ${consoleLink}
`;

export interface BranchDescription {
	branch: Branch;
	console_url: string;
	/** The branch details and database tree as text. */
	text: string;
	/**
	 * `[[], treeRows]`, or null when the tree query failed. The leading empty array
	 * keeps the shape the Neon MCP server's `describe_branch` returns.
	 */
	database_structure: Row[][] | null;
	database_structure_error?: string;
}

export const describeBranch = async (
	neonClient: NeonClient<true>,
	input: { project_id: string; branch_id: string; database_name?: string },
	context: NeonToolExecutionContext,
	consoleUrl: string,
	signal?: AbortSignal,
): Promise<BranchDescription> => {
	const branch = await neonClient.branches.get(
		{ projectId: input.project_id, branchId: input.branch_id },
		{ signal },
	);
	const url = branchConsoleUrl(consoleUrl, branch.project_id, branch.id);
	const info = branchInfo(branch, url);
	try {
		const connection = await resolveConnection(
			neonClient,
			{
				project_id: input.project_id,
				branch_id: branch.id,
				database_name: input.database_name,
			},
			context,
			signal,
		);
		const sql = sqlClient(connection.uri, signal);
		const [tree] = await sql.transaction(
			[sql.query(DESCRIBE_DATABASE_QUERY)],
			{ readOnly: true },
		);
		const structure: Row[][] = [[], tree];
		return {
			branch,
			console_url: url,
			text: `${info}\nDatabase Structure:\n${JSON.stringify(structure, null, 2)}`,
			database_structure: structure,
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		const message =
			context.postgresRole === undefined
				? `Database structure unavailable: ${reason}`
				: `Database structure unavailable as Postgres role "${context.postgresRole}": ${reason}`;
		return {
			branch,
			console_url: url,
			text: `${info}\n${message}`,
			database_structure: null,
			database_structure_error: message,
		};
	}
};

export const describeBranchTool = (options: ToolClientOptions) => {
	const consoleUrl = consoleBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
	return bindTool(
		options,
		{
			operationId: "branches.describe",
			id: publishedId("branches.describe"),
			title: "Describe Branch",
			description:
				"Returns a branch summary, its database names, and a tree of one database's schemas, tables, views, indexes, sequences, and functions. Starts a suspended compute. Branch record only: {{branches.get}}; table names: {{schema.listTables}}; columns: {{schema.describeTable}}.",
			inputSchema: describeBranchInputSchema,
			annotations: sqlReadAnnotations,
			requiresApproval: false,
			metadata: SQL_METADATA,
		},
		(neonClient, input, signal, context) =>
			describeBranch(neonClient, input, context, consoleUrl, signal),
	);
};
