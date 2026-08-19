import { unlink } from "node:fs/promises";
import { execa } from "execa";
import {
	agentSupportsProjectMcp,
	getSkillsAgentName,
	resolveAddMcpAgentId,
} from "../agents.js";
import {
	detectIde,
	isCursorInstalled,
	isVSCodeInstalled,
} from "../detect_agent.js";
import { findEditorCommand } from "../extension.js";
import { handoffAction } from "../handoff.js";
import { inspectProject } from "../inspect.js";
import { installNeonMcpServer } from "../install_mcp.js";
import { ensureNeonctl } from "../neonctl.js";
import { ensureSkillsUpToDate } from "../skills.js";
import type { Editor, PhaseResponse } from "../types.js";
import { downloadVsix, NEON_EXTENSION_ID } from "../vsix.js";

export type SetupPhaseOptions = {
	agent?: string;
	/** The IDE/editor the user is running in (e.g. "cursor", "vscode") — reported by agent */
	ide?: string;
	// Inspection results — pre-filled by orchestrator or reported by agent
	mcpConfigured?: boolean | null;
	skillsInstalled?: boolean | null;
	isVscodeIde?: boolean | null;
	// User preferences (also used for pre-detected scope from inspection)
	mode?: string;
	mcpScope?: string;
	skillsScope?: string;
	installExtension?: boolean;
	// Execution flags
	execute?: boolean;
};

/**
 * Setup phase: inspects tooling state, collects install preferences, then
 * batches the MCP server / skills / extension installs together.
 *
 * With --data JSON, the agent sends inspection results AND user preferences in
 * a single call, so the CLI can go straight to installation. Once install
 * finishes, `neon init` hands off to the agent (see {@link handoffAction}) — it
 * does not connect a database or configure features.
 */
export async function handleSetupPhase(
	options: SetupPhaseOptions,
): Promise<PhaseResponse> {
	// --execute: run the batched installation (legacy path)
	if (options.execute) {
		return executeBatchedInstallation(await mergeCliInspection(options));
	}

	// Treat any explicit mode value that isn't "customize"/"custom" as defaults.
	if (
		options.mode &&
		options.mode !== "customize" &&
		options.mode !== "custom"
	) {
		const merged = await mergeCliInspection(options);
		return executeBatchedInstallation({
			...merged,
			mcpScope: merged.mcpScope ?? "global",
			skillsScope: merged.skillsScope ?? "project",
			installExtension: false,
		});
	}

	// User chose "customize" (also accept "custom" — agents sometimes truncate)
	if (options.mode === "customize" || options.mode === "custom") {
		const merged = await mergeCliInspection(options);
		const shouldInstallExt =
			merged.installExtension ?? isVscodeBasedIde(merged);
		return executeBatchedInstallation({
			...merged,
			mcpScope: merged.mcpScope ?? "global",
			skillsScope: merged.skillsScope ?? "project",
			installExtension: shouldInstallExt,
		});
	}

	// Default: send inspection checks with install preferences (all in one response)
	return buildBulkInspection(options);
}

