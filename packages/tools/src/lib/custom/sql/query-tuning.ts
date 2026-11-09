import { randomUUID } from "node:crypto";
import { NeonClientError } from "@neon/sdk";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import {
	refuseInReadOnly,
	resolveConnection,
	SQL_METADATA,
} from "./connection.js";
import { withTemporaryBranch } from "./migrations.js";
import { extractExecutionMetrics, extractTableNamesFromPlan } from "./plan.js";
import {
	explainStatement,
	runTransaction,
	sqlWriteAnnotations,
} from "./run.js";
import { describeTableAt } from "./schema.js";

export const prepareQueryTuningInputSchema = z.strictObject({
	sql: z.string().describe("The SQL statement to analyze and tune"),
	database_name: z
		.string()
		.describe("The name of the database to execute the query against"),
	project_id: z
		.string()
		.describe("The ID of the project to execute the query against"),
	role_name: z
		.string()
		.optional()
		.describe(
			'The name of the role to connect with. If not provided, the default role (usually "neondb_owner") will be used.',
		),
});

export const completeQueryTuningInputSchema = z.strictObject({
	suggested_sql_statements: z
		.array(z.string())
		.describe(
			"The SQL DDL statements to execute to improve performance. These statements are the result of the prior steps, for example creating additional indexes.",
		),
	apply_changes: z
		.boolean()
		.default(false)
		.describe("Whether to apply the suggested changes to the main branch"),
	tuning_id: z
		.string()
		.describe(
			"The ID of the tuning to complete. This is NOT the branch ID. Remember this ID from the prior step using queryTuning.prepare.",
		),
	database_name: z
		.string()
		.describe("The name of the database to execute the query against"),
	project_id: z
		.string()
		.describe("The ID of the project to execute the query against"),
	role_name: z
		.string()
		.optional()
		.describe(
			'The name of the role to connect with. If you have used a specific role in queryTuning.prepare you MUST pass the same role again to this tool. If not provided, the default role (usually "neondb_owner") will be used.',
		),
	should_delete_temporary_branch: z
		.boolean()
		.default(true)
		.describe("Whether to delete the temporary branch after tuning"),
	temporary_branch_id: z
		.string()
		.describe(
			"The ID of the temporary branch that needs to be deleted after tuning.",
		),
	branch_id: z
		.string()
		.optional()
		.describe(
			"The ID or name of the branch that receives the changes. If not provided, the default (main) branch will be used.",
		),
});

export const prepareQueryTuningTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "queryTuning.prepare",
			id: publishedId("queryTuning.prepare"),
			title: "Prepare Query Tuning",
			description:
				"Analyze a slow query on a temporary branch and return a tuning_id. Apply suggested SQL with sql.run on that branch, re-run sql.explain there, then queryTuning.complete with the response's `complete` object (tuning_id is not the branch id): apply_changes true if they accept, omit it or pass false if they reject, so the temporary branch is deleted. Do not use migrations.prepare.",
			inputSchema: prepareQueryTuningInputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			refuseInReadOnly(context, "queryTuning.prepare");
			const projectId = input.project_id;
			return withTemporaryBranch(
				neonClient,
				projectId,
				undefined,
				signal,
				async (branch) => {
					const target = {
						project_id: projectId,
						branch_id: branch.id,
						database_name: input.database_name,
						role_name: input.role_name,
					};
					const executionPlan = await explainStatement(
						neonClient,
						{ ...target, sql: input.sql, analyze: true },
						context,
						signal,
					);
					const tableNames = extractTableNamesFromPlan(executionPlan);
					if (tableNames.length === 0) {
						throw new NeonClientError(
							"No tables found in execution plan. Cannot proceed with optimization.",
						);
					}
					const connection = await resolveConnection(
						neonClient,
						target,
						context,
						signal,
					);
					const tableSchemas = await Promise.all(
						tableNames.map(async (tableName) => {
							try {
								const schema = await describeTableAt(
									connection.uri,
									tableName,
									signal,
								);
								return {
									tableName,
									schema: schema.raw,
									formatted: schema.formatted,
								};
							} catch (error) {
								throw new Error(
									`Failed to get schema for table ${tableName}: ${error instanceof Error ? error.message : String(error)}`,
									{ cause: error },
								);
							}
						}),
					);
					const ids = {
						tuning_id: randomUUID(),
						database_name: input.database_name,
						project_id: projectId,
						temporary_branch_id: branch.id,
					};
					return {
						// Two shapes rather than an optional key, so the published type has no `role_name: null`.
						complete:
							input.role_name === undefined
								? ids
								: { ...ids, role_name: input.role_name },
						execution_plan: executionPlan,
						table_schemas: tableSchemas,
						sql: input.sql,
						baseline_metrics:
							extractExecutionMetrics(executionPlan),
					};
				},
			);
		},
	);

export const completeQueryTuningTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "queryTuning.complete",
			id: publishedId("queryTuning.complete"),
			title: "Complete Query Tuning",
			description:
				"Apply or discard query-tuning changes and delete the temporary branch. NEVER run autonomously. Before calling, apply suggested SQL with sql.run on the temporary branch and re-run sql.explain. Pass the `complete` object from queryTuning.prepare (its tuning_id is not the branch id) plus suggested_sql_statements. Set apply_changes true to apply; omitting it discards. Call this even when the user rejects the changes. Do not use migrations.prepare.",
			inputSchema: completeQueryTuningInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			refuseInReadOnly(context, "queryTuning.complete");
			const operationLog: string[] = [];
			let results: Awaited<ReturnType<typeof runTransaction>> | undefined;
			if (
				input.apply_changes &&
				input.suggested_sql_statements.length > 0
			) {
				operationLog.push("Applying optimizations to main branch...");
				results = await runTransaction(
					neonClient,
					{
						project_id: input.project_id,
						branch_id: input.branch_id,
						database_name: input.database_name,
						role_name: input.role_name,
					},
					input.suggested_sql_statements,
					context,
					signal,
				);
				operationLog.push(
					"Successfully applied optimizations to main branch.",
				);
			} else {
				operationLog.push(
					"No changes were applied (either none suggested or changes were discarded).",
				);
			}

			if (input.should_delete_temporary_branch) {
				operationLog.push("Cleaning up temporary branch...");
				await neonClient.branches.delete(
					{
						projectId: input.project_id,
						branchId: input.temporary_branch_id,
					},
					{ signal },
				);
				operationLog.push("Successfully cleaned up temporary branch.");
			}

			return {
				...(input.apply_changes && {
					appliedChanges: input.suggested_sql_statements,
				}),
				...(results === undefined ? {} : { results }),
				...(input.should_delete_temporary_branch && {
					deletedBranches: [input.temporary_branch_id],
				}),
				message: operationLog.join("\n"),
			};
		},
	);
