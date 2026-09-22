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
	"Set up coding agents and this directory for Neon. -y runs Recommended setup without prompts.";

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
				"Run Recommended setup without prompts: detected agents, link when authenticated, and a default neon.ts. Empty directories are not scaffolded; use --template or neon bootstrap",
		})
		.option("mode", {
			type: "string",
			choices: ["recommended", "custom"] as const,
			describe:
				"Recommended setup or Custom setup. -y selects Recommended",
		})
		.option("agent-setup", {
			type: "string",
			choices: ["plugin", "skills-mcp", "skip"] as const,
			describe:
				"Custom: Neon plugin, skills and MCP separately, or skip agent setup",
		})
		.option("project-setup", {
			type: "string",
			choices: ["link", "claimable"] as const,
			describe:
				"Custom: sign in and link an account project, or create a claimable project",
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
				"Custom: Neon skill to install (repeatable). Skips the skills picker. Values listed below",
		})
		.option("mcp-scope", {
			type: "string",
			choices: ["global", "project"] as const,
			describe: "Custom: where to configure the Neon MCP server",
		})
		.option("mcp-auth", {
			type: "string",
			choices: ["oauth", "api-key"] as const,
			describe: "Custom: MCP authentication",
		})
		.option("mcp-project-id", {
			type: "string",
			describe:
				"Custom: pin MCP tools to this project. Distinct from --project-id, which is for link",
		})
		.option("mcp-project-pin", {
			type: "boolean",
			describe:
				"Custom: pin MCP tools to the linked project. Use --no-mcp-project-pin to decline",
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
				"-y is Recommended setup. It does not scaffold a starter app. Scaffold with --template <id> or neon bootstrap.",
				"Custom setup chooses plugin, skills and MCP, or skip; sign-in vs a claimable project; and neon.ts services.",
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
