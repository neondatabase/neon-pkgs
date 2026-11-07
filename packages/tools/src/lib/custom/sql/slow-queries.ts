import { NeonClientError } from "@neon/sdk";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import {
	computeIdField,
	databaseNameField,
	resolveConnection,
	SQL_METADATA,
	sqlClient,
} from "./connection.js";

export const listSlowQueriesInputSchema = z.strictObject({
	project_id: z
		.string()
		.describe("The ID of the project to list slow queries from"),
	branch_id: z
		.string()
		.optional()
		.describe(
			"An optional ID of the branch. If not provided the default branch is used.",
		),
	database_name: databaseNameField,
	compute_id: computeIdField,
	limit: z
		.number()
		.default(10)
		.describe("Maximum number of slow queries to return"),
	min_execution_time: z
		.number()
		.default(1000)
		.describe(
			"Minimum execution time in milliseconds to consider a query as slow",
		),
});

const EXTENSION_CHECK_SQL = `
	SELECT EXISTS (
		SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
	) as extension_exists;
`;

const SLOW_QUERIES_SQL = `
	SELECT
		query,
		calls,
		total_exec_time,
		mean_exec_time,
		rows,
		shared_blks_hit,
		shared_blks_read,
		shared_blks_written,
		shared_blks_dirtied,
		temp_blks_read,
		temp_blks_written,
		wal_records,
		wal_fpi,
		wal_bytes
	FROM pg_stat_statements
	WHERE query NOT LIKE '%pg_stat_statements%'
	AND query NOT LIKE '%EXPLAIN%'
	ORDER BY mean_exec_time DESC
	LIMIT $1;
`;

export const listSlowQueriesTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "queries.listSlow",
			id: publishedId("queries.listSlow"),
			title: "List Slow Queries",
			description:
				"List queries from pg_stat_statements by execution time, slowest first. For sizes, indexes, locks, cache, bloat, or replication use database.inspect.",
			inputSchema: listSlowQueriesInputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			const connection = await resolveConnection(
				neonClient,
				input,
				context,
				signal,
			);
			const sql = sqlClient(connection.uri, signal);
			const [extension] = await sql.query(EXTENSION_CHECK_SQL);
			if (extension?.extension_exists !== true) {
				throw new NeonClientError(
					"pg_stat_statements extension is not installed on the database. Please install it using the following command: CREATE EXTENSION pg_stat_statements;",
				);
			}
			const slowQueries = await sql.query(SLOW_QUERIES_SQL, [
				input.limit,
			]);
			const formatted = slowQueries.map((query) => ({
				query: query.query,
				calls: query.calls,
				total_exec_time_ms: query.total_exec_time,
				mean_exec_time_ms: query.mean_exec_time,
				rows: query.rows,
				shared_blocks: {
					hit: query.shared_blks_hit,
					read: query.shared_blks_read,
					written: query.shared_blks_written,
					dirtied: query.shared_blks_dirtied,
				},
				temp_blocks: {
					read: query.temp_blks_read,
					written: query.temp_blks_written,
				},
				wal: {
					records: query.wal_records,
					full_page_images: query.wal_fpi,
					bytes: query.wal_bytes,
				},
			}));
			return {
				slow_queries: formatted,
				total_queries_found: formatted.length,
			};
		},
	);
