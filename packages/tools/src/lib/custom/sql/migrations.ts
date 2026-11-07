import { randomUUID } from "node:crypto";
import { type Branch, type NeonClient, NeonClientError } from "@neon/sdk";
import { createProjectBranch, type Operation } from "@neon/sdk/raw";
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

// Cleanup outlives the caller's wait budget and signal: a branch still provisioning
// cannot be deleted, and leaving it behind is the failure this guards against.
const CLEANUP_WAIT_MS = 60_000;

const discardTemporaryBranch = async (
	neonClient: NeonClient<true>,
	projectId: string,
	branchId: string,
	operations: readonly Operation[],
) => {
	try {
		await neonClient.operations.waitFor(
			{ operations },
			{ timeoutMs: CLEANUP_WAIT_MS },
		);
	} catch {
		// Provisioning that failed or was cancelled still leaves a branch to delete.
	}
	try {
		await neonClient.branches.delete(
			{ projectId, branchId },
			{ waitForReadiness: false },
		);
	} catch {
		// The original failure is the one to report; the branch name marks an orphan.
	}
};

/**
 * Creates a branch with a 0.25 CU read-write compute and runs `use` on it once
 * it is ready. If waiting for readiness or `use` fails, the branch is deleted and
 * the original error is rethrown, so the id is recorded before any wait starts.
 */
export const withTemporaryBranch = async <T>(
	neonClient: NeonClient<true>,
	projectId: string,
	name: string | undefined,
	signal: AbortSignal | undefined,
	use: (branch: Branch) => Promise<T>,
): Promise<T> => {
	const created = await createProjectBranch({
		client: neonClient.client,
		path: { project_id: projectId },
		body: {
			...(name === undefined ? {} : { branch: { name } }),
			endpoints: [
				{
					type: "read_write",
					autoscaling_limit_min_cu: 0.25,
					autoscaling_limit_max_cu: 0.25,
				},
			],
		},
		throwOnError: true,
		signal,
	});
	try {
		await neonClient.operations.waitFor(
			{ operations: created.operations },
			{ signal },
		);
		return await use(created.branch);
	} catch (error) {
		await discardTemporaryBranch(
			neonClient,
			projectId,
			created.branch.id,
			created.operations,
		);
		throw error;
	}
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
				"Apply a schema change on a temporary branch and return a migration_id. Test with sql.run on that branch, ask the user, then call migrations.complete, even if they reject, so the temporary branch is deleted. Pass every field of the response's `complete` object.",
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
			return withTemporaryBranch(
				neonClient,
				projectId,
				migrationBranchName(),
				signal,
				async (branch) => {
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
						complete: {
							migration_id: randomUUID(),
							migration_sql: input.migration_sql,
							database_name: databaseName,
							project_id: projectId,
							temporary_branch_id: branch.id,
							parent_branch_id: parentBranchId,
						},
						temporary_branch: {
							id: branch.id,
							name: branch.name,
							parent_id: parentBranchId,
						},
						migration_result: migrationResult,
					};
				},
			);
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
				"Apply or discard a prepared migration and delete the temporary branch. NEVER run autonomously; always ask the user first. Pass the fields of the `complete` object migrations.prepare returns: migration_id, migration_sql, database_name, project_id, temporary_branch_id, and parent_branch_id. Set apply_changes false to discard; omitting it applies the migration.",
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