async function buildBulkInspection(
	options: SetupPhaseOptions,
): Promise<PhaseResponse> {
	const detectedIde = detectIde();

	// If no IDE detected (e.g. standalone terminal), check what's installed
	const installedEditors: string[] = [];
	if (!detectedIde) {
		if (isCursorInstalled()) installedEditors.push("cursor");
		if (isVSCodeInstalled()) installedEditors.push("vscode");
	}

	const isPartialSkills = String(options.skillsScope ?? "").includes(
		"partial",
	);
	const needsMcpChoice = !options.mcpConfigured;
	const needsSkillsChoice = !options.skillsInstalled && !isPartialSkills;
	const hasModeQuestion = needsMcpChoice || needsSkillsChoice;

	return {
		phase: "setup",
		status: "pending",
		detectedIde: detectedIde?.toLowerCase() ?? null,
		installedEditors: installedEditors.length > 0 ? installedEditors : null,
		// Pre-detected state from filesystem inspection
		mcpConfigured: options.mcpConfigured ?? null,
		mcpScope: options.mcpScope ?? null,
		skillsInstalled: options.skillsInstalled ?? null,
		skillsScope: options.skillsScope ?? null,
		nextAction: {
			type: "agent_check",
			instructions: [
				"IMPORTANT: Do NOT summarize this response or ask the user for consent/confirmation before starting. Proceed IMMEDIATELY with the agent checks and the first userPreference question.",
				"",
				"Perform the agent checks listed above (MCP server status and your agent identity), then present each userPreference question to the user ONE AT A TIME, in order. Wait for the user's answer before showing the next question. Respect the `condition` field — only show a question if its condition is met.",
				"",
				`The CLI has pre-detected the following from the filesystem: MCP server: ${options.mcpConfigured ? `configured (${options.mcpScope})` : "not configured"}. Agent skills: ${options.skillsInstalled ? `installed (${options.skillsScope})` : isPartialSkills ? `partially installed (${options.skillsScope}) — missing skills will be auto-installed to the same scope` : "not installed"}. Report these findings to the user before asking preferences. Only ask about scope/options for components that are NOT already configured. Do NOT ask about skills scope if skills are partially installed — they will be completed automatically.`,
				"",
				"IMPORTANT (Cursor users): Cursor disables project-level MCP servers by default as a security measure. If the user is in Cursor and chooses project-level MCP scope, warn them that they will need to manually enable the Neon server in Cursor Settings > MCP after installation. Recommend global scope for Cursor to avoid this extra step.",
				"",
				"GROUPING: Preferences that share the same `group` field should be presented together in a single message (e.g. list all customize options at once and let the user answer them together). Preferences without a `group` must be asked individually.",
				"",
				detectedIde
					? `The CLI has detected the IDE as: ${detectedIde.toLowerCase()}. Include this as the "ide" field in your reportBack data. IMPORTANT: The IDE and the agent are different — you may be Claude Code (agent) running inside Cursor (IDE). The extension installs into the IDE, so if the IDE is Cursor/VS Code/Windsurf, the extension IS applicable even if you are Claude Code.`
					: installedEditors.length > 0
						? `No IDE detected, but the following editors are installed: ${installedEditors.join(", ")}. The "installedEditors" field in this response lists them. If the user wants the extension installed, ask which editor to install it for and include that as the "ide" field in your reportBack data. If not, set "ide" to "none".`
						: `No IDE or supported editors detected. Set "ide" to "none" in your reportBack data.`,
				"",
				"After all questions are answered, call reportBack with a single --data JSON containing: agent, ide, mcpConfigured, and all preference answers. The CLI will inspect the project and merge results automatically.",
			].join("\n"),
			checks: [
				{
					id: "neonctl",
					description:
						"The Neon CLI will be installed or updated automatically (no action needed from the agent)",
					lookFor: [],
				},
				{
					id: "mcp_server",
					description:
						"Check if the Neon MCP server is already configured in your MCP server list",
					lookFor: [
						"An MCP server entry named 'Neon' or with URL containing 'mcp.neon.tech'",
					],
				},
				{
					id: "agent_type",
					description:
						"Identify which coding agent is running this command",
					lookFor: [
						"Determine which agent you are: cursor, claude-code, copilot, vscode, windsurf, codex, cline, gemini-cli, goose, opencode, or antigravity",
						"Report your own agent identifier — this is used to configure the MCP server for the correct tool",
					],
				},
				...(detectedIde
					? [
							{
								id: "extension_installed",
								description:
									"Check if the Neon editor extension (databricks.neon-local-connect) is already installed in the IDE (NOT the agent — e.g. if you are Claude Code running inside Cursor, check Cursor's extensions)",
								lookFor: [
									"Run the IDE's --list-extensions command or check installed extensions for 'databricks.neon-local-connect' or 'Neon Local Connect'",
									"If the extension is found, set installExtension to false in your reportBack data and SKIP the installExtension question",
								],
							},
						]
					: []),
			],
			userPreferences: [
				// Only show defaults/customize when there's something to customize:
				// MCP not configured, or skills need a scope choice.
				...(hasModeQuestion
					? [
							{
								id: "mode",
								question: "Use default settings or customize?",
								phase: "after_checks" as const,
								options: [
									{
										value: "defaults",
										label: "Use defaults (MCP: global, skills:project-level, install extension later) (Recommended)",
									},
									{
										value: "customize",
										label: "Customize installation settings",
									},
								],
								default: "defaults",
							},
						]
					: []),
				{
					id: "mcpScope",
					question: "Where should the Neon MCP server be configured?",
					context:
						"SKIP this question entirely if the mcp_server check found it is already configured. Only ask if MCP is NOT yet configured. NOTE: Cursor disables project-level MCP servers by default — if the user is in Cursor, recommend global scope or warn that they will need to manually enable the server in Cursor Settings > MCP.",
					phase: "after_checks" as const,
					options: [
						{
							value: "global",
							label: "Global (available in all projects)",
						},
						{
							value: "project",
							label: "Project-level (scoped to this project only)",
						},
						{
							value: "none",
							label: "Skip — do not install the MCP server",
						},
					],
					default: "global",
					condition: { preferenceId: "mode", equals: "customize" },
					group: "customize",
				},
				// Show skills scope when skills aren't detected and no partial install exists.
				// Partial installations are auto-completed to the same scope silently.
				...(needsSkillsChoice
					? [
							{
								id: "skillsScope",
								question:
									"Where should Neon agent skills be installed?",
								context:
									"Only ask if skills are not already installed.",
								phase: "after_checks" as const,
								options: [
									{
										value: "global",
										label: "Global (available in all projects)",
									},
									{
										value: "project",
										label: "Project-level (scoped to this project only)",
									},
								],
								default: "project",
								condition: {
									preferenceId: "mode",
									equals: "customize",
								},
								group: "customize",
							},
						]
					: []),
				{
					id: "installExtension",
					question:
						"Install the Neon editor extension for local database browsing?",
					phase: "after_checks" as const,
					options: [
						{ value: "true", label: "Yes" },
						{ value: "false", label: "No" },
					],
					default: "true",
					context:
						"The extension installs into the IDE, NOT the agent. If the CLI detected the IDE (see detectedIde field), use that — e.g. Claude Code running inside Cursor means the IDE is Cursor and the extension IS applicable. Only applicable for VS Code-based IDEs (VS Code, Cursor, Windsurf). SKIP this question if the user is NOT in a VS Code-based IDE, or if the extension_installed check found it is already installed. Set installExtension to false in reportBack if skipped.",
					condition: { preferenceId: "mode", equals: "customize" },
					group: "customize",
				},
			],
			reportBack: {
				type: "run_neon_init",
				args: [
					"setup",
					"--json",
					"--data",
					(() => {
						const prefilledSkills =
							options.skillsInstalled || isPartialSkills
								? `, skillsScope: "${options.skillsInstalled ? options.skillsScope || "project" : String(options.skillsScope ?? "").replace("-partial", "")}"`
								: needsSkillsChoice
									? ", skillsScope?: 'global'|'project'"
									: "";
						const modeField = hasModeQuestion
							? ", mode: string"
							: "";
						const mcpField = hasModeQuestion
							? ", mcpScope?: 'global'|'project'|'none'"
							: "";
						const extField = hasModeQuestion
							? ", installExtension?: bool"
							: "";
						return `<json: { agent: string, ide: string, mcpConfigured: bool${prefilledSkills}${modeField}${mcpField}${extField} }>`;
					})(),
				],
			},
		},
	};
}

