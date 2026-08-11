/**
 * Interactive v2 CLI — purpose-built guided flow for humans.
 *
 * Installs the Neon tooling (MCP server, agent skills, IDE extension) and stops
 * there. Connecting a database and configuring features is left to the user's
 * agent — which now has the Neon skill — or to a manual `neon link`.
 */

import {
	confirm,
	isCancel,
	log,
	multiselect,
	outro,
	select,
	spinner,
} from "@clack/prompts";
import { execa } from "execa";
import which from "which";
import { bold, dim } from "yoctocolors";
import { ALL_CONFIGURABLE_AGENTS, getAddMcpAgentId } from "./agents.js";
import { ensureNeonctlAuth, isAuthenticated } from "./auth.js";
import { detectAgent, detectIde } from "./detect_agent.js";
import { detectAvailableEditors } from "./editors.js";
import {
	installExtension,
	isExtensionInstalled,
	usesExtension,
} from "./extension.js";
import { inspectProject } from "./inspect.js";
import { ensureNeonctl } from "./neonctl.js";
import { ensureSkillsUpToDate, installAgentSkills } from "./skills.js";
import type { Editor } from "./types.js";

function wordWrap(text: string, width: number): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.length <= width) return line;
			const words = line.split(" ");
			const lines: string[] = [];
			let current = "";
			for (const word of words) {
				if (
					current.length + word.length + 1 > width &&
					current.length > 0
				) {
					lines.push(current);
					current = word;
				} else {
					current = current.length > 0 ? `${current} ${word}` : word;
				}
			}
			if (current.length > 0) lines.push(current);
			return lines.join("\n");
		})
		.join("\n");
}

// Patch picocolors (used by @clack/prompts) to use Neon green instead of cyan/magenta.
// clack hardcodes picocolors.cyan() with no theme API, so this is the least invasive override.
import picocolors from "picocolors";

const neonGreenFn = (s: string) => `\x1b[38;2;75;181;120m${s}\x1b[39m`;
const originalCyan = picocolors.cyan;
const originalMagenta = picocolors.magenta;

function patchClackColors(): () => void {
	const pc = picocolors as unknown as Record<string, unknown>;
	pc.cyan = neonGreenFn;
	pc.magenta = neonGreenFn;
	return () => {
		pc.cyan = originalCyan;
		pc.magenta = originalMagenta;
	};
}

export async function interactiveInit(): Promise<void> {
	const restoreColors = patchClackColors();
	try {
		await interactiveInitInner();
	} finally {
		restoreColors();
	}
}

