import type yargs from "yargs";

import { recordCommandSuccessExtras } from "../analytics.js";
import { getAgentDisplayName } from "../init/agents.js";
import { log } from "../log.js";
import { NEON_MCP_URL } from "../mcp/install.js";
import { resolvePluginsPlan } from "../plugins/plan.js";
import {
	NEON_PLUGIN_NAME,
	neonPluginsRetryCommand,
	PLUGIN_SKILLS,
	PLUGIN_SOURCE,
	pluginsAddArgs,
	runPluginsCli,
} from "../plugins/run.js";
import { pluginsInstallableAgents } from "../plugins/targets.js";
import type { CommonProps } from "../types.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { noPassthrough } from "../utils/flags.js";
import { helpCsv, helpEpilogue } from "../utils/help_text.js";
import { writer } from "../writer.js";

type PluginsProps = CommonProps & {
	yes?: boolean;
	global?: boolean;
	agent?: string[];
	/** Working directory to detect project agents in / install project-scoped plugins into. Defaults to `process.cwd()` (tests, and flows like `bootstrap` that scaffold into a different directory). */
	cwd?: string;
};

const coerceAgents = (value: unknown): string[] => {
	if (value === undefined) return [];
	const list = Array.isArray(value) ? value : [value];
	if (list.length === 0) {
		throw new Error(
			"--agent needs a value. Pass one, or omit the flag entirely.",
		);
	}
	return list.map((item) => {
		if (typeof item !== "string" || item.trim() === "") {
			throw new Error(
				"--agent needs a value. Pass one, or omit the flag entirely.",
			);
		}
		return item;
	});
};

type PluginsInstallRow = {
	scope: string;
	plugin: string;
	agent: string;
	status: "installed" | "failed";
	error?: string;
};

const scopeLabel = (scope: "global" | "project"): string =>
	scope === "project" ? "project" : "user";

export const command = "plugins";
export const aliases = ["plugin"];
export const describe = "Install the Neon plugin into coding agents";

const pluginProjectAgents = pluginsInstallableAgents("project");
const pluginGlobalOnlyAgents = pluginsInstallableAgents("global").filter(
	(id) => !pluginProjectAgents.includes(id),
);

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 plugins [options]")
		.options({
			yes: {
				alias: "y",
				type: "boolean",
				default: false,
				describe:
					"Skip prompts. Detected agents (project folders, else the host CLI agent). --global uses installed apps, else the host CLI agent",
			},
			global: {
				type: "boolean",
				default: false,
				describe: "Install user-level. Default is project",
			},
			agent: {
				alias: "a",
				type: "array",
				string: true,
				describe:
					"Coding agent to install into (repeatable). Skips the agent picker. Values listed below",
				coerce: coerceAgents,
			},
		})
		.example("$0 plugins", "Interactive: pick agents, then install")
		.example(
			"$0 plugins -y",
			"Detected agents (project folders, else the host CLI agent), skip prompts",
		)
		.example(
			"$0 plugins --agent cursor --agent claude-code",
			"Install into specific agents",
		)
		.example("$0 plugins --global", "Install user-level")
		.epilogue(
			helpEpilogue(
				helpCsv(
					"Supported agents at project scope",
					pluginProjectAgents,
				),
				helpCsv("Also with --global", pluginGlobalOnlyAgents),
				`Currently one plugin: ${NEON_PLUGIN_NAME} from ${PLUGIN_SOURCE}.`,
				`It includes the Neon MCP server (${NEON_MCP_URL})`,
				helpCsv("and these skills", PLUGIN_SKILLS),
			),
		)
		.strict()
		.check(noPassthrough("plugins"));

export type InstallPluginsOptions = {
	cwd?: string;
	yes?: boolean;
	global?: boolean;
	agents?: readonly string[];
};

type PluginsInstallFailure = { agents: string[]; message: string };

export type PluginsInstallOutcome = {
	scope: "project" | "global";
	rows: PluginsInstallRow[];
	failed: PluginsInstallFailure[];
};