type InstallResult = {
	id: string;
	description: string;
	status: "success" | "failed";
	error?: string;
	/** True when the step wasn't automated — the description contains manual instructions for the user */
	manualAction?: boolean;
	/** Shell commands the agent can run to complete this step manually */
	commands?: string[];
};

/**
 * Executes the batched installation of MCP server, skills, and extension.
 * Runs commands directly in the CLI process — the agent does NOT run these.
 * Once install finishes, hands off to the agent (see {@link handoffAction}).
 */
async function executeBatchedInstallation(
	options: SetupPhaseOptions,
): Promise<PhaseResponse> {
	const mcpScope = options.mcpScope ?? "global";
	const agentId = options.agent ?? "cursor";
	const mcpAgentId = resolveAddMcpAgentId(agentId);
	const installExt = options.installExtension === true;

	const results: InstallResult[] = [];

	// Step 1: Ensure the Neon CLI is installed and up to date
	const neonctlResult = await ensureNeonctl();
	switch (neonctlResult.status) {
		case "already_current":
			results.push({
				id: "neonctl",
				description: `Neon CLI is up to date (v${neonctlResult.version})`,
				status: "success",
			});
			break;
		case "installed":
			results.push({
				id: "neonctl",
				description: `Installed Neon CLI (v${neonctlResult.version})`,
				status: "success",
			});
			break;
		case "updated":
			results.push({
				id: "neonctl",
				description: `Updated Neon CLI to v${neonctlResult.version}`,
				status: "success",
			});
			break;
		case "failed":
			results.push({
				id: "neonctl",
				description: "Failed to install Neon CLI",
				status: "failed",
				error: neonctlResult.error,
			});
			break;
	}

	// Step 2: Install MCP server (skip if already configured)
	const isCursor =
		mcpAgentId === "cursor" ||
		options.ide?.toLowerCase() === "cursor" ||
		options.agent?.toLowerCase() === "cursor";

	if (mcpScope === "none") {
		results.push({
			id: "skip_mcp",
			description: "Neon MCP server installation skipped by user",
			status: "success",
		});
	} else if (options.mcpConfigured) {
		results.push({
			id: "skip_mcp",
			description: "Neon MCP server already configured",
			status: "success",
		});
	} else {
		const installed = installNeonMcpServer({
			agent: mcpAgentId,
			scope: mcpScope === "project" ? "project" : "global",
			cwd: process.cwd(),
		});
		if (installed.ok) {
			results.push({
				id: "install_mcp",
				description: `Installed Neon MCP server (${mcpScope} scope)`,
				status: "success",
			});

			// Some editors disable newly added MCP servers by default.
			// Cursor: project-level servers are always disabled initially.
			// Claude Code: newly added servers require user approval.
			const isClaudeCode =
				mcpAgentId === "claude-code" ||
				options.agent?.toLowerCase() === "claude-code";

			if (isCursor && mcpScope === "project") {
				results.push({
					id: "enable_mcp",
					description:
						'Cursor disables project-level MCP servers by default. Open Cursor Settings > MCP and toggle the "Neon" server on.',
					status: "success",
					manualAction: true,
				});
			} else if (isClaudeCode) {
				results.push({
					id: "enable_mcp",
					description:
						'Claude Code requires approval for newly added MCP servers. When prompted, approve the "Neon" MCP server to enable it. You can check MCP server status with /mcp in Claude Code.',
					status: "success",
					manualAction: true,
				});
			}
		} else if (installed.unsupported) {
			const projectUnsupported =
				mcpScope === "project" && !agentSupportsProjectMcp(mcpAgentId);
			results.push({
				id: "install_mcp",
				description: installed.error,
				status: projectUnsupported ? "failed" : "success",
				...(projectUnsupported
					? { error: installed.error }
					: { manualAction: true }),
			});
		} else {
			results.push({
				id: "install_mcp",
				description: "Failed to install Neon MCP server",
				status: "failed",
				error: installed.error,
			});
		}
	}

	// Step 3: Install/update skills
	const skillsScope = (options.skillsScope ?? "project") as
		| "global"
		| "project";
	const skillsOk = await ensureSkillsUpToDate(agentId, skillsScope);
	if (skillsOk) {
		results.push({
			id: "install_skills",
			description: "Neon agent skills installed",
			status: "success",
		});
	} else {
		// Build the install commands for the agent to run directly
		// (sandboxed environments may block child process writes). Use the
		// skills-CLI agent name (e.g. vscode → github-copilot), which is what
		// `skills add --agent` expects — not the raw agent id.
		const { getSkillList } = await import("../skills.js");
		const skillList = getSkillList();
		const skillsAgentName = getSkillsAgentName(agentId) ?? agentId;
		const cmds = skillList.map(
			(s) =>
				`skills add neondatabase/agent-skills --skill ${s} --agent ${skillsAgentName}${skillsScope === "global" ? " -g" : ""} -y`,
		);
		results.push({
			id: "install_skills",
			description:
				"Failed to install Neon agent skills automatically. Run these commands to install manually:",
			status: "failed",
			commands: cmds,
		});
	}

	// Step 4: Install editor extension if requested
	// Use the agent-reported IDE (not agent identity) — e.g. Claude Code running in
	// Cursor should install the extension for Cursor, not skip it.
	if (installExt) {
		const extResult = await installExtensionForIde(options.ide ?? agentId);
		results.push(extResult);
	}

	const allSucceeded = results.every((r) => r.status === "success");

	return {
		phase: "setup",
		status: allSucceeded ? "installed" : "partial",
		results,
		nextAction: handoffAction(),
	};
}

