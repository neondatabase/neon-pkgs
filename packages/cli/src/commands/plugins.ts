import type yargs from "yargs";

import { getAgentDisplayName } from "../init/agents.js";
import { log } from "../log.js";
import { resolvePluginsPlan } from "../plugins/plan.js";
import {
	NEON_PLUGIN_NAME,
	neonPluginsRetryCommand,
	pluginsAddArgs,
	runPluginsCli,
} from "../plugins/run.js";
import { confirmPluginsInstall } from "../plugins/wizard.js";
import type { CommonProps } from "../types.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { noPassthrough } from "../utils/flags.js";
import { writer } from "../writer.js";

type PluginsProps = CommonProps & {
	yes?: boolean;
	global?: boolean;
	agent?: string[];
};

type PluginsInstallRow = {
	scope: string;
	plugin: string;
	agent: string;
	status: "installed" | "failed";
	error?: string;
};

const scopeLabel = (scope: "global" | "project"): string =>
	scope === "project" ? "project-scoped" : "user-level";

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

export const command = "plugins";
export const describe = "Install the Neon plugin into coding agents";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 plugins [options]")
		.options({
			yes: {
				alias: "y",
				type: "boolean",
				default: false,
				describe: "Skip prompts",
			},
			global: {
				type: "boolean",
				default: false,
				describe:
					"Install user-level (plugins CLI -s user). Default is project-scoped (-s project)",
			},
			agent: {
				alias: "a",
				type: "array",
				string: true,
				describe:
					"Coding agent to install into (repeatable). Skips the agent picker",
				coerce: coerceAgents,
			},
		})
		.example(
			"$0 plugins",
			"Interactive: project-scoped, agents, then confirm",
		)
		.example(
			"$0 plugins -y",
			"Project-scoped, detected agents, skip prompts",
		)
		.example(
			"$0 plugins --agent cursor --agent claude-code",
			"Install into specific agents",
		)
		.example("$0 plugins --global", "Install user-level")
		.strict()
		.check(noPassthrough("plugins"));

export const handler = async (props: PluginsProps) => {
	const cwd = process.cwd();
	const yes = props.yes === true;
	const interactive = canPickAgentsInteractively() && !yes;
	const plan = await resolvePluginsPlan({
		global: props.global === true,
		agents: props.agent ?? [],
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

	if (interactive) {
		const ok = await confirmPluginsInstall({
			scope: plan.scope,
			agents: plan.agents,
		});
		if (!ok) {
			log.info("Aborted. Nothing was written.");
			return;
		}
	}

	const rows: PluginsInstallRow[] = [];
	const failed: { agent: string; message: string }[] = [];
	const scope = scopeLabel(plan.scope);
	for (const mapped of plan.targets) {
		const args = pluginsAddArgs({
			target: mapped.target,
			global: plan.scope === "global",
		});
		try {
			await runPluginsCli({
				args,
				cwd,
			});
			rows.push({
				scope,
				plugin: NEON_PLUGIN_NAME,
				agent: mapped.agent,
				status: "installed",
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			rows.push({
				scope,
				plugin: NEON_PLUGIN_NAME,
				agent: mapped.agent,
				status: "failed",
				error: "plugins CLI failed",
			});
			failed.push({
				agent: mapped.agent,
				message,
			});
		}
	}

	const out = writer(props);
	out.write(rows, {
		fields: ["scope", "plugin", "agent", "status", "error"],
		title: "Plugins",
	});
	out.end();

	if (failed.length === 0) {
		log.info(
			plan.scope === "project"
				? "Installed the Neon plugin (project-scoped)."
				: "Installed the Neon plugin (user-level).",
		);
		return;
	}
	const first = failed[0];
	if (first === undefined) {
		throw new Error("Failed to install the Neon plugin.");
	}
	const retry = neonPluginsRetryCommand({
		agents: failed.map((row) => row.agent),
		global: plan.scope === "global",
	});
	if (first.message.includes("needs npx (Node.js)")) {
		throw new Error(first.message);
	}
	if (failed.length === rows.length) {
		throw new Error(`${first.message}\nRetry with: ${retry}`);
	}
	throw new Error(
		`Failed to install the Neon plugin for: ${failed.map((row) => row.agent).join(", ")}.\n${first.message}\nRetry with: ${retry}`,
	);
};
