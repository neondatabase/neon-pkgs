import type yargs from "yargs";
import {
	CONFIG_INIT_NONE_MEANS,
	CONFIG_INIT_SERVICES,
} from "../config_template.js";
import { initPluginAgents, initSkillsMcpAgents } from "../init/plan.js";
import { type InitProps, type InitRun, runInit } from "../init/run.js";
import { servicesOption } from "../neon_services.js";
import { listSkillIds } from "../skills/catalog.js";
import { coerceAgentFlag } from "../utils/agent_flag.js";
import { getCliName } from "../utils/cli_name.js";
import { helpCsv, helpEpilogue } from "../utils/help_text.js";

export { initChildEnv } from "../init/run.js";
export type { InitProps, InitRun };

export const command = "init";
export const describe =
	"Set up coding agents and this directory for Neon. -y is Recommended. -y with Custom flags configures those choices without prompts.";

const removedProtocol = () =>
	`\`${getCliName()} init --data\` was removed. Run \`${getCliName()} init\` or \`${getCliName()} init -y\`.`;

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
				"Skip prompts. Alone: Recommended (detected agents, link when authenticated, default neon.ts). With --skill, MCP flags, --no-agent-setup, or --project-setup: Custom using those flags. Empty directories are not scaffolded; use --template or neon bootstrap",
		})
		.option("agent-setup", {
			type: "boolean",
			default: true,
			describe:
				"Install Neon into coding agents. Use --no-agent-setup to skip",
		})
		.option("project-setup", {
			type: "string",
			choices: ["link", "claimable"] as const,
			describe:
				"Sign in and link an account project, or create a claimable project",
		})
		.option("package-manager", {
			type: "string",
			choices: ["npm", "pnpm", "yarn", "bun"] as const,
			describe:
				"Package manager for neon.ts dependencies. Recommended detects one. Custom asks only when none is detected",
		})
		.option("skip-template", {
			type: "boolean",
			default: false,
			describe:
				"Do not scaffold a template. Set up agents, a project, and neon.ts in this directory",
		})
		.option("template", {
			type: "string",
			describe:
				"Template to scaffold into an empty directory. Conflicts with --skip-template",
		})
		.option("link", {
			type: "boolean",
			default: true,
			describe:
				"Link a Neon project during setup. Use --no-link to skip without being asked",
		})
		.option("config", {
			type: "boolean",
			describe:
				"Create neon.ts after linking. Use --no-config to skip. Omitted in Custom: you will be asked. Scaffolding a template keeps that template's neon.ts",
		})
		.option(
			"services",
			servicesOption({
				key: "services",
				allowed: CONFIG_INIT_SERVICES,
				describe: "Services to declare in neon.ts",
				noneMeans: CONFIG_INIT_NONE_MEANS,
				also: "Implies creating neon.ts. Cannot be combined with --no-config. Ignored when scaffolding a template.",
			}),
		)
		.option("org-id", {
			describe: "Forwarded to link: organization ID to link to",
			type: "string",
		})
		.option("project-id", {
			describe: "Forwarded to link: existing project ID to link to",
			type: "string",
		})
		.option("project-name", {
			describe: "Forwarded to link: name for a new project",
			type: "string",
		})
		.option("region-id", {
			describe: "Forwarded to link: region for a new project",
			type: "string",
		})
		.option("branch", {
			alias: "branch-id",
			describe: "Forwarded to link: branch name or ID to pin",
			type: "string",
		})
		.option("agent", {
			alias: "a",
			type: "array",
			string: true,
			describe:
				"Coding agent to install into (repeatable). Skips agent selection. Values listed below",
			coerce: coerceAgentFlag,
		})
		.option("skill", {
			type: "array",
			string: true,
			describe:
				"Neon skill to install (repeatable). Selects skills setup (not the plugin) and skips the skills picker. With MCP flags, also configures MCP. Values listed below",
		})
		.option("mcp-scope", {
			type: "string",
			choices: ["global", "project"] as const,
			describe:
				"Where to configure the Neon MCP server: global (user config, same as neon mcp) or project (this directory, same as neon mcp --project). Selects skills and MCP setup",
		})
		.option("mcp-auth", {
			type: "string",
			choices: ["oauth", "api-key"] as const,
			describe:
				"MCP authentication. Selects skills and MCP setup. oauth is neon mcp --oauth",
		})
		.option("mcp-project-id", {
			type: "string",
			describe:
				"Pin MCP tools to this project. Distinct from --project-id, which is for link. Selects skills and MCP setup",
		})
		.option("mcp-project-pin", {
			type: "boolean",
			describe:
				"Pin MCP tools to the linked project. Use --no-mcp-project-pin to decline. Selects skills and MCP setup",
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
		.example("$0 init", "Recommended or Custom setup")
		.example("$0 init -y", "Recommended setup without prompts")
		.example(
			"$0 init -y --skill neon --mcp-auth oauth --mcp-scope project",
			"Custom: those skills and MCP, Recommended defaults for the rest",
		)
		.example(
			"$0 init --no-agent-setup --project-setup claimable",
			"Skip agent setup and create a claimable project",
		)
		.example(
			"$0 init --skip-template",
			"Set up this directory without scaffolding a template",
		)
		.example(
			"$0 init --template hono -y",
			"Scaffold the hono template, then continue setup",
		)
		.example(
			"$0 init --agent cursor --agent claude-code",
			"Skip agent selection; install tooling for those agents",
		)
		.epilogue(
			helpEpilogue(
				"Recommended setup installs tooling for detected coding agents, links a Neon project when the CLI is authenticated or the session is interactive, and writes a default neon.ts.",
				"-y alone is Recommended. -y with --skill, MCP flags, --no-agent-setup, or --project-setup is Custom: those flags, Recommended defaults for unanswered questions.",
				"-y does not scaffold a starter app. Scaffold with --template <id> or neon bootstrap.",
				"--skill selects skills (not the plugin). MCP flags select skills and MCP. --no-agent-setup skips agent setup. --agent without those flags installs the plugin (and skills/MCP for agents the plugin cannot cover).",
				"Without a TTY, pass -y or enough flags to answer every question.",
				"--agent / -a is forwarded to plugins, or to skills and mcp. It skips agent selection, including with -y.",
				helpCsv("Plugin agents", initPluginAgents()),
				helpCsv("Skills and MCP agents", initSkillsMcpAgents()),
				helpCsv("Skills", listSkillIds()),
			),
		)
		.check((argv) => {
			if (argv.data !== undefined) {
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

export const handler = async (props: InitProps) => {
	await runInit(props);
};
