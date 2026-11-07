import { randomUUID } from "node:crypto";
import { type Branch, type NeonClient, NeonClientError } from "@neon/sdk";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import {
	DATABASE_NAME_DESCRIPTION,
	defaultDatabase,
	refuseInReadOnly,
	SQL_METADATA,
} from "./connection.js";
import { runTransaction, sqlWriteAnnotations } from "./run.js";

/** Splits on every `;`, including one inside a string literal or function body. */
export const splitSqlStatements = (sql: string): string[] =>
	sql.split(";").filter(Boolean);

export const createTemporaryBranch = async (
	neonClient: NeonClient<true>,
	projectId: string,
	name: string | undefined,
	signal?: AbortSignal,
): Promise<Branch> =>
	neonClient.branches.create(
		{
			projectId,
			...(name === undefined ? {} : { name }),
			compute: { minCu: 0.25, maxCu: 0.25 },
		},
		{ signal },
	);

/** Deletes the branch a failed prepare created, then rethrows the original failure. */
export const deleteAfterFailure = async (
	neonClient: NeonClient<true>,
	projectId: string,
	branchId: string,
	error: unknown,
): Promise<never> => {
	try {
		await neonClient.branches.delete({ projectId, branchId });
	} catch {
		// The original failure is the one to report; the branch name marks an orphan.
	}
	throw error;
};

// The `mcp-migration-` prefix is how the Neon MCP server finds orphaned branches.
const migrationBranchName = () =>
	`mcp-migration-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

export const prepareMigrationInputSchema = z.strictObject({
	migration_sql: z
		.string()
		.describe("The SQL to execute to create the migration"),
	project_id: z
		.string()
		.describe("The ID of the project to execute the query against"),
	database_name: z.string().optional().describe(DATABASE_NAME_DESCRIPTION),
});

export const completeMigrationInputSchema = z.strictObject({
	migration_id: z
		.string()
		.describe("The migration ID from migrations.prepare."),
	migration_sql: z
		.string()
		.describe(
			"The SQL statements to apply. Pass the exact value from migrations.prepare.",
		),
	database_name: z
		.string()
		.describe(
			"The database name. Pass the exact value from migrations.prepare.",
		),
	project_id: z
		.string()
		.describe(
			"The project ID. Pass the exact value from migrations.prepare.",
		),
	temporary_branch_id: z
		.string()
		.describe("The temporary branch ID to delete after migration."),
	parent_branch_id: z
		.string()
		.describe("The parent branch ID where migration will be applied."),
	apply_changes: z
		.boolean()
		.default(true)
		.describe(
			"Whether to apply the migration. Set to false to just delete the temp branch without applying.",
		),
});

export const prepareMigrationTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "migrations.prepare",
			id: publishedId("migrations.prepare"),
			title: "Prepare Database Migration",
			description:
				"Apply a schema change on a temporary branch and return a migration_id. Test with sql.run on that branch, ask the user, then call migrations.complete, even if they reject, so the temporary branch is deleted. Pass every field from the prepare response.",
			inputSchema: prepareMigrationInputSchema,
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
			refuseInReadOnly(context, "migrations.prepare");
			const projectId = input.project_id;
			const branch = await createTemporaryBranch(
				neonClient,
				projectId,
				migrationBranchName(),
				signal,
			);
			try {
				const parentBranchId = branch.parent_id;
				if (parentBranchId === undefined) {
					throw new NeonClientError(
						`Temporary branch ${branch.id} has no parent branch`,
					);
				}
				const databaseName =
					input.database_name ??
					(
						await defaultDatabase(
							neonClient,
							{ projectId, branchId: branch.id },
							signal,
						)
					).name;
				const migrationResult = await runTransaction(
					neonClient,
					{
						project_id: projectId,
						branch_id: branch.id,
						database_name: databaseName,
					},
					splitSqlStatements(input.migration_sql),
					context,
					signal,
				);
				return {
					migration_id: randomUUID(),
					migration_sql: input.migration_sql,
					database_name: databaseName,
					project_id: projectId,
					temporary_branch_id: branch.id,
					parent_branch_id: parentBranchId,
					temporary_branch: branch,
					migration_result: migrationResult,
				};
			} catch (error) {
				return deleteAfterFailure(
					neonClient,
					projectId,
					branch.id,
					error,
				);
			}
		},
	);

export const completeMigrationTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "migrations.complete",
			id: publishedId("migrations.complete"),
			title: "Complete Database Migration",
			description:
				"Apply or discard a prepared migration and delete the temporary branch. NEVER run autonomously; always ask the user first. Pass migration_id, migration_sql, database_name, project_id, temporary_branch_id, and parent_branch_id from migrations.prepare. Set apply_changes false to discard; omitting it applies the migration.",
			inputSchema: completeMigrationInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			refuseInReadOnly(context, "migrations.complete");
			const migrationResult = input.apply_changes
				? await runTransaction(
						neonClient,
						{
							project_id: input.project_id,
							branch_id: input.parent_branch_id,
							database_name: input.database_name,
						},
						splitSqlStatements(input.migration_sql),
						context,
						signal,
					)
				: undefined;

			let cleanupError: string | undefined;
			try {
				await neonClient.branches.delete(
					{
						projectId: input.project_id,
						branchId: input.temporary_branch_id,
					},
					{ signal },
				);
			} catch (error) {
				cleanupError =
					error instanceof Error ? error.message : String(error);
			}

			return {
				applied: input.apply_changes,
				...(cleanupError === undefined
					? { deletedBranchId: input.temporary_branch_id }
					: { cleanupError }),
				...(migrationResult === undefined ? {} : { migrationResult }),
			};
		},
	);
