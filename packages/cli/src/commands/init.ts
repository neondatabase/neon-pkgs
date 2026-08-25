import { existsSync, readdirSync } from "node:fs";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import type yargs from "yargs";
import { readContextFile } from "../context.js";
import { childArgv, directoryIsEmpty, planInit } from "../init/plan.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import { runCommand } from "../utils/package_manager.js";

export type InitRun = (
	argv: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
) => Promise<boolean>;

export type InitProps = CommonProps & {
	yes?: boolean;
	configDir?: string;
	profile?: string;
	analytics?: boolean;
	cwd?: string;
	run?: InitRun;
};

export const command = "init";
export const describe =
	"Set up Neon in this directory: agent skills, a project link, and the MCP server";

export const builder = (yargs: yargs.Argv) =>
	yargs
		.usage("$0 init [options]")
		.option("context-file", {
			hidden: true,
		})
		.option("yes", {
			alias: "y",
			type: "boolean",
			default: false,
			describe:
				"Skip prompts. Forwards -y to skills and mcp, --default --no-link to bootstrap, and --yes to link",
		})
		.example(
			"$0 init",
			"Empty dir: bootstrap, then skills update, then mcp",
		)
		.example(
			"$0 init",
			"Existing app: skills, then link if needed, then mcp",
		)
		.example("$0 init -y", "Same steps without prompts")
		.strict();

const isLinked = (contextFile: string): boolean => {
	const projectId = readContextFile(contextFile).projectId;
	return typeof projectId === "string" && projectId.length > 0;
};

const defaultRun: InitRun = async (argv, cwd, env) => {
	const cli = process.argv[1];
	if (!cli) {
		throw new Error(
			"Cannot re-exec the Neon CLI: process.argv[1] is missing.",
		);
	}
	return runCommand(process.execPath, [cli, ...argv], cwd, env);
};

export const handler = async (props: InitProps) => {
	const cwd = props.cwd ?? process.cwd();
	const names = existsSync(cwd) ? readdirSync(cwd) : [];
	const steps = planInit({
		empty: directoryIsEmpty(names),
		linked: isLinked(props.contextFile),
		yes: props.yes === true,
	});
	const run = props.run ?? defaultRun;
	const explicitKey = props.profile ? "" : credentialInputs().apiKeyFlag;
	const env = explicitKey ? { NEON_API_KEY: explicitKey } : undefined;

	for (const step of steps) {
		const argv = childArgv(step, {
			...(props.configDir ? { configDir: props.configDir } : {}),
			...(props.profile ? { profile: props.profile } : {}),
			apiHost: props.apiHost,
			contextFile: props.contextFile,
			...(props.analytics === false ? { analytics: false } : {}),
		});
		const ok = await run(argv, cwd, env);
		if (!ok) {
			throw new Error(`\`${getCliName()} ${step.join(" ")}\` failed.`);
		}
	}

	log.info("Done.");
};
