import prompts from "prompts";

import { getAgentDisplayName } from "../init/agents.js";
import type { AgentType } from "../mcp/agents.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { NEON_PLUGIN_NAME } from "./run.js";
import type { PluginsInstallScope } from "./targets.js";

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

export const pluginsInstallSummary = (options: {
	scope: PluginsInstallScope;
	agents: readonly AgentType[];
}): string => {
	const rows: [string, string][] = [
		["Scope", options.scope === "project" ? "project" : "user"],
		["Agents", options.agents.map(getAgentDisplayName).join(", ")],
		["Plugin", NEON_PLUGIN_NAME],
	];
	const labelWidth = Math.max(...rows.map(([label]) => label.length));
	return rows
		.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`)
		.join("\n");
};

export const confirmPluginsInstall = async (options: {
	scope: PluginsInstallScope;
	agents: readonly AgentType[];
}): Promise<boolean> => {
	if (!canPickAgentsInteractively()) {
		return true;
	}
	process.stdout.write(`\n${pluginsInstallSummary(options)}\n\n`);
	const { ok } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "ok",
		message: "Install the Neon plugin into these agents?",
		initial: true,
	});
	return ok === true;
};
