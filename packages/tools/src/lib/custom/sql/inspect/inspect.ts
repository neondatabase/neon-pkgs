import { NeonClientError } from "@neon/sdk";
import { NeonDbError } from "@neondatabase/serverless";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../../ergonomic/bind.js";
import {
	computeIdField,
	resolveConnection,
	SQL_METADATA,
	sqlClient,
} from "../connection.js";
import { sqlReadAnnotations } from "../schema.js";
import {
	INSPECT_CHECKS,
	INSPECT_DEFAULT_LIMIT,
	INSPECT_MAX_LIMIT,
	INSPECT_QUERIES,
	type InspectCheck,
} from "./queries.js";
import { assembleInspectReport, type InspectDatabaseBatch } from "./report.js";
import { formatInspectQueryError, selectInspectTargets } from "./targets.js";

/**
 * Postgres rejected one of the package's own diagnostic queries. That is a bug
 * in the catalog, not in the caller's input, so hosts should report it like any
 * other server fault. `cause` is the original `NeonDbError`.
 */
export class InspectDiagnosticError extends Error {
	readonly check: InspectCheck;

	constructor(message: string, check: InspectCheck, cause: unknown) {
		super(message, { cause });
		this.name = "InspectDiagnosticError";
		this.check = check;
	}
}

export const inspectDatabaseInputSchema = z.strictObject({
	check: z
		.enum(INSPECT_CHECKS)
		.describe(
			"Which diagnostic to run: table or index sizes, unused indexes, sequential scans, long-running or stalled queries, locks, pg_stat_statements outliers and calls, LFC hit rate, working set, vacuum stats, bloat, replication.",
		),
	project_id: z.string().describe("The ID of the project to inspect"),
	branch_id: z
		.string()
		.optional()
		.describe(
			"An optional ID of the branch. If not provided the default branch is used.",
		),
	database_name: z
		.string()
		.min(
			1,
			"database_name cannot be empty. Omit it to cover every database.",
		)
		.optional()
		.describe(
			"The database to inspect, or for a compute-wide check the database to connect through. Omit to cover every database on the branch; one failing database fails the run.",
		),
	compute_id: computeIdField,
	limit: z
		.number()
		.int()
		.min(1)
		.max(INSPECT_MAX_LIMIT)
		.default(INSPECT_DEFAULT_LIMIT)
		.describe(
			"Maximum number of rows to return from the combined result. The response reports how many rows the check produced; raise this only when `truncated` is true.",
		),
});

/**
 * The proxy refuses an IP allowlist or blocked-network connection with an HTTP
 * 400 whose `severity` is empty; Postgres sets it on every error it raises. A
 * quota refusal is another 4xx, which `@neondatabase/serverless` reports only as
 * this message. A connection the proxy refused never ran the query.
 */
const isRefusedConnection = (error: NeonDbError): boolean =>
	error.severity === "" ||
	/^Server error \(HTTP status 4\d\d\)/.test(error.message);

const runDiagnostic = async <T>(
	check: InspectCheck,
	run: () => Promise<T>,
): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		if (error instanceof NeonDbError && !isRefusedConnection(error)) {
			throw new InspectDiagnosticError(
				`The "${check}" diagnostic failed against Postgres: ${error.message}`,
				check,
				error,
			);
		}
		throw error;
	}
};

const runInspectOnDatabase = async (
	check: InspectCheck,
	uri: string,
	databaseName: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>[]> => {
	const query = INSPECT_QUERIES[check];
	const sql = sqlClient(uri, signal);
	if (query.requiresExtension) {
		const extension = query.requiresExtension;
		const installed = await runDiagnostic(check, () =>
			sql.query("SELECT 1 FROM pg_extension WHERE extname = $1", [
				extension,
			]),
		);
		if (installed.length === 0) {
			throw new NeonClientError(
				`The "${check}" check needs the "${extension}" extension, which is not installed on database "${databaseName}". Installing it writes to the user's database, so ask the user first, then run \`CREATE EXTENSION IF NOT EXISTS ${extension};\` with sql.run.`,
			);
		}
	}
	const [rows] = await runDiagnostic(check, () =>
		sql.transaction([sql.query(query.sql)], { readOnly: true }),
	);
	return rows;
};

/**
 * Puts which database failed into the message of the original error, so its
 * class and fields (`status`, `code`, `check`, …) reach the caller unchanged.
 */
const rethrowInspectError = (
	error: unknown,
	wrapped: string | undefined,
): never => {
	if (wrapped === undefined) throw error;
	if (error instanceof Error) {
		error.message = wrapped;
		throw error;
	}
	throw new Error(wrapped, { cause: error });
};

export const inspectDatabaseTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "database.inspect",
			id: publishedId("database.inspect"),
			title: "Inspect Database",
			description:
				"Run one read-only neon inspect db check (pick `check` from the input schema). Not for arbitrary SQL (`sql.run`), one statement's plan (`sql.explain`), or applying indexes (`queryTuning.prepare`). Omit `database_name` to cover every database; some checks are compute-wide. If a check needs an extension, the tool names `CREATE EXTENSION`; ask before running it.",
			inputSchema: inspectDatabaseInputSchema,
			annotations: sqlReadAnnotations,
			requiresApproval: false,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			const { check, database_name: databaseName, limit } = input;
			const query = INSPECT_QUERIES[check];
			const projectId = input.project_id;
			const branchId =
				input.branch_id ??
				(
					await neonClient.branches.getDefault(
						{ projectId },
						{ signal },
					)
				).id;

			let branchDatabaseCount = 1;
			let selection: ReturnType<typeof selectInspectTargets>;
			if (databaseName !== undefined) {
				selection = selectInspectTargets({
					databaseName,
					branchDatabases: [],
					scope: query.scope,
				});
			} else {
				const databases = await neonClient.postgres.databases.list(
					{ projectId, branchId },
					{ signal },
				);
				const branchDatabases = databases.map(
					(database) => database.name,
				);
				if (branchDatabases.length === 0) {
					throw new NeonClientError(
						"No databases found in your project branch",
					);
				}
				branchDatabaseCount = branchDatabases.length;
				selection = selectInspectTargets({
					branchDatabases,
					scope: query.scope,
				});
			}

			const batches: InspectDatabaseBatch[] = [];
			for (const name of selection.databases) {
				try {
					const connection = await resolveConnection(
						neonClient,
						{
							project_id: projectId,
							branch_id: branchId,
							database_name: name,
							compute_id: input.compute_id,
						},
						context,
						signal,
					);
					batches.push({
						database: name,
						rows: await runInspectOnDatabase(
							check,
							connection.uri,
							name,
							signal,
						),
					});
				} catch (error) {
					rethrowInspectError(
						error,
						formatInspectQueryError({
							reason:
								error instanceof Error
									? error.message
									: String(error),
							database: name,
							databaseName,
							offerDatabaseNameHint: branchDatabaseCount > 1,
							scope: query.scope,
							requiresExtension: query.requiresExtension,
						}),
					);
				}
			}

			return assembleInspectReport({
				check,
				query,
				projectId,
				branchId,
				batches,
				includeDatabaseColumn: selection.includeDatabaseColumn,
				includeDatabaseName: databaseName !== undefined,
				limit,
			});
		},
	);
