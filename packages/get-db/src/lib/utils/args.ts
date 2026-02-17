import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { bold, underline } from "yoctocolors";
import type { Defaults } from "../types.js";

export const DEFAULTS: Defaults = {
	dotEnvPath: "./.env",
	dotEnvKey: "DATABASE_URL",
	seed: undefined,
	envPrefix: "PUBLIC_",
	referrer: "npm:get-db/cli",
	settings: {
		logicalReplication: false,
	},
};

export interface ParsedArgs {
	yes?: boolean;
	env?: string;
	key?: string;
	seed?: string;
	prefix?: string;
	ref?: string;
	logicalReplication?: boolean;
	help?: boolean;
	command: string;
}

export function getArgs(): ParsedArgs | never {
	const argv = yargs(hideBin(process.argv))
		.scriptName("get-db")
		.usage("Usage: $0 [command] [options]")
		.help()
		.version(false)
		.strict()
		.parserConfiguration({
			"camel-case-expansion": true,
			"strip-aliased": true,
			"strip-dashed": true,
		})
		.command("$0", "Create a new database (default command)", {})
		.command("claim", "Open the claim URL from your .env file", {})
		.group("logical-replication", bold("Postgres Settings:"))
		.option("logical-replication", {
			alias: "L",
			type: "boolean",
			description: "Enable logical replication",
			default: false,
		})
		.option("yes", {
			alias: "y",
			type: "boolean",
			description: "Skip prompts / use defaults",
			default: false,
		})
		.option("env", {
			alias: "e",
			type: "string",
			description: ".env file path",
			defaultDescription: DEFAULTS.dotEnvPath,
		})
		.option("key", {
			alias: "k",
			type: "string",
			description: "connection string key",
			defaultDescription: DEFAULTS.dotEnvKey,
		})
		.option("seed", {
			alias: "s",
			type: "string",
			description: "Path to the seed (.sql) file",
			defaultDescription: DEFAULTS.seed?.path || "none",
		})
		.option("prefix", {
			alias: "p",
			type: "string",
			description: "Public env_var prefix",
			defaultDescription: DEFAULTS.envPrefix,
		})
		.option("ref", {
			alias: "r",
			type: "string",
			description: "Referrer id",
			defaultDescription: DEFAULTS.referrer,
		})
		.epilogue(`For more information: ${underline("https://pg.new")}`)
		.parseSync();

	const command = argv._[0]?.toString() || "create";

	return {
		yes: argv.yes,
		env: argv.env,
		key: argv.key,
		seed: argv.seed,
		prefix: argv.prefix,
		ref: argv.ref,
		logicalReplication: argv.logicalReplication,
		command,
	};
}
