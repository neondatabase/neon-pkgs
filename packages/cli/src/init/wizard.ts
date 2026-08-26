import prompts from "prompts";

import { NEON_PLUGIN_NAME } from "../plugins/run.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import type { InitAgentSetup } from "./plan.js";

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

export const pickAgentSetupInteractively =
	async (): Promise<InitAgentSetup> => {
		if (!canPickAgentsInteractively()) {
			throw new Error(
				"No interactive terminal. Pass -y to use defaults, or run this command in a terminal.",
			);
		}
		const { setup } = await prompts({
			onState: restoreCursorOnAbort,
			type: "select",
			name: "setup",
			message: "How should coding agents get Neon in this project?",
			initial: 0,
			choices: [
				{
					title: "Plugin (recommended)",
					value: "plugin",
					description: `Install ${NEON_PLUGIN_NAME} (skills and MCP in one)`,
				},
				{
					title: "Skills and MCP separately",
					value: "skills-mcp",
					description: "Install skills, then the MCP server",
				},
				{
					title: "Skip agent setup",
					value: "skip",
					description: "Link a project only",
				},
			],
		});
		if (setup !== "plugin" && setup !== "skills-mcp" && setup !== "skip") {
			throw new Error("Aborted.");
		}
		return setup;
	};
