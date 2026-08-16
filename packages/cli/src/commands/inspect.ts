import type yargs from "yargs";
import type { BranchScopeProps, CommonProps } from "../types.js";
import { fillSingleProject } from "../utils/enrichers.js";
import {
	formatInspectQueryError,
	resolveInspectTargets,
	runInspectQuery,
} from "../utils/inspect_db.js";
import {
	INSPECT_QUERIES,
	type InspectQuery,
	type InspectSubcommand,
} from "../utils/inspect_queries.js";
import { writer } from "../writer.js";

export const command = "inspect";
export const describe = "Inspect a branch's Postgres health and configuration";
export const aliases = ["inspection"];

type InspectProps = BranchScopeProps & {
	branch?: string;
	roleName?: string;
	databaseName?: string;
	dbUrl?: string;
};

/**
 * `fillSingleProject` hits the API to auto-resolve a project. When the user
 * passes `--db-url` we bypass the Neon API entirely, so skip it.
 */
const fillSingleProjectUnlessDbUrl = async (
	props: CommonProps & { projectId?: string; orgId?: string; dbUrl?: string },
) => {
	if (props.dbUrl) {
		return props;
	}
	return fillSingleProject(props);
};

const runSubcommand = async (name: InspectSubcommand, props: InspectProps) => {
	const query: InspectQuery = INSPECT_QUERIES[name];
	const { targets, includeDatabaseColumn, branchDatabaseCount } =
		await resolveInspectTargets(props, query.scope);

	const rows: Record<string, unknown>[] = [];
	for (const target of targets) {
		let batch: Record<string, unknown>[];
		try {
			batch = await runInspectQuery(target.connectionUri, query.sql, {
				requiresExtension: query.requiresExtension,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			const wrapped = formatInspectQueryError({
				reason,
				database: target.database,
				dbUrl: props.dbUrl,
				databaseName: props.databaseName,
				offerDatabaseNameHint: branchDatabaseCount > 1,
				scope: query.scope,
			});
			if (wrapped === undefined) {
				throw err instanceof Error ? err : new Error(reason);
			}
			throw new Error(wrapped);
		}
		if (includeDatabaseColumn) {
			rows.push(
				...batch.map((row) => ({
					database: target.database,
					...row,
				})),
			);
		} else {
			rows.push(...batch);
		}
	}

	const fields = includeDatabaseColumn
		? ["database", ...query.fields]
		: query.fields;
	writer(props).end(rows, {
		fields: fields as readonly (keyof (typeof rows)[number])[],
		emptyMessage: includeDatabaseColumn
			? (query.emptyMessageAll ?? query.emptyMessage)
			: query.emptyMessage,
	});
};

const dbBuilder = (argv: yargs.Argv) => {
	let builder = argv
		.usage("$0 inspect db <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
			"database-name": {
				describe:
					"Database to inspect. Omit to cover every database on the branch. Ranking and row limits stay per database. One failing database fails the whole run. Compute-wide checks run once against the first listed database. Ignored with --db-url.",
				type: "string",
			},
			"role-name": {
				describe: "Role name",
				type: "string",
			},
			"db-url": {
				describe:
					"Inspect any Postgres via a connection string, bypassing the Neon API (project/branch resolution is skipped)",
				type: "string",
			},
		})
		.middleware(fillSingleProjectUnlessDbUrl as any);

	for (const name of Object.keys(INSPECT_QUERIES) as InspectSubcommand[]) {
		builder = builder.command(
			name,
			INSPECT_QUERIES[name].describe,
			(yargs) => yargs,
			(args) => runSubcommand(name, args as unknown as InspectProps),
		);
	}

	return builder;
};

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 inspect <sub-command> [options]")
		.command(
			"db",
			"Run a diagnostic query against a branch's Postgres",
			dbBuilder,
		);

export const handler = (args: yargs.Argv) => {
	return args;
};
