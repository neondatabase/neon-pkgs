import {
	confirm,
	intro,
	isCancel,
	log,
	multiselect,
	note,
	outro,
} from "@clack/prompts";
import { bold, cyan } from "yoctocolors";
import { detectAvailableEditors } from "./lib/editors.js";
import { usesExtension } from "./lib/extension.js";
import { installNeon } from "./lib/install.js";
import { installAgentSkills } from "./lib/skills.js";
import type { Editor } from "./lib/types.js";

export interface InitOptions {
	/** When set, configures only this agent and skips the editor selection prompt. */
	agent?: Editor;
}

/**
 * Initialize Neon projects with MCP Server
 */
export async function init(options?: InitOptions): Promise<void> {
	if (options?.agent !== undefined) {
		if (usesExtension(options.agent)) {
			intro(
				`Adding Neon extension (includes MCP server) and agent skills for ${options.agent}`,
			);
		} else {
			intro(
				`Adding Neon MCP server and agent skills for ${options.agent}`,
			);
		}
	} else {
		intro(
			"Adding Neon MCP server, extension (for VS Code and Cursor) and agent skills",
		);
	}

	// Get the home directory
	const homeDir = process.env.HOME || process.env.USERPROFILE;
	if (!homeDir) {
		log.error("Could not determine home directory");
		outro("📣 Is this unexpected? Email us at feedback@neon.tech");
		process.exit(1);
	}

	// Get the current workspace directory
	const workspaceDir = process.cwd();

	let selectedEditors: Editor[];

	if (options?.agent !== undefined) {
		selectedEditors = [options.agent];
	} else {
		// Detect available editors
		const availableEditors = await detectAvailableEditors(homeDir);

		// If no editors detected, offer to continue anyway
		if (availableEditors.length === 0) {
			log.warn("No supported editors detected on your system.");
			log.info("Supported editors:");
			log.info("  • VS Code (with Neon Local Connect extension)");
			log.info("  • Cursor (with Neon Local Connect extension)");
			log.info("  • Claude CLI (with MCP Server)");

			const continueAnyway = await confirm({
				message:
					"Would you like to configure Neon anyway? (You can manually select your editor)",
				initialValue: true,
			});

			if (isCancel(continueAnyway) || !continueAnyway) {
				outro("Installation cancelled");
				process.exit(0);
			}
		}

		// Determine which editors to configure
		const response = await multiselect({
			message:
				"Which editor(s) would you like to configure? (Space to toggle each option, Enter to confirm your selection)",
			options: ["Cursor", "VS Code", "Claude CLI"].map((editor) => ({
				value: editor,
				label: editor,
				hint:
					editor === "Claude CLI"
						? "MCP Server"
						: "Neon Local Connect extension",
			})),
			initialValues: availableEditors, // Select detected editors by default
			required: true,
		});

		if (isCancel(response)) {
			outro("Installation cancelled");
			process.exit(0);
		}

		selectedEditors = response as Editor[];
	}

	if (selectedEditors.length === 0) {
		log.warn("No editors selected.");
		outro("Installation cancelled");
		process.exit(0);
	}

	// Install Neon for selected editors
	const results = await installNeon(homeDir, workspaceDir, selectedEditors);

	const successful: Editor[] = [];
	const failed: Editor[] = [];

	for (const [editor, status] of results.entries()) {
		if (status === "success") {
			successful.push(editor);
		} else {
			failed.push(editor);
		}
	}

	// Install agent skills for successful installations
	if (successful.length > 0) {
		await installAgentSkills(successful);
	}

	// Show different messages based on what was installed
	const extensionEditors = successful.filter(usesExtension);
	const mcpEditors = successful.filter((e) => !usesExtension(e));
	const failedExtensionEditors = failed.filter(usesExtension);
	const failedMcpEditors = failed.filter((e) => !usesExtension(e));

	if (extensionEditors.length > 0) {
		const extSuccessList = extensionEditors.join(" / ");
		log.step(
			`Neon Local Connect extension installed for ${extSuccessList}.\n`,
		);
	}

	if (mcpEditors.length > 0) {
		const mcpSuccessList = mcpEditors.join(" / ");
		log.step(
			`Neon MCP Server is now ready to use with ${mcpSuccessList}.\n`,
		);
	}

	// Show helpful installation links for failed extension installations
	if (failedExtensionEditors.length > 0) {
		log.info(
			"Failed to install extension. For the best local development experience, install Neon Local Connect manually:",
		);
		for (const editor of failedExtensionEditors) {
			if (editor === "VS Code") {
				log.info(
					"  • VS Code: https://marketplace.visualstudio.com/items?itemName=databricks.neon-local-connect",
				);
			} else if (editor === "Cursor") {
				log.info(
					"  • Cursor: https://open-vsx.org/extension/databricks/neon-local-connect",
				);
			}
		}
	}

	if (failedMcpEditors.length > 0) {
		log.error(
			`Failed to configure MCP Server for ${failedMcpEditors.join(" / ")}`,
		);
	}

	// Exit with error if all installations failed
	if (successful.length === 0) {
		outro(
			"Installation cancelled or failed. Please check the output above and try again.",
		);
		process.exit(1);
	}

	if (extensionEditors.length > 0 && mcpEditors.length === 0) {
		// Only extension editors (VS Code/Cursor)
		const extSuccessList = extensionEditors.join(" / ");
		note(
			`\x1b[0mRestart ${extSuccessList}, open the Neon extension and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in your agent chat`,
			"What's next?",
		);
	} else if (mcpEditors.length > 0 && extensionEditors.length === 0) {
		// Only MCP editors (Claude CLI)
		const mcpSuccessList = mcpEditors.join(" / ");
		note(
			`\x1b[0mRestart ${mcpSuccessList} and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in the chat`,
			"What's next?",
		);
	} else {
		// Mixed editors
		note(
			`\x1b[0mFor ${extensionEditors.join(" / ")}: Restart, open the Neon extension and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in your agent chat\n\x1b[0mFor ${mcpEditors.join(" / ")}: Restart and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in the chat`,
			"What's next?",
		);
	}

	outro("Have feedback? Email us at feedback@neon.tech");
}