/**
 * Plans and runs the plugin install for every resolved target, in-process. No CLI-only
 * concerns here (no `writer` table, no `recordCommandSuccessExtras`) so `neon init` /
 * `neon bootstrap` can call this directly instead of re-executing the `neon` binary as a
 * child process to reuse `neon plugins`.
 */
export const installPlugins = async (
	options: InstallPluginsOptions,
): Promise<PluginsInstallOutcome> => {
	const cwd = options.cwd ?? process.cwd();
	const yes = options.yes === true;
	const interactive = canPickAgentsInteractively() && !yes;
	const plan = await resolvePluginsPlan({
		global: options.global === true,
		agents: options.agents ?? [],
		yes,
		cwd,
		interactive,
	});
	for (const agent of plan.skipped) {
		log.warning(
			"Skipping %s: no plugins mapping.",
			getAgentDisplayName(agent),
		);
	}
	for (const agent of plan.userScopeSkipped) {
		log.warning(
			"Skipping %s: plugins are user-level. Pass --global.",
			getAgentDisplayName(agent),
		);
	}

	const rows: PluginsInstallRow[] = [];
	const failed: PluginsInstallFailure[] = [];
	const scope = scopeLabel(plan.scope);
	for (const [index, mapped] of plan.targets.entries()) {
		const args = pluginsAddArgs({
			target: mapped.target,
			global: plan.scope === "global",
		});
		const agent = mapped.agents.join(", ");
		const displayNames = mapped.agents
			.map((id) => getAgentDisplayName(id))
			.join(", ");
		log.info(
			"Installing the Neon plugin for %s (%d/%d)...",
			displayNames,
			index + 1,
			plan.targets.length,
		);
		try {
			await runPluginsCli({
				args,
				cwd,
			});
			rows.push({
				scope,
				plugin: NEON_PLUGIN_NAME,
				agent,
				status: "installed",
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			rows.push({
				scope,
				plugin: NEON_PLUGIN_NAME,
				agent,
				status: "failed",
				error: "plugins CLI failed",
			});
			failed.push({
				agents: mapped.agents,
				message,
			});
		}
	}

	return { scope: plan.scope, rows, failed };
};

/** The exact error `neon plugins` throws for a failed outcome, or `undefined` on success. */
export const pluginsInstallError = (
	outcome: PluginsInstallOutcome,
): Error | undefined => {
	const { failed, rows, scope } = outcome;
	if (failed.length === 0) {
		return undefined;
	}
	const first = failed[0];
	if (first === undefined) {
		return new Error("Failed to install the Neon plugin.");
	}
	const retry = neonPluginsRetryCommand({
		agents: failed.flatMap((row) => row.agents),
		global: scope === "global",
	});
	if (first.message.includes("needs npx (Node.js)")) {
		return new Error(first.message);
	}
	const detail = failed.map((row) => row.message).join("\n");
	if (failed.length === rows.length) {
		return new Error(`${detail}\nRetry with: ${retry}`);
	}
	return new Error(
		`Failed to install the Neon plugin for: ${failed.flatMap((row) => row.agents).join(", ")}.\n${detail}\nRetry with: ${retry}`,
	);
};

/** Writes the results table and, on success, the "Installed the Neon plugin" line. Shared by `neon plugins` and any in-process caller that wants the same human output. */
export const reportPluginsInstall = (
	props: Pick<CommonProps, "output">,
	outcome: PluginsInstallOutcome,
): void => {
	const out = writer(props);
	out.write(outcome.rows, {
		fields: ["scope", "plugin", "agent", "status", "error"],
		title: "Plugins",
	});
	out.end();
	if (outcome.failed.length === 0) {
		log.info(
			outcome.scope === "project"
				? "Installed the Neon plugin (project)."
				: "Installed the Neon plugin (user).",
		);
	}
};

export const handler = async (props: PluginsProps) => {
	const outcome = await installPlugins({
		cwd: props.cwd,
		yes: props.yes,
		global: props.global,
		agents: props.agent,
	});
	reportPluginsInstall(props, outcome);
	const error = pluginsInstallError(outcome);
	if (error) {
		throw error;
	}
	recordCommandSuccessExtras({ scope: outcome.scope });
};
