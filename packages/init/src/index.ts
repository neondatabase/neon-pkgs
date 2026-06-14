import { intro, isCancel, log, multiselect, note, outro } from "@clack/prompts";
import { bold, cyan } from "yoctocolors";
import { ALL_CONFIGURABLE_AGENTS } from "./lib/agents.js";
import { isAuthenticated } from "./lib/auth.js";
import { detectAvailableEditors } from "./lib/editors.js";
import { usesExtension } from "./lib/extension.js";
import { installNeon } from "./lib/install.js";
import { neonctlCmd } from "./lib/neonctl.js";
import {
	fetchSkillContent,
	installAgentSkills,
	SKILL_REFERENCE_URLS,
} from "./lib/skills.js";
import type { Editor, InitResult } from "./lib/types.js";

export type { InteractiveInitOptions } from "./interactive.js";
export { interactiveInit } from "./interactive.js";
export { detectAgent } from "./lib/detect-agent.js";
export { enrichResponse } from "./lib/enrich-output.js";
export { handleAuthPhase } from "./lib/phases/auth.js";
export { handleDbPhase } from "./lib/phases/db.js";
export { handleMcpPhase } from "./lib/phases/mcp.js";
export { handleMigrationsPhase } from "./lib/phases/migrations.js";
export { handleNeonAuthPhase } from "./lib/phases/neon-auth.js";
export { handleSkillsPhase } from "./lib/phases/skills.js";
export { handleStatusPhase } from "./lib/phases/status.js";
export { routeDataStep } from "./lib/route-command.js";
// v2 exports
export type {
	AgentActionAction,
	AgentCheck,
	AgentCheckAction,
	AgentStep,
	AskUserAction,
	CompleteAction,
	InitResult,
	NextAction,
	Phase,
	PhaseResponse,
	RestartRequiredAction,
	RunCommandAction,
	RunNeonInitAction,
	StatusResponse,
} from "./lib/types.js";
export type { OrchestratorOptions } from "./v2.js";
export { orchestrate } from "./v2.js";

export interface InitOptions {
	/** When set, configures only this agent and skips the editor selection prompt. */
	agent?: Editor;
	/** When true, suppresses interactive UI and returns structured JSON-friendly output. */
	json?: boolean;
}

function getNeonctlCommands() {
	const base = "npx neonctl";
	return {
		listOrgs: `${base} orgs list --output json`,
		listProjects: `${base} projects list --output json`,
		createProject: `${base} projects create --name <project-name> --output json`,
		getConnectionString: `${base} connection-string --project-id <project-id>`,
	};
}

function getAuthInstructions(): string {
	const cmd = neonctlCmd();
	const signupUrl = process.env.NEON_API_HOST
		? `${new URL(process.env.NEON_API_HOST).origin}/signup`
		: "https://console.neon.tech/signup";
	return [
		"YOU (the agent) must handle authentication. Do NOT ask the user to run commands themselves.",
		"Do NOT write wrapper scripts (Python, shell, etc.) — use simple shell commands only.",
		"IMPORTANT: Unset the CI environment variable for all neonctl commands below,",
		"otherwise neonctl will refuse to open the browser.",
		"",
		'Step 1: Ask the user: "Do you already have a Neon account, or do you need to create one?"',
		"",
		"=== NEW ACCOUNT (sign up) ===",
		"Step 2a: Open the Neon sign-up page in the user's browser:",
		`   On macOS: open ${signupUrl}`,
		`   On Linux: xdg-open ${signupUrl}`,
		"Step 3a: Tell the user: \"I've opened the Neon sign-up page in your browser.",
		"   Create your account, then check your email for a verification link and click it.",
		'   Let me know when you have finished signing up and verifying your email."',
		"Step 4a: Once the user confirms, run the OAuth login:",
		`   ${cmd} auth`,
		"   This opens a second browser tab for OAuth authorization. The user approves access.",
		"   If exit code 0: authentication succeeded.",
		"   If exit code 2 (timeout): ask the user to confirm they finished sign-up and",
		"   email verification, then retry the same command.",
		"",
		"=== EXISTING ACCOUNT (sign in) ===",
		`Step 2b: Execute: ${cmd} auth`,
		"   This opens the OAuth login page directly. Sign-in is fast (60-second timeout).",
		"   If exit code 0: authentication succeeded.",
		"   If exit code 2 (timeout): ask the user to confirm they completed sign-in, then retry.",
		"",
		"=== AFTER SUCCESSFUL AUTH ===",
		`Step 5: Verify by running: ${cmd} me`,
		"   This should print the user's account info and exit with code 0.",
		"Step 6: Re-run neonctl init with the same --agent and --json flags to complete setup.",
	].join("\n");
}

