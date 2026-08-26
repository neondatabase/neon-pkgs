import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import type yargs from "yargs";
import { readContextFile } from "../context.js";
import { type InitRun, initChildEnv, spawnCliChild } from "../init/child.js";
import {
	bootstrapInitStep,
	directoryIsEmpty,
	type InitAgentSetup,
	planExistingInit,
} from "../init/plan.js";
import { runAgentTooling, runInitSteps } from "../init/tooling.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import { helpEpilogue } from "../utils/help_text.js";

export type { InitRun };
export { initChildEnv };

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
	"Set up this directory for Neon: agent tooling, a linked project, and neon.ts. In an empty directory, scaffolds a template first. Skills needs Node.js 22.20 or newer.";

const removedProtocol = () =>
	`\`${getCliName()} init --agent\` and \`--data\` were removed. Run \`${getCliName()} init\` or \`${getCliName()} init -y\`.`;

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
				"Empty dir: bootstrap --default. Otherwise plugin when a project plugin agent is detected, else skills and MCP, then link --yes and config init --services none. link --yes still asks for a project unless one is already linked",
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
			"Empty dir: bootstrap (scaffold, agent tooling, link). Existing app: agent tooling, link, config init",
		)
		.example("$0 init -y", "Same steps, using each child's defaults")
		.epilogue(
			helpEpilogue(
				"Interactive agent setup: plugin (recommended), skills and MCP separately, or skip agent setup. Never both plugin and skills+MCP.",
				"-y installs the plugin when Cursor, Claude Code, or Codex is detected in the project. Otherwise skills and MCP. Then link unless already linked. link --yes may still ask for a project.",
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
	const run = props.run ?? spawnCliChild;
	const explicitKey = props.profile ? "" : credentialInputs().apiKeyFlag;
	const authEnv = explicitKey ? { NEON_API_KEY: explicitKey } : undefined;
	const forward = {
		...(props.configDir ? { configDir: props.configDir } : {}),
		...(props.profile ? { profile: props.profile } : {}),
		apiHost: props.apiHost,
		contextFile,
		...(props.analytics === false ? { analytics: false } : {}),
	};

	if (directoryIsEmpty(names)) {
		await runInitSteps([bootstrapInitStep(yes)], {
			cwd,
			run,
			forward,
			authEnv,
		});
		log.info("Done.");
		return;
	}

	await runAgentTooling({
		cwd,
		yes,
		run,
		forward,
		authEnv,
		...(props.pickAgentSetup
			? { pickAgentSetup: props.pickAgentSetup }
			: {}),
		...(props.hasProjectPlugins
			? { hasProjectPlugins: props.hasProjectPlugins }
			: {}),
	});
	await runInitSteps(
		planExistingInit({
			linked: isLinked(contextFile),
			yes,
			agentSetup: "skip",
		}),
		{ cwd, run, forward, authEnv },
	);

	log.info("Done.");
};
