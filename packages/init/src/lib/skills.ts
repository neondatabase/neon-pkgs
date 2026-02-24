import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import type { Editor } from "./types.js";

/**
 * Maps editor names to the corresponding agent names used by the skills CLI
 */
function getSkillsAgentName(editor: Editor): string {
	switch (editor) {
		case "Cursor":
			return "cursor";
		case "VS Code":
			return "github-copilot";
		case "Claude CLI":
			return "claude-code";
		default:
			return "";
	}
}

/**
 * Installs Neon agent skills using Vercel's skills CLI
 */
export async function installAgentSkills(
	selectedEditors: Editor[],
): Promise<boolean> {
	if (selectedEditors.length === 0) {
		return true;
	}

	const skillsSpinner = spinner();
	skillsSpinner.start("Installing agent skills for Neon in this project...");

	let anyFailed = false;

	// Run skills add for each selected editor/agent
	for (const editor of selectedEditors) {
		const agentName = getSkillsAgentName(editor);

		if (agentName === "") {
			log.error(`Unsupported editor: ${editor}`);
			anyFailed = true;
			continue;
		}

		try {
			await execa(
				"npx",
				[
					"skills",
					"add",
					"neondatabase/agent-skills",
					"--skill",
					"neon-postgres",
					"--agent",
					agentName,
					"-y",
				],
				{
					stdio: "pipe",
					timeout: 10000,
				},
			);
		} catch (error) {
			log.error(
				`Failed to install agent skills for ${editor}: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			anyFailed = true;
		}
	}

	if (anyFailed) {
		skillsSpinner.stop(
			"Agent skills installation for this project completed with errors",
		);
		log.info(
			"You can manually install skills by running: npx skills add neondatabase/agent-skills --skill neon-postgres",
		);
		return false;
	}

	skillsSpinner.stop("Agent skills installed for this project ✓");
	return true;
}