function buildAgentInstructions(refs: Record<string, string>): string {
	return [
		"IMPORTANT: Follow these steps to set up the Neon project. Do NOT skip steps.",
		"",
		"CRITICAL — SKILL REFERENCES: The URLs in skills.references are authoritative",
		"implementation guides with exact import paths, component patterns, route structures,",
		"and common mistakes to avoid. You MUST fetch and read the relevant skill reference",
		"URL BEFORE writing any code that uses that Neon feature. Do NOT rely on general",
		"documentation pages (e.g. /docs/guides/*) or guess at import paths — the skill",
		"references are more accurate, complete, and agent-optimized.",
		"",
		`1. List organizations: ${getNeonctlCommands().listOrgs}`,
		"   - If one org, use it. If multiple, ask the user which to use.",
		`2. List projects: ${getNeonctlCommands().listProjects} (add --org-id <org-id>)`,
		"   - No projects: ask if they want to create a new one.",
		"   - One project: ask if they want to use it or create new.",
		"   - Multiple: let the user choose.",
		`3. Create project if needed: ${getNeonctlCommands().createProject} (add --org-id <org-id>)`,
		`4. Get connection string: ${getNeonctlCommands().getConnectionString}`,
		"5. Store in .env as DATABASE_URL (append, don't overwrite existing .env).",
		"6. For apps with user login/auth: STOP. Before writing any auth code, fetch and",
		`   read this skill reference: ${refs.neonAuth ?? ""}`,
		"   It contains the exact packages, imports, component layout, route patterns,",
		"   environment variables, and common mistakes. Follow it precisely.",
		`7. For connection method/driver, fetch and read: ${refs.connectionMethods ?? ""}`,
		"8. Refer to skills.gettingStarted for the full setup guide with additional details.",
		"",
		"Do NOT auto-create a project without asking the user first.",
	].join("\n");
}

/**
 * Initialize Neon projects with MCP Server
 */
