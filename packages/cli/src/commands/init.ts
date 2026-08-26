import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import type yargs from "yargs";
import { readContextFile } from "../context.js";
import {
	bootstrapInitStep,
	childArgv,
	directoryIsEmpty,
	type InitAgentSetup,
	type InitStep,
	planInit,
	resolveInitAgentSetup,
} from "../init/plan.js";
import { pickAgentSetupInteractively } from "../init/wizard.js";
import { log } from "../log.js";
import {
	detectInstallablePluginsAgents,
	pluginsInstallableAgents,
} from "../plugins/targets.js";
import type { CommonProps } from "../types.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { helpCsv, helpEpilogue } from "../utils/help_text.js";

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
	pickAgentSetup?: () => Promise<InitAgentSetup>;
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
};

export const command = "init";
export const describe =
	"Offer the Neon plugin or skills and MCP, then link a project. In an empty directory, scaffolds a template first. Skills needs Node.js 22.20 or newer.";

const AUTH_CHILD = new Set(["link", "mcp"]);

const pluginProjectAgents = pluginsInstallableAgents("project");

const removedProtocol = () =>
	`\`${getCliName()} init --agent\` and \`--data\` were removed. Run \`${getCliName()} plugins\`, \`${getCliName()} skills\`, \`${getCliName()} link\`, and \`${getCliName()} mcp\`.`;

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
				"Uses the default template in an empty directory. Installs the plugin when a project plugin agent is detected, otherwise skills and MCP. link --yes still asks for a project unless one is already linked",
		})
		.option("agent", {
			hidden: true,
			type: "boolean",
		})
		.option("data", {
			hidden: true,
			type: "string",
		})
		.option("output", {
			alias: "o",
			hidden: true,
			describe:
				"Not supported; the commands init runs print their own output",
		})
		.example(
			"$0 init",
			"Empty dir: scaffold, then offer plugin or skills and MCP, then link",
		)
		.example(
			"$0 init -y",
			"Plugin when a project plugin agent is detected, otherwise skills and MCP",
		)
		.epilogue(
			helpEpilogue(
				"Interactive: plugin (recommended), skills and MCP separately, or skip agent setup. Never both plugin and skills+MCP.",
				helpCsv(
					"-y installs the plugin when one of these is detected in the project",
					pluginProjectAgents,
				),
				"Otherwise -y installs skills and MCP. Then link unless already linked.",
			),
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

const defaultHasProjectPlugins = async (cwd: string): Promise<boolean> => {
	const detected = await detectInstallablePluginsAgents({
		scope: "project",
		cwd,
	});
	return detected.length > 0;
};

export const handler = async (props: InitProps) => {
	if (props.output === "json" || props.output === "yaml") {
		throw new Error(
			`\`${getCliName()} init\` does not support --output. The commands it runs print their own output.`,
		);
	}

	const cwd = props.cwd ?? process.cwd();
	const names = existsSync(cwd) ? readdirSync(cwd) : [];
	const contextFile = resolve(cwd, props.contextFile);
	const yes = props.yes === true;
	const run = props.run ?? defaultRun;
	const explicitKey = props.profile ? "" : credentialInputs().apiKeyFlag;
	const env = explicitKey ? { NEON_API_KEY: explicitKey } : undefined;
	const forward = {
		...(props.configDir ? { configDir: props.configDir } : {}),
		...(props.profile ? { profile: props.profile } : {}),
		apiHost: props.apiHost,
		contextFile,
		...(props.analytics === false ? { analytics: false } : {}),
	};

	const runStep = async (step: InitStep) => {
		log.info("Running `%s %s`", getCliName(), step.join(" "));
		const argv = childArgv(step, forward);
		const command = step[0];
		const ok = await run(
			argv,
			cwd,
			command !== undefined && AUTH_CHILD.has(command) ? env : undefined,
		);
		if (!ok) {
			throw new Error(`\`${getCliName()} ${step.join(" ")}\` failed.`);
		}
	};

	if (directoryIsEmpty(names)) {
		await runStep(bootstrapInitStep(yes));
	}

	const hasProjectPlugins = yes
		? await (props.hasProjectPlugins ?? defaultHasProjectPlugins)(cwd)
		: false;
	const interactive =
		!yes &&
		(props.pickAgentSetup !== undefined || canPickAgentsInteractively());
	const agentSetup = await resolveInitAgentSetup({
		yes,
		interactive,
		hasProjectPlugins,
		pick: props.pickAgentSetup ?? pickAgentSetupInteractively,
	});

	for (const step of planInit({
		linked: isLinked(contextFile),
		yes,
		agentSetup,
	})) {
		await runStep(step);
	}

	log.info("Done.");
};
