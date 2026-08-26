import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import type yargs from "yargs";
import { readContextFile } from "../context.js";
import { childArgv, directoryIsEmpty, planInit } from "../init/plan.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";

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
	agent?: boolean;
	data?: string;
	cwd?: string;
	run?: InitRun;
};

export const command = "init";
export const describe =
	"Install agent skills, link a Neon project, and set up the MCP server. In an empty directory, scaffolds a template first. Skills needs Node.js 22.20 or newer.";

const AUTH_CHILD = new Set(["link", "mcp"]);

const removedProtocol = () =>
	`\`${getCliName()} init --agent\` and \`--data\` were removed. Run \`${getCliName()} skills\`, \`${getCliName()} link\`, and \`${getCliName()} mcp\`.`;

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
				"Forwards -y to skills and mcp, and scaffolds the default template in an empty directory. link --yes still asks for a project unless one is already linked",
		})
		.option("agent", {
			hidden: true,
			type: "boolean",
		})
		.option("data", {
			hidden: true,
			type: "string",
		})
		.example(
			"$0 init",
			"Empty dir: scaffold, then skills, link, and mcp. Existing app: skills, link, mcp",
		)
		.example(
			"$0 init -y",
			"Same steps; forwards -y where the child commands accept it",
		)
		.check((argv) => {
			if (argv.agent === true || argv.data !== undefined) {
				throw new Error(removedProtocol());
			}
			if (
				argv.help !== true &&
				(argv.output === "json" || argv.output === "yaml")
			) {
				throw new Error(
					`\`${getCliName()} init\` does not support --output. The commands it runs print their own output.`,
				);
			}
			return true;
		})
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
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, ...argv], {
			cwd,
			stdio: "inherit",
			env: env ? { ...process.env, ...env } : process.env,
		});
		child.on("error", () => {
			resolve(false);
		});
		child.on("close", (code) => {
			resolve(code === 0);
		});
	});
};

export const handler = async (props: InitProps) => {
	if (props.output === "json" || props.output === "yaml") {
		throw new Error(
			`\`${getCliName()} init\` does not support --output. The commands it runs print their own output.`,
		);
	}

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
		log.info("Running `%s %s`", getCliName(), step.join(" "));
		const argv = childArgv(step, {
			...(props.configDir ? { configDir: props.configDir } : {}),
			...(props.profile ? { profile: props.profile } : {}),
			apiHost: props.apiHost,
			contextFile: props.contextFile,
			...(props.analytics === false ? { analytics: false } : {}),
		});
		const command = step[0];
		const ok = await run(
			argv,
			cwd,
			command !== undefined && AUTH_CHILD.has(command) ? env : undefined,
		);
		if (!ok) {
			throw new Error(`\`${getCliName()} ${step.join(" ")}\` failed.`);
		}
	}

	log.info("Done.");
};