async function interactiveInitInner(): Promise<void> {
	// Written straight to stdout rather than through `log`, which prefixes
	// every line with a level and goes to stderr — this is the banner of an
	// interactive session, not a diagnostic.
	process.stdout.write(
		`\n\x1b[38;2;75;181;120m${[
			" ██╗  ██╗██████╗  ██████╗ ██╗  ██╗",
			" ███╗ ██║██╔═══╝ ██╔═══██╗███╗ ██║",
			" ████╗██║██████╗ ██║   ██║████╗██║",
			" ██╔████║██╔═══╝ ██║   ██║██╔████║",
			" ██║╚███║██████╗ ╚██████╔╝██║╚███║",
			" ╚═╝ ╚══╝╚═════╝  ╚═════╝ ╚═╝ ╚══╝",
		].join("\n")}\x1b[0m\n`,
	);
	process.stdout.write(
		`${dim(
			wordWrap(
				"\nLet's set up Neon for your AI coding assistant. We'll install the MCP server, agent skills, and IDE extension so your agent can take it from here.\n",
				process.stdout.columns || 80,
			),
		)}\n`,
	);

	const detectedAgentId = detectAgent();
	const detectedEditor = detectedAgentId
		? agentIdToEditor(detectedAgentId)
		: null;

	// -----------------------------------------------------------------------
	// Step 1: Inspect what's already in place
	// -----------------------------------------------------------------------
	const inspectSpinner = spinner();
	inspectSpinner.start("Checking existing configuration...");
	const inspection = await inspectProject([
		{ id: "mcp_server", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
		{ id: "ide_type", description: "", lookFor: [] },
	]);
	inspectSpinner.stop(dim("Configuration checked ✓"));

	const mcpAlready = inspection.mcpConfigured === true;
	const skillsAlready = inspection.skillsInstalled === true;
	let needsMcp = !mcpAlready;
	const needsSkills = !skillsAlready;
	const needsInstall = needsMcp || needsSkills;

	// Check if extension is installed for the detected editor
	let extensionAlready = false;
	if (detectedEditor && usesExtension(detectedEditor)) {
		extensionAlready = await isExtensionInstalled(detectedEditor);
	}

	// Everything already in place — nothing to install.
	if (!needsInstall) {
		log.step(
			dim(
				`Neon MCP server already configured (${inspection.mcpScope || "detected"}) ✓`,
			),
		);
		log.step(
			dim(
				`Neon agent skills already installed (${inspection.skillsScope || "detected"}) ✓`,
			),
		);
		if (extensionAlready)
			log.step(dim("Neon editor extension installed ✓"));
		printNextSteps();
		return;
	}

	// Log what's already in place
	if (mcpAlready)
		log.step(
			dim(
				`Neon MCP server already configured (${inspection.mcpScope || "detected"}) ✓`,
			),
		);
	if (skillsAlready)
		log.step(
			dim(
				`Neon agent skills already installed (${inspection.skillsScope || "detected"}) ✓`,
			),
		);

	// -----------------------------------------------------------------------
	// Step 2: Install what's missing
	// -----------------------------------------------------------------------
	const homeDir = process.env.HOME || process.env.USERPROFILE;
	if (!homeDir) {
		log.error("Could not determine home directory.");
		outro("Setup failed.");
		return;
	}

	let selectedEditors: Editor[];
	if (detectedEditor) {
		selectedEditors = [detectedEditor];
	} else {
		const availableEditors = await detectAvailableEditors(homeDir);
		const editorResponse = await multiselect({
			message: "Which editor(s) would you like to configure?",
			options: ALL_CONFIGURABLE_AGENTS.map((agent) => ({
				value: agent.editor,
				label: agent.editor,
				hint: agent.hint,
			})),
			initialValues: availableEditors,
			required: true,
		});
		if (isCancel(editorResponse)) {
			outro("Setup cancelled.");
			return;
		}
		selectedEditors = editorResponse as Editor[];
		if (selectedEditors.length === 0) {
			log.warn("No editors selected.");
			outro("Setup cancelled.");
			return;
		}
	}

	// Check extension status
	const vscodeEditors = selectedEditors.filter(usesExtension);
	let extensionAlreadyInstalled = false;
	if (vscodeEditors.length > 0) {
		const checks = await Promise.all(
			vscodeEditors.map((e) => isExtensionInstalled(e)),
		);
		extensionAlreadyInstalled = checks.every(Boolean);
		if (extensionAlreadyInstalled) {
			log.step(dim("Neon editor extension already installed ✓"));
		}
	}
	const canInstallExtension =
		vscodeEditors.length > 0 && !extensionAlreadyInstalled;
	let doInstallExtension = false;

	// Build hint showing only what needs installing
	const hintParts: string[] = [];
	if (needsMcp) hintParts.push("MCP server (global)");
	if (needsSkills) hintParts.push("agent skills (project)");

	// Installation preferences
	let mcpScope: "global" | "project" | "none" = "global";
	let skillsScope: "global" | "project" = "project";

	let modeResult: string;
	while (true) {
		const editorName = selectedEditors.join(", ");
		const result = await select({
			message: `Configure ${editorName} for Neon:`,
			options: [
				{
					value: "defaults",
					label: "Install with defaults",
					hint: hintParts.join(", "),
				},
				{
					value: "customize",
					label: "Customize installation",
					hint: canInstallExtension
						? "choose scopes and optional editor extension"
						: "choose scopes and options",
				},
				{
					value: "change_editor",
					label: "Configure a different editor",
				},
			],
			initialValue: "defaults",
		});

		if (isCancel(result)) {
			outro("Setup cancelled.");
			return;
		}

		if (result === "change_editor") {
			const availableEditors = await detectAvailableEditors(homeDir);
			const editorResponse = await multiselect({
				message: "Which editor(s) would you like to configure?",
				options: ALL_CONFIGURABLE_AGENTS.map((agent) => ({
					value: agent.editor,
					label: agent.editor,
					hint: agent.hint,
				})),
				initialValues: availableEditors,
				required: true,
			});
			if (isCancel(editorResponse)) {
				outro("Setup cancelled.");
				return;
			}
			selectedEditors = editorResponse as Editor[];
			if (selectedEditors.length === 0) {
				outro("Setup cancelled.");
				return;
			}
			continue;
		}

		modeResult = result as string;
		break;
	}

	if (modeResult === "customize") {
		if (needsMcp) {
			const scopeResult = await select({
				message: "Where should the Neon MCP server be configured?",
				options: [
					{
						value: "global",
						label: "Global (available in all projects)",
					},
					{
						value: "project",
						label: "Project-level (this project only)",
					},
					{
						value: "none",
						label: "Skip — do not install the MCP server",
					},
				],
			});
			if (isCancel(scopeResult)) {
				outro("Setup cancelled.");
				return;
			}
			mcpScope = scopeResult as "global" | "project" | "none";
			if (mcpScope === "none") needsMcp = false;
		}

		if (needsSkills) {
			const skillsScopeResult = await select({
				message: "Where should Neon agent skills be installed?",
				options: [
					{
						value: "global",
						label: "Global (available in all projects)",
					},
					{
						value: "project",
						label: "Project-level (this project only)",
					},
				],
				initialValue: "project",
			});
			if (isCancel(skillsScopeResult)) {
				outro("Setup cancelled.");
				return;
			}
			skillsScope = skillsScopeResult as "global" | "project";
		}

		if (canInstallExtension) {
			const extResult = await confirm({
				message: `Install the Neon extension for ${vscodeEditors.join(", ")}?`,
			});
			if (isCancel(extResult)) {
				outro("Setup cancelled.");
				return;
			}
			doInstallExtension = extResult;
		}
	}

	// Auth check before install
	const installAuthed = await isAuthenticated();
	if (!installAuthed) {
		const authS = spinner();
		authS.start("Authenticating with Neon...");
		const authSuccess = await ensureNeonctlAuth();
		if (!authSuccess) {
			authS.stop("Authentication failed.");
			outro("Run `neon init` again after signing in.");
			return;
		}
		authS.stop("Authenticated.");
	}

	// Ensure the Neon CLI is installed and up to date
	const nctlS = spinner();
	nctlS.start("Checking Neon CLI...");
	const nctlResult = await ensureNeonctl();
	switch (nctlResult.status) {
		case "already_current":
			nctlS.stop(
				dim(`Neon CLI is up to date (v${nctlResult.version}) ✓`),
			);
			break;
		case "installed":
			nctlS.stop(dim(`Installed Neon CLI (v${nctlResult.version}) ✓`));
			break;
		case "updated":
			nctlS.stop(dim(`Updated Neon CLI to v${nctlResult.version} ✓`));
			break;
		case "failed":
			nctlS.stop("Failed to install Neon CLI");
			log.warn(
				nctlResult.error ??
					"The Neon CLI could not be installed automatically.",
			);
			// Only promise npx when it exists. It ships with npm, so it is
			// gone in exactly the failure where nothing could install
			// globally — but in the ordinary failure (EACCES, registry down)
			// it is there, and saying so is what tells the user setup is not
			// broken.
			if (which.sync("npx", { nothrow: true })) {
				log.warn("Setup will continue using npx.");
			}
			break;
	}

	// Install only what's missing
	for (const editor of selectedEditors) {
		if (needsMcp) {
			const mcpAgentId = getAddMcpAgentId(editor);
			const mcpArgs = [
				"-y",
				"add-mcp",
				"https://mcp.neon.tech/mcp",
				"-n",
				"Neon",
				"-y",
				"-a",
				mcpAgentId,
			];
			if (mcpScope === "global") mcpArgs.splice(5, 0, "-g");

			const mcpS = spinner();
			mcpS.start(`Installing Neon MCP server for ${editor}...`);
			try {
				await execa("npx", mcpArgs, {
					stdio: "pipe",
					timeout: 60000,
				});
				mcpS.stop(
					dim(
						`Neon MCP server configured for ${editor} (${mcpScope}) ✓`,
					),
				);
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Unknown error";
				mcpS.stop(`Failed to configure MCP server for ${editor}`);
				log.error(msg);
			}
		}

		if (needsSkills) {
			await installAgentSkills([editor], { scope: skillsScope });
		}

		if (doInstallExtension && usesExtension(editor)) {
			const extS = spinner();
			extS.start(`Installing Neon extension for ${editor}...`);
			const extOk = await installExtension(editor);
			if (extOk) {
				extS.stop(dim(`Neon extension installed for ${editor} ✓`));
			} else {
				extS.stop(
					`Extension install failed — install manually from the extensions panel.`,
				);
			}
		}
	}

	// Ensure all required skills are present (fills in any missing ones).
	// detectAgent() returns null in a human terminal (TTY), so fall back
	// to IDE detection which works regardless of TTY.
	const ide = detectIde();
	const agentForSkills =
		detectAgent() ??
		(ide === "Cursor"
			? "cursor"
			: ide === "VS Code"
				? "vscode"
				: ide === "Windsurf"
					? "windsurf"
					: null);
	if (agentForSkills) {
		const detectedSkillsScope =
			inspection.skillsScope === "global" ? "global" : undefined;
		await ensureSkillsUpToDate(agentForSkills, detectedSkillsScope);
	}

	printNextSteps();
}

/**
 * `neon init` installs tooling and stops. Point the user at the two ways to go
 * further: let their agent (now equipped with the Neon skill) set things up, or
 * link a project themselves.
 */
function printNextSteps(): void {
	const cols = (process.stdout.columns || 80) - 3;
	log.step("Next steps");
	log.message(
		wordWrap(
			"Neon tooling is installed. To connect a database and configure features (Auth, Object Storage, Functions, AI Gateway), ask your AI agent to set up Neon — it now has the Neon skill and MCP server. Or link a project yourself with `neon link`.",
			cols,
		)
			.split("\n")
			.map((line) => bold(neonGreenFn(line)))
			.join("\n"),
	);
	outro(dim("Have feedback? Email us at feedback@neon.tech"));
}

function agentIdToEditor(agentId: string): Editor | null {
	switch (agentId) {
		case "cursor":
			return "Cursor";
		case "vscode":
			return "VS Code";
		case "claude-code":
			return "Claude CLI";
		case "windsurf":
			// Windsurf not in Editor type yet — fall back to prompt
			return null;
		case "codex":
			return "Codex";
		case "cline":
			return "Cline";
		default:
			return null;
	}
}
