import type yargs from "yargs";
import * as computes from "./computes.js";
import * as connectionString from "./connection_string.js";
import * as databases from "./databases.js";
import * as psql from "./psql.js";
import * as roles from "./roles.js";

type Group = {
	command: string;
	aliases?: string[];
	describe: string;
	builderFor: (usage: string) => (argv: yargs.Argv) => yargs.Argv<any>;
	handler: (args: never) => unknown;
};

const nested = (group: Group): yargs.CommandModule => ({
	command: group.command,
	aliases: group.aliases,
	describe: group.describe,
	builder: group.builderFor(`postgres ${group.command.split(" ")[0]}`),
	handler: async (args) => {
		await group.handler(args as never);
	},
});

export const command = "postgres";
export const aliases = ["pg", "lakebase"];
export const describe =
	"Manage Postgres computes, databases, and roles, and connect with psql or a connection string";
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 postgres <sub-command> [options]")
		.command(nested(computes))
		.command(nested(databases))
		.command(nested(roles))
		.command(nested(connectionString))
		.command(nested(psql));

export const handler = (args: yargs.Argv) => {
	return args;
};
