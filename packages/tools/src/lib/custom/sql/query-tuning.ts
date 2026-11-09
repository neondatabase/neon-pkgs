import { randomUUID } from "node:crypto";
import { NeonClientError } from "@neon/sdk";
import * as z from "zod";
import { pathInputDescriptions } from "../../../descriptions.gen.js";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import {
	projectIdField,
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
	sql: z.string().describe("The slow SQL statement to analyze."),
	database_name: z.string().describe("The database the statement runs in."),
	project_id: projectIdField,
	role_name: z
		.string()
		.optional()
		.describe("Postgres role to connect as. Omit for the database owner."),
});

export const completeQueryTuningInputSchema = z.strictObject({
	suggested_sql_statements: z
		.array(z.string())
		.describe(
			"The DDL statements that improved the plan on the temporary branch, for example CREATE INDEX.",
		),
	apply_changes: z
		.boolean()
		.default(false)
		.describe("Apply suggested_sql_statements to branch_id."),
	tuning_id: z
		.string()
		.describe(
			"The tuning_id from {{queryTuning.prepare}}, not a branch id.",
		),
	database_name: z
		.string()
		.describe("The database_name from {{queryTuning.prepare}}."),
	project_id: projectIdField,
	role_name: z
		.string()
		.optional()
		.describe(
			"The role_name passed to {{queryTuning.prepare}}, if any. Omit for the database owner.",
		),
	should_delete_temporary_branch: z
		.boolean()
		.default(true)
		.describe("Delete the temporary branch."),
	temporary_branch_id: z
		.string()
		.describe("The temporary_branch_id from {{queryTuning.prepare}}."),
	branch_id: z
		.string()
		.optional()
		.describe(
			`${pathInputDescriptions.branch_id} The branch that receives the changes; omit it for the default branch.`,
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
				"Runs EXPLAIN ANALYZE for a slow query on a new temporary branch; returns the plan, table schemas, and a tuning_id. Try changes there with {{sql.run}} and {{sql.explain}}, then always call {{queryTuning.complete}} with the complete object so the branch is deleted. Not {{migrations.prepare}}.",
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
			refuseInReadOnly(context);
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
				"Applies or discards query-tuning changes and deletes the temporary branch. NEVER run autonomously. Pass the complete object from {{queryTuning.prepare}} and suggested_sql_statements; apply_changes true applies, omitted discards. Call it even when the user rejects.",
			inputSchema: completeQueryTuningInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			refuseInReadOnly(context);
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
