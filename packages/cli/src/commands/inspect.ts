import type yargs from "yargs";
import type { BranchScopeProps, CommonProps } from "../types.js";
import { fillSingleProject } from "../utils/enrichers.js";
import { resolveConnectionUri, runInspectQuery } from "../utils/inspect_db.js";
import {
	INSPECT_QUERIES,
	type InspectQuery,
	type InspectSubcommand,
} from "../utils/inspect_queries.js";
import { writer } from "../writer.js";

export const command = "inspect";
export const describe = "Inspect a database's health and configuration";
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

	const connectionUri =
		props.dbUrl ?? (await resolveConnectionUri(props)).connectionUri;

	const rows = await runInspectQuery(connectionUri, query.sql, {
		requiresExtension: query.requiresExtension,
	});
	writer(props).end(rows, {
		fields: query.fields as readonly (keyof (typeof rows)[number])[],
		emptyMessage: query.emptyMessage,
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
				describe: "Database name",
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
