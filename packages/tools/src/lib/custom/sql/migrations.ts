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
	projectIdField,
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
		.describe(
			"The migration SQL. It is split on every semicolon, including one inside a string or function body.",
		),
	project_id: projectIdField,
	database_name: z.string().optional().describe(DATABASE_NAME_DESCRIPTION),
});

export const completeMigrationInputSchema = z.strictObject({
	migration_id: z
		.string()
		.describe("The migration_id from {{migrations.prepare}}."),
	migration_sql: z
		.string()
		.describe("The exact migration_sql from {{migrations.prepare}}."),
	database_name: z
		.string()
		.describe("The exact database_name from {{migrations.prepare}}."),
	project_id: z
		.string()
		.describe("The exact project_id from {{migrations.prepare}}."),
	temporary_branch_id: z.string().describe("The temporary branch to delete."),
	parent_branch_id: z
		.string()
		.describe("The branch the migration is applied to."),
	apply_changes: z
		.boolean()
		.default(true)
		.describe(
			"Apply the migration to the parent branch. false only deletes the temporary branch.",
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
				"Applies a schema change on a new temporary branch and returns a migration_id. Test it there with {{sql.run}}, ask the user, then always call {{migrations.complete}} with the response's complete object so the branch is deleted.",
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
			refuseInReadOnly(context);
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
				"Applies or discards a prepared migration and deletes the temporary branch. NEVER run autonomously; always ask the user first. Pass the complete object from {{migrations.prepare}}; apply_changes false discards.",
			inputSchema: completeMigrationInputSchema,
			annotations: sqlWriteAnnotations,
			requiresApproval: true,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			refuseInReadOnly(context);
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