/**
 * Fills in the IDE-related inspection fields when the agent didn't report them.
 * Agent-reported data (mcpConfigured, agent, mode, scopes) is preserved.
 */
async function mergeCliInspection(
	options: SetupPhaseOptions,
): Promise<SetupPhaseOptions> {
	// If the agent already told us the IDE, no need to re-inspect.
	if (options.ide !== undefined && options.isVscodeIde !== undefined) {
		return options;
	}

	const inspection = await inspectProject([
		{ id: "ide_type", description: "", lookFor: [] },
	]);

	const ide =
		options.ide?.toLowerCase().replace(/\s+/g, "-") ||
		detectIde()?.toLowerCase().replace(/\s+/g, "-") ||
		undefined;

	return {
		...options,
		ide,
		isVscodeIde:
			options.isVscodeIde ??
			(inspection.isVscodeIde as boolean | undefined),
	};
}

function isVscodeBasedIde(options: SetupPhaseOptions): boolean {
	if (options.ide) {
		const ide = options.ide.toLowerCase();
		return (
			ide === "cursor" ||
			ide === "vscode" ||
			ide === "vs-code" ||
			ide === "windsurf"
		);
	}
	return options.isVscodeIde === true;
}

/**
 * Resolves which IDE to install the extension for.
 * Accepts the agent-reported IDE value (preferred), the agent ID, or
 * falls back to env-var detection.
 */
