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
import which from "which";
import { bold, dim } from "yoctocolors";
import {
	type AgentType,
	agentSupportsProjectMcp,
	detectInstalledAgents,
	getAgentDisplayName,
	getSkillsAgentName,
	mcpPickerOptions,
	tryResolveAddMcpAgentId,
} from "./agents.js";
import { ensureNeonctlAuth, isAuthenticated } from "./auth.js";
import { detectAgent, detectIde } from "./detect_agent.js";
import { installExtension, isExtensionInstalled } from "./extension.js";
import { inspectProject } from "./inspect.js";
import { installNeonMcpServer } from "./install_mcp.js";
import { ensureNeonctl } from "./neonctl.js";
import {
	ensureSkillsUpToDate,
	installAgentSkills,
	skillsInstalledForAgent,
} from "./skills.js";
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

	const detectedAgent = (() => {
		const raw = detectAgent();
		return raw ? tryResolveAddMcpAgentId(raw) : undefined;
	})();

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

	const mcpHits = inspection.mcpAgents ?? [];
	const detectedHasMcp = detectedAgent
		? mcpHits.some((hit) => hit.agent === detectedAgent)
		: false;
	const mcpAlready = detectedAgent
		? detectedHasMcp
		: inspection.mcpConfigured === true;
	const skillsAlready = detectedAgent
		? skillsInstalledForAgent(detectedAgent, process.cwd())
		: inspection.skillsInstalled === true;
	const needsMcp = !mcpAlready;
	const needsSkills = !skillsAlready;
	const needsInstall = needsMcp || needsSkills;

	let extensionAlready = false;
	const detectedIdeEditor = extensionEditorForAgent(detectedAgent);
	if (detectedIdeEditor) {
		extensionAlready = await isExtensionInstalled(detectedIdeEditor);
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

	let selectedAgents: AgentType[];
	if (detectedAgent) {
		selectedAgents = [detectedAgent];
	} else {
		const picked = await pickAgents();
		if (!picked) {
			outro("Setup cancelled.");
			return;
		}
		selectedAgents = picked;
	}

	let vscodeEditors = extensionEditorsFor(selectedAgents);
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
	let canInstallExtension =
		vscodeEditors.length > 0 && !extensionAlreadyInstalled;
	let doInstallExtension = false;

	// Installation preferences
	let mcpScope: "global" | "project" | "none" = "global";
	let skillsScope: "global" | "project" = "project";

	let modeResult: string;
	while (true) {
		const hintParts: string[] = [];
		if (
			selectedAgents.some(
				(agent) => !mcpHits.some((hit) => hit.agent === agent),
			)
		) {
			hintParts.push("MCP server (global)");
		}
		if (
			selectedAgents.some(
				(agent) =>
					getSkillsAgentName(agent) &&
					!skillsInstalledForAgent(agent, process.cwd()),
			)
		) {
			hintParts.push("agent skills (project)");
		}
		const agentNames = selectedAgents
			.map((id) => getAgentDisplayName(id))
			.join(", ");
		const result = await select({
			message: `Configure ${agentNames} for Neon:`,
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
					label: "Configure a different agent",
				},
			],
			initialValue: "defaults",
		});

		if (isCancel(result)) {
			outro("Setup cancelled.");
			return;
		}

		if (result === "change_editor") {
			const picked = await pickAgents();
			if (!picked) {
				outro("Setup cancelled.");
				return;
			}
			selectedAgents = picked;
			vscodeEditors = extensionEditorsFor(selectedAgents);
			canInstallExtension =
				vscodeEditors.length > 0 && !extensionAlreadyInstalled;
			continue;
		}

		modeResult = result as string;
		break;
	}

	if (modeResult === "customize") {
		const selectedNeedMcp = selectedAgents.some(
			(agent) => !mcpHits.some((hit) => hit.agent === agent),
		);
		if (selectedNeedMcp) {
			const scopeResult = await select({
				message: "Where should the Neon MCP server be configured?",
				options: [
					{
						value: "global",
						label: "Global (available in all projects)",
					},
					...(selectedAgents.every(agentSupportsProjectMcp)
						? [
								{
									value: "project",
									label: "Project-level (this project only)",
								},
							]
						: []),
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
		}

		if (
			selectedAgents.some(
				(agent) =>
					getSkillsAgentName(agent) &&
					!skillsInstalledForAgent(agent, process.cwd()),
			)
		) {
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
	const nctlResult = await ensureNeonctl((phase) => {
		nctlS.message(
			phase === "installing"
				? "Installing Neon CLI..."
				: "Updating Neon CLI...",
		);
	});
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
			nctlS.stop(
				nctlResult.action === "updating"
					? "Failed to update Neon CLI"
					: "Failed to install Neon CLI",
			);
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
	for (const agent of selectedAgents) {
		const label = getAgentDisplayName(agent);
		if (
			mcpScope !== "none" &&
			!mcpHits.some((hit) => hit.agent === agent)
		) {
			const mcpS = spinner();
			mcpS.start(`Installing Neon MCP server for ${label}...`);
			const installed = installNeonMcpServer({
				agent,
				scope: mcpScope === "project" ? "project" : "global",
				cwd: process.cwd(),
			});
			if (installed.ok) {
				mcpS.stop(
					dim(
						`Neon MCP server configured for ${label} (${mcpScope}) ✓`,
					),
				);
			} else if (installed.unsupported) {
				mcpS.stop(`Could not write MCP config for ${label}`);
				log.warn(installed.error);
			} else {
				mcpS.stop(`Failed to configure MCP server for ${label}`);
				log.error(installed.error);
			}
		}

		if (
			getSkillsAgentName(agent) &&
			!skillsInstalledForAgent(agent, process.cwd())
		) {
			await installAgentSkills([agent], { scope: skillsScope });
		}
	}

	if (doInstallExtension) {
		for (const editor of vscodeEditors) {
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

function extensionEditorForAgent(agent: AgentType | undefined): Editor | null {
	if (agent === "cursor") return "Cursor";
	if (agent === "vscode") return "VS Code";
	const ide = detectIde();
	if (ide === "Cursor" || ide === "VS Code") return ide;
	return null;
}

function extensionEditorsFor(selected: AgentType[]): Editor[] {
	const out: Editor[] = [];
	if (selected.includes("cursor")) out.push("Cursor");
	if (selected.includes("vscode")) out.push("VS Code");
	const ide = detectIde();
	if ((ide === "Cursor" || ide === "VS Code") && !out.includes(ide)) {
		out.push(ide);
	}
	return out;
}

async function pickAgents(): Promise<AgentType[] | null> {
	const options = mcpPickerOptions();
	const installed = await detectInstalledAgents();
	const response = await multiselect({
		message: "Which agent(s) would you like to configure?",
		options,
		initialValues: installed.filter((id) =>
			options.some((option) => option.value === id),
		),
		required: true,
	});
	if (isCancel(response)) return null;
	const selected = response as AgentType[];
	if (selected.length === 0) {
		log.warn("No agents selected.");
		return null;
	}
	return selected;
}