export async function init(options?: InitOptions): Promise<InitResult> {
	const jsonMode = options?.json === true;

	const makeFailedResult = (auth: boolean): InitResult => ({
		success: false,
		auth,
		editors: [],
		skills: {
			installed: false,
			gettingStarted: null,
			references: {},
		},
		neonctl: {
			authenticated: auth,
			commands: { ...getNeonctlCommands() },
		},
		mcpServer: {
			configured: false,
			requiresRestart: false,
		},
	});

	if (!jsonMode) {
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
	}

	const homeDir = process.env.HOME || process.env.USERPROFILE;
	if (!homeDir) {
		if (!jsonMode) {
			log.error("Could not determine home directory");
			outro("📣 Is this unexpected? Email us at feedback@neon.tech");
		}
		return makeFailedResult(false);
	}

	let selectedEditors: Editor[];

	if (options?.agent !== undefined) {
		selectedEditors = [options.agent];
	} else {
		if (jsonMode) {
			return makeFailedResult(false);
		}

		const availableEditors = await detectAvailableEditors(homeDir);

		const response = await multiselect({
			message:
				"Which editor(s) would you like to configure? (Space to toggle each option, Enter to confirm your selection)",
			options: ALL_CONFIGURABLE_AGENTS.map((agent) => ({
				value: agent.editor,
				label: agent.editor,
				hint: agent.hint,
			})),
			initialValues: availableEditors,
			required: true,
		});

		if (isCancel(response)) {
			outro("Installation cancelled");
			return makeFailedResult(false);
		}

		selectedEditors = response as Editor[];
	}

	if (selectedEditors.length === 0) {
		if (!jsonMode) {
			log.warn("No editors selected.");
			outro("Installation cancelled");
		}
		return makeFailedResult(false);
	}

	// In JSON mode, check for existing credentials before attempting OAuth.
	// neonctl's OAuth has a 60s timeout and email verification breaks the redirect,
	// so we let the agent handle auth as a separate step.
	if (jsonMode) {
		const hasCredentials = await isAuthenticated();
		if (!hasCredentials) {
			const { gettingStarted: _gs, ...otherRefs } = SKILL_REFERENCE_URLS;
			const gettingStartedContent = await fetchSkillContent();

			return {
				success: false,
				auth: false,
				authRequired: true,
				authInstructions: getAuthInstructions(),
				editors: [],
				skills: {
					installed: false,
					gettingStarted: gettingStartedContent,
					references: otherRefs,
				},
				neonctl: {
					authenticated: false,
					commands: { ...getNeonctlCommands() },
				},
				mcpServer: {
					configured: false,
					requiresRestart: false,
				},
			};
		}
	}

	const { results, authSuccess } = await installNeon(selectedEditors, {
		json: jsonMode,
	});

	const successful: Editor[] = [];
	const failed: Editor[] = [];

	for (const [editor, status] of results.entries()) {
		if (status === "success") {
			successful.push(editor);
		} else {
			failed.push(editor);
		}
	}

	let skillsInstalled = false;
	if (successful.length > 0) {
		skillsInstalled = await installAgentSkills(successful, {
			json: jsonMode,
		});
	}

	// Build the editors array for InitResult
	const editorsResult: InitResult["editors"] = [];
	for (const [editor, status] of results.entries()) {
		editorsResult.push({
			editor,
			status,
			type: usesExtension(editor) ? "extension" : "mcp",
		});
	}

	const mcpConfigured = successful.some((e) => !usesExtension(e));

	if (jsonMode) {
		const { gettingStarted: _gs, ...otherRefs } = SKILL_REFERENCE_URLS;

		const gettingStartedContent = await fetchSkillContent();

		return {
			success: successful.length > 0,
			auth: authSuccess,
			agentInstructions: buildAgentInstructions(otherRefs),
			editors: editorsResult,
			skills: {
				installed: skillsInstalled,
				gettingStarted: gettingStartedContent,
				references: otherRefs,
			},
			neonctl: {
				authenticated: authSuccess,
				commands: { ...getNeonctlCommands() },
			},
			mcpServer: {
				configured: mcpConfigured,
				requiresRestart: mcpConfigured,
			},
		};
	}

	// Interactive UI output (non-json mode)
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
		log.info(
			"You can manually configure the MCP server by running: npx add-mcp https://mcp.neon.tech/mcp",
		);
	}

	if (successful.length === 0) {
		outro(
			"Installation cancelled or failed. Please check the output above and try again.",
		);
		return {
			success: false,
			auth: authSuccess,
			editors: editorsResult,
			skills: { installed: false, gettingStarted: null, references: {} },
			neonctl: {
				authenticated: authSuccess,
				commands: { ...getNeonctlCommands() },
			},
			mcpServer: { configured: false, requiresRestart: false },
		};
	}

	if (extensionEditors.length > 0 && mcpEditors.length === 0) {
		const extSuccessList = extensionEditors.join(" / ");
		note(
			`\x1b[0mRestart ${extSuccessList}, open the Neon extension and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in your agent chat`,
			"What's next?",
		);
	} else if (mcpEditors.length > 0 && extensionEditors.length === 0) {
		const mcpSuccessList = mcpEditors.join(" / ");
		note(
			`\x1b[0mRestart ${mcpSuccessList} and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in the chat`,
			"What's next?",
		);
	} else {
		note(
			`\x1b[0mFor ${extensionEditors.join(" / ")}: Restart, open the Neon extension and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in your agent chat\n\x1b[0mFor ${mcpEditors.join(" / ")}: Restart and type in "${bold(cyan("Get started with Neon"))}\x1b[0m" in the chat`,
			"What's next?",
		);
	}

	outro("Have feedback? Email us at feedback@neon.tech");

	return {
		success: true,
		auth: authSuccess,
		editors: editorsResult,
		skills: {
			installed: skillsInstalled,
			gettingStarted: null,
			references: {},
		},
		neonctl: {
			authenticated: authSuccess,
			commands: { ...getNeonctlCommands() },
		},
		mcpServer: {
			configured: mcpConfigured,
			requiresRestart: mcpConfigured,
		},
	};
}