function resolveEditorForExtension(ideOrAgentId: string): Editor | null {
	// Map known IDE/agent identifiers to Editor types
	switch (ideOrAgentId.toLowerCase()) {
		case "cursor":
			return "Cursor";
		case "vscode":
		case "vs-code":
		case "copilot":
		case "github-copilot":
		case "github-copilot-cli":
			return "VS Code";
		default:
			break;
	}

	// Fall back to env-var detection
	const ide = detectIde();
	if (ide === "Cursor" || ide === "VS Code") return ide;

	return null;
}

const MANUAL_INSTALL_MSG = `Search for "Neon" in the extensions panel (Cmd+Shift+X / Ctrl+Shift+X) and install "Neon Local Connect" by Databricks.`;

/**
 * Installs the Neon extension for the detected IDE.
 *
 * Uses env-var detection to determine the IDE (not the agent identity),
 * so Claude Code running in Cursor correctly installs for Cursor.
 *
 * Strategy:
 * 1. Try `<editor> --install-extension <id>` directly (uses editor's configured marketplace)
 * 2. If that fails, download .vsix (from proxy or Open VSX) and install via local file
 * 3. If all else fails: return manual install instructions
 */
async function installExtensionForIde(agentId: string): Promise<InstallResult> {
	const editorType = resolveEditorForExtension(agentId);
	if (!editorType) {
		return {
			id: "install_extension",
			description: MANUAL_INSTALL_MSG,
			status: "success",
			manualAction: true,
		};
	}

	const editorCmd = await findEditorCommand(editorType);
	if (!editorCmd) {
		return {
			id: "install_extension",
			description: MANUAL_INSTALL_MSG,
			status: "success",
			manualAction: true,
		};
	}

	// Try direct marketplace install first (works if editor has marketplace configured)
	try {
		await execa(editorCmd, ["--install-extension", NEON_EXTENSION_ID], {
			stdio: "pipe",
			timeout: 60000,
		});
		return {
			id: "install_extension",
			description: `Installed Neon extension for ${editorType}`,
			status: "success",
		};
	} catch {
		// Fall through to VSIX download approach
	}

	// Download .vsix and install locally
	const vsixPath = await downloadVsix();
	if (!vsixPath) {
		return {
			id: "install_extension",
			description: MANUAL_INSTALL_MSG,
			status: "success",
			manualAction: true,
		};
	}

	try {
		await execa(editorCmd, ["--install-extension", vsixPath], {
			stdio: "pipe",
			timeout: 60000,
		});
		return {
			id: "install_extension",
			description: `Installed Neon extension for ${editorType}`,
			status: "success",
		};
	} catch {
		return {
			id: "install_extension",
			description: MANUAL_INSTALL_MSG,
			status: "success",
			manualAction: true,
		};
	} finally {
		try {
			await unlink(vsixPath);
		} catch {}
	}
}
