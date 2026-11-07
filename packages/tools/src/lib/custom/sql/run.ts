import type { NeonClient } from "@neon/sdk";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import type {
	NeonToolAnnotations,
	NeonToolExecutionContext,
} from "../../operation.js";
import {
	branchIdField,
	type ConnectionTarget,
	databaseNameField,
	projectIdField,
	refuseInReadOnly,
	resolveConnection,
	roleNameField,
	SQL_METADATA,
	sqlClient,
} from "./connection.js";
import {
	capRows,
	type Row,
	SQL_DEFAULT_MAX_ROWS,
	SQL_MAX_ROWS_LIMIT,
} from "./rows.js";

export const sqlWriteAnnotations: NeonToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
};

const sqlComputeIdField = z
	.string()
	.optional()
	.describe(
		"An optional ID of the compute/endpoint to run on. If not provided, the read-write compute of the branch is used.",
	);

const maxRowsField = z
	.number()
	.int()
	.min(1)
	.max(SQL_MAX_ROWS_LIMIT)
	.default(SQL_DEFAULT_MAX_ROWS)
	.describe(
		"Maximum number of rows to return per statement. When a statement returns more, its result has `truncated: true` and `totalRowCount`; raise this only then.",
	);

export const runSqlInputSchema = z.strictObject({
	sql: z.string().describe("The SQL query to execute"),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
	role_name: roleNameField,
	compute_id: sqlComputeIdField,
	max_rows: maxRowsField,
});

export const runSqlTransactionInputSchema = z.strictObject({
	sql_statements: z
		.array(z.string())
		.describe("The SQL statements to execute"),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
	role_name: roleNameField,
	compute_id: sqlComputeIdField,
	max_rows: maxRowsField,
});

export const explainSqlInputSchema = z.strictObject({
	sql: z.string().describe("The SQL statement to analyze"),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
	analyze: z
		.boolean()
		.default(false)
		.describe(
			"Whether to execute the statement with EXPLAIN ANALYZE. Defaults to false because execution may cause side effects.",
		),
});

/** One caller statement, in its own `READ ONLY` transaction when `readOnly` is set. */
export const runStatement = async (
	neonClient: NeonClient<true>,
	target: ConnectionTarget,
	sql: string,
	context: NeonToolExecutionContext,
	signal?: AbortSignal,
): Promise<Row[]> => {
	const connection = await resolveConnection(
		neonClient,
		target,
		context,
		signal,
	);
	const query = sqlClient(connection.uri, signal);
	if (context.readOnly === true) {
		const [rows] = await query.transaction([query.query(sql)], {
			readOnly: true,
		});
		return rows;
	}
	return query.query(sql);
};

export const runTransaction = async (
	neonClient: NeonClient<true>,
	target: ConnectionTarget,
	statements: readonly string[],
	context: NeonToolExecutionContext,
	signal?: AbortSignal,
): Promise<Row[][]> => {
	const connection = await resolveConnection(
		neonClient,
		target,
		context,
		signal,
	);
	const query = sqlClient(connection.uri, signal);
	return query.transaction(
		statements.map((statement) => query.query(statement)),
	);
};

export const explainStatement = (
	neonClient: NeonClient<true>,
	input: {
		sql: string;
		analyze: boolean;
	} & ConnectionTarget,
	context: NeonToolExecutionContext,
	signal?: AbortSignal,
): Promise<Row[]> => {
	const prefix = input.analyze
		? "EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FILECACHE, FORMAT JSON)"
		: "EXPLAIN (VERBOSE, FORMAT JSON)";
	return runStatement(
		neonClient,
		input,
		`${prefix} ${input.sql}`,
		context,
		signal,
	);
};

export const runSqlTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "sql.run",
			id: publishedId("sql.run"),
			title: "Run SQL",
			description:
				"Execute one SQL statement on a Neon database. If a prior step created a temporary branch, pass that branch_id. NEVER run destructive SQL autonomously; always ask the user first.",
			inputSchema: runSqlInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) =>
			capRows(
				await runStatement(
					neonClient,
					input,
					input.sql,
					context,
					signal,
				),
				input.max_rows,
			),
	);

export const runSqlTransactionTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "sql.runTransaction",
			id: publishedId("sql.runTransaction"),
			title: "Run SQL Transaction",
			description:
				"Execute multiple SQL statements as one transaction. If a prior step created a temporary branch, pass that branch_id. NEVER run destructive SQL autonomously; always ask the user first.",
			inputSchema: runSqlTransactionInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			refuseInReadOnly(context, "sql.runTransaction");
			const results = await runTransaction(
				neonClient,
				input,
				input.sql_statements,
				context,
				signal,
			);
			return results.map((rows) => capRows(rows, input.max_rows));
		},
	);

export const explainSqlTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "sql.explain",
			id: publishedId("sql.explain"),
			title: "Explain SQL Statement",
			description:
				"Generate the execution plan for a SQL statement. When `analyze` is true, PostgreSQL executes the statement and any side effects. Use `analyze: false` to inspect a statement without executing it. Never analyze potentially destructive SQL autonomously. Do not use when you need query results (use `sql.run` instead).",
			inputSchema: explainSqlInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		(neonClient, input, signal, context) =>
			explainStatement(neonClient, input, context, signal),
	);
