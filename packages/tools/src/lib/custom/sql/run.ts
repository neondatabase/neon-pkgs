import type { NeonClient } from "@neon/sdk";
import { types } from "@neondatabase/serverless";
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
	computeIdField,
	databaseNameField,
	projectIdField,
	resolveConnection,
	roleNameField,
	sqlClient,
	sqlMetadata,
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

const maxRowsField = z
	.number()
	.int()
	.min(1)
	.max(SQL_MAX_ROWS_LIMIT)
	.default(SQL_DEFAULT_MAX_ROWS)
	.describe(
		"Rows to return per statement. Raise it only when a result has truncated: true.",
	);

export const runSqlInputSchema = z.strictObject({
	sql: z.string().describe("The SQL statement to run."),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
	role_name: roleNameField,
	compute_id: computeIdField,
	max_rows: maxRowsField,
});

export const runSqlTransactionInputSchema = z.strictObject({
	sql_statements: z
		.array(z.string())
		.describe("The SQL statements to run, in order."),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
	role_name: roleNameField,
	compute_id: computeIdField,
	max_rows: maxRowsField,
});

export const explainSqlInputSchema = z.strictObject({
	sql: z.string().describe("The SQL statement to explain."),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
	analyze: z
		.boolean()
		.default(false)
		.describe(
			"Run EXPLAIN ANALYZE, which executes the statement and its side effects.",
		),
});

/** One caller statement, in its own `READ ONLY` transaction when `readOnly` is set. */
const DATE_TIME_OIDS: ReadonlySet<number> = new Set([
	types.builtins.DATE,
	types.builtins.TIMESTAMP,
	types.builtins.TIMESTAMPTZ,
]);

// The driver parses `infinity` to a number that JSON renders as null, and a
// year past 275760 to an Invalid Date that throws in toISOString. Postgres's
// own text is the only faithful value for either.
const keepTextUnlessDate =
	(parse: (text: string) => unknown) =>
	(text: string): unknown => {
		const value = parse(text);
		return value instanceof Date && !Number.isNaN(value.getTime())
			? value
			: text;
	};

// The driver reads `types` from each query's options, never from neon()'s.
const callerResults = {
	types: {
		...types,
		getTypeParser: (oid: number, format?: "text" | "binary") => {
			const parse = types.getTypeParser(oid, format);
			return DATE_TIME_OIDS.has(oid) && format !== "binary"
				? keepTextUnlessDate(parse)
				: parse;
		},
	},
} satisfies { types: typeof types };

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
		const [rows] = await query.transaction(
			[query.query(sql, [], callerResults)],
			{ readOnly: true },
		);
		return rows;
	}
	return query.query(sql, [], callerResults);
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
		statements.map((statement) =>
			query.query(statement, [], callerResults),
		),
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

export const sqlRowsOutputSchema = z.array(z.record(z.string(), z.unknown()));

const sqlResultOutputSchema = z.looseObject({
	rows: sqlRowsOutputSchema.describe("Result rows, keyed by column name."),
	totalRowCount: z.number().describe("Rows the statement returned."),
	truncated: z
		.boolean()
		.describe("Whether rows holds fewer than totalRowCount."),
	note: z.string().nullish(),
});

export const runSqlTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "sql.run",
			id: publishedId("sql.run"),
			title: "Run SQL",
			description:
				"Runs one SQL statement on a branch's database and returns its rows. For several statements, send one per call or use {{sql.runTransaction}}. After a prepare step, pass its temporary branch_id. NEVER run destructive SQL autonomously: run it only when the user's own message asks for it and unambiguously identifies its target; otherwise ask first.",
			inputSchema: runSqlInputSchema,
			outputSchema: sqlResultOutputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: sqlMetadata(true),
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
				"Runs several SQL statements in one transaction and returns each one's rows. After a prepare step, pass its temporary branch_id. NEVER run destructive SQL autonomously: run it only when the user's own message asks for it and unambiguously identifies its target; otherwise ask first.",
			inputSchema: runSqlTransactionInputSchema,
			outputSchema: z.array(sqlResultOutputSchema),
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: sqlMetadata(false),
		},
		async (neonClient, input, signal, context) => {
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
				"Returns a statement's execution plan as JSON. analyze true executes it, side effects included, so never analyze potentially destructive SQL autonomously. For rows, use {{sql.run}}.",
			inputSchema: explainSqlInputSchema,
			outputSchema: sqlRowsOutputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: sqlMetadata(true),
		},
		(neonClient, input, signal, context) =>
			explainStatement(neonClient, input, context, signal),
	);
