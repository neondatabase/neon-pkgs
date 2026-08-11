/**
 * Interactive v2 CLI — purpose-built guided flow for humans.
 * Uses the same underlying install functions but with a clean clack-based UX.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SelectPrompt } from "@clack/core";
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
import { bold, dim, gray, italic } from "yoctocolors";
import { ALL_CONFIGURABLE_AGENTS, getAddMcpAgentId } from "./agents.js";
import { ensureNeonctlAuth, isAuthenticated } from "./auth.js";
import {
	type BootstrapTemplate,
	FALLBACK_TEMPLATES,
	fetchTemplates,
	type NeonFeature,
	scaffoldTemplate,
} from "./bootstrap.js";
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

// clack box-drawing glyphs, mirrored from @clack/prompts so our custom
// template picker lines up with every other step in the flow.
const S_BAR = "│";
const S_BAR_END = "└";
const S_STEP_ACTIVE = "◆";
const S_STEP_SUBMIT = "◇";
const S_STEP_CANCEL = "■";
const S_RADIO_ACTIVE = "●";
const S_RADIO_INACTIVE = "○";

type TemplateOption = {
	value: string;
	label: string;
	tools?: string[];
	description?: string;
};

const SENTINEL_NONE = "none";

/**
 * Bespoke template picker built on @clack/core's `SelectPrompt`.
 *
 * The stock `@clack/prompts` `select` can only render an option on a single
 * line (title + a parenthesized hint on the focused row), which can't express
 * what we want here: a clean title-only list, and a focused row that expands to
 * `Title (tools)` with the description on its own italic line beneath. Driving
 * the core prompt directly lets us own the frame, so we emit a second
 * gutter-aligned line for the active option only.
 */
async function selectTemplate(
	templates: BootstrapTemplate[],
	message: string,
): Promise<string | symbol> {
	const options: TemplateOption[] = [
		...templates.map((t) => ({
			value: t.id,
			label: t.title,
			tools: t.tools,
			description: t.description,
		})),
		{
			value: SENTINEL_NONE,
			label: "No thanks — continue without scaffolding",
		},
	];

	const green = neonGreenFn;
	// Title sits at column 6 ("│  ● "), so wrapped description lines indent four
	// spaces past the gutter to line up under it.
	const descIndent = "    ";
	const descWidth = Math.max(24, (process.stdout.columns || 80) - 8);

	const renderActive = (option: TemplateOption): string => {
		const tools =
			option.tools && option.tools.length > 0
				? ` ${dim(`(${option.tools.join(", ")})`)}`
				: "";
		const head = `${green(S_RADIO_ACTIVE)} ${option.label}${tools}`;
		if (!option.description) return head;
		const body = wordWrap(option.description, descWidth)
			.split("\n")
			.map((line) => `${green(S_BAR)}${descIndent}${italic(dim(line))}`)
			.join("\n");
		return `${head}\n${body}`;
	};

	const prompt = new SelectPrompt<TemplateOption>({
		options,
		initialValue: options[0]?.value,
		render() {
			const active = this.options[this.cursor];
			const heading = (symbol: string) =>
				`${gray(S_BAR)}\n${symbol}  ${message}\n`;

			if (this.state === "submit") {
				return `${heading(green(S_STEP_SUBMIT))}${gray(S_BAR)}  ${dim(
					active?.label ?? "",
				)}`;
			}
			if (this.state === "cancel") {
				return `${heading(green(S_STEP_CANCEL))}${gray(S_BAR)}  ${dim(
					active?.label ?? "",
				)}\n${gray(S_BAR)}`;
			}

			const body = this.options
				.map((option) =>
					option === active
						? renderActive(option)
						: `${dim(S_RADIO_INACTIVE)} ${dim(option.label)}`,
				)
				.join(`\n${green(S_BAR)}  `);
			return `${heading(green(S_STEP_ACTIVE))}${green(S_BAR)}  ${body}\n${green(
				S_BAR_END,
			)}\n`;
		},
	});

	return prompt.prompt();
}

export type InteractiveInitOptions = {
	preview?: boolean;
	/** Existing project to use — carried into the agent hand-off command. */
	projectId?: string;
	/** Existing org to scope to — carried into the agent hand-off command. */
	orgId?: string;
	/** Branch to target — carried into the agent hand-off command. */
	branchId?: string;
};

export async function interactiveInit(
	options: InteractiveInitOptions = {},
): Promise<void> {
	const restoreColors = patchClackColors();
	try {
		await interactiveInitInner(options);
	} finally {
		restoreColors();
	}
}

async function interactiveInitInner(
	options: InteractiveInitOptions,
): Promise<void> {
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
				"\nLet's get your project set up with Neon. We'll install the MCP server, agent skills, and IDE extension, then connect your app to a database.\n",
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
		{ id: "has_app", description: "", lookFor: [] },
		{ id: "mcp_server", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
		{ id: "connection_string", description: "", lookFor: [] },
		{ id: "project_stack", description: "", lookFor: [] },
		{ id: "migrations", description: "", lookFor: [] },
		{ id: "ide_type", description: "", lookFor: [] },
	]);
	inspectSpinner.stop(dim("Configuration checked ✓"));

	const hasApp = inspection.hasApp === true;
	let selectedFeatures: NeonFeature[] = [];
	let selectedTemplate: BootstrapTemplate | null = null;

	// Preview mode: bootstrap from template if no app detected
	if (options.preview && !hasApp) {
		let templates = FALLBACK_TEMPLATES;
		try {
			const fetched = await fetchTemplates();
			if (fetched && fetched.length > 0) templates = fetched;
		} catch {}

		const templateResult = await selectTemplate(
			templates,
			"No application detected. Would you like to scaffold a new project from a template?",
		);
		if (isCancel(templateResult)) {
			outro("Setup cancelled.");
			return;
		}
		if (templateResult !== "none") {
			selectedTemplate =
				templates.find((t) => t.id === templateResult) ?? null;
			if (selectedTemplate) {
				selectedFeatures = selectedTemplate.requires;
				const bootstrapS = spinner();
				bootstrapS.start(
					`Scaffolding project from template "${selectedTemplate.title}"...`,
				);
				try {
					await scaffoldTemplate(selectedTemplate, ".", {
						onWarn: (message) => log.warn(message),
					});
					bootstrapS.stop(
						dim(
							`Scaffolded project from "${selectedTemplate.title}" ✓`,
						),
					);
				} catch (err) {
					const msg =
						err instanceof Error ? err.message : "Unknown error";
					bootstrapS.stop("Failed to scaffold project");
					log.error(msg);
					outro("Setup failed.");
					return;
				}
			}
		}
	}

	// For brownfield flows (existing app), ask which features to enable
	if (!selectedTemplate && hasApp) {
		const featuresResult = await select({
			message:
				"Which Neon features would you like to enable for this project?",
			options: [
				{ value: "database", label: "Database" },
				{
					value: "database,auth",
					label: "Database + Neon Auth (adds authentication via Neon)",
				},
			],
			initialValue: "database",
		});
		if (isCancel(featuresResult)) {
			outro("Setup cancelled.");
			return;
		}
		selectedFeatures = (featuresResult as string).split(
			",",
		) as NeonFeature[];
	}

	// Write _init metadata to .neon
	if (selectedFeatures.length > 0) {
		const neonPath = resolve(process.cwd(), ".neon");
		let existing: Record<string, unknown> = {};
		if (existsSync(neonPath)) {
			try {
				existing = JSON.parse(readFileSync(neonPath, "utf-8"));
			} catch {}
		}
		existing._init = { features: selectedFeatures };
		writeFileSync(neonPath, `${JSON.stringify(existing, null, 2)}\n`);
	}

	const mcpAlready = inspection.mcpConfigured === true;
	// If we bootstrapped, skills come from the template
	const skillsAlready =
		inspection.skillsInstalled === true || selectedTemplate !== null;
	const hasNeonConnection = inspection.connectionString === true;
	let needsMcp = !mcpAlready;
	const needsSkills = !skillsAlready;
	const needsInstall = needsMcp || needsSkills;

	// Check if .neon context file exists
	const neonContextPath = resolve(process.cwd(), ".neon");
	const hasNeonContext =
		existsSync(neonContextPath) &&
		(() => {
			try {
				const content = JSON.parse(
					readFileSync(neonContextPath, "utf-8"),
				);
				return !!content.projectId;
			} catch {
				return false;
			}
		})();

	// Check if Neon Auth is configured
	const hasNeonAuth = (() => {
		for (const envFile of [".env", ".env.local"]) {
			const envPath = resolve(process.cwd(), envFile);
			if (existsSync(envPath)) {
				try {
					const content = readFileSync(envPath, "utf-8");
					if (/^NEON_AUTH_/m.test(content)) return true;
				} catch {}
			}
		}
		return false;
	})();

	// Check if extension is installed for the detected editor
	let extensionAlready = false;
	if (detectedEditor && usesExtension(detectedEditor)) {
		extensionAlready = await isExtensionInstalled(detectedEditor);
	}

	// If tooling + database are configured, check if there's anything left to do
	if (mcpAlready && skillsAlready && hasNeonConnection && hasNeonContext) {
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
		log.step(dim("Neon database connected ✓"));

		if (hasNeonAuth) {
			log.step(dim("Neon Auth configured ✓"));
			outro(
				dim(
					"Your project is fully configured with Neon. Nothing to do.",
				),
			);
			return;
		}

		// Neon Auth not configured — ask if they want it
		const authResult = await select({
			message:
				"Would you like to set up Neon Auth for user authentication?",
			options: [
				{ value: "yes", label: "Yes, set up Neon Auth" },
				{ value: "no", label: "No, skip for now" },
			],
			initialValue: "no",
		});

		if (isCancel(authResult) || authResult === "no") {
			outro(
				dim(
					`Your project is configured with Neon. You can set up Neon Auth later by having your agent run: neon init --agent --data '{"step":"neon-auth"}'`,
				),
			);
			return;
		}

		// Read .neon for project context
		let projectId: string | null = null;
		try {
			const neonCtx = JSON.parse(readFileSync(neonContextPath, "utf-8"));
			projectId = neonCtx.projectId ?? null;
		} catch {}

		log.step("Next steps");
		const promptLines = ["Set up Neon Auth for this project."];
		if (projectId) promptLines.push(`Project ID: ${projectId}.`);
		log.message(dim("Copy the following into your agent chat:"));
		log.message(
			promptLines.map((line) => bold(neonGreenFn(line))).join("\n"),
		);
		outro(dim("Have feedback? Email us at feedback@neon.tech"));
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
	// Step 3–5: Install what's missing (skip entirely if everything is configured)
	// -----------------------------------------------------------------------
	if (needsInstall) {
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
				nctlS.stop(
					dim(`Installed Neon CLI (v${nctlResult.version}) ✓`),
				);
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
				await installAgentSkills([editor], {
					scope: skillsScope,
					preview: options.preview,
				});
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
		await ensureSkillsUpToDate(
			agentForSkills,
			detectedSkillsScope,
			options.preview,
		);
	}

	// -----------------------------------------------------------------------
	// Step 6: Done — build prompt for the agent to continue
	// -----------------------------------------------------------------------

	// Build the getting-started data payload (same as agent mode)
	const gettingStartedData: Record<string, unknown> = {};
	if (hasNeonConnection) gettingStartedData.hasConnectionString = true;
	if (inspection.framework && inspection.framework !== "none")
		gettingStartedData.framework = inspection.framework;
	if (inspection.orm && inspection.orm !== "none")
		gettingStartedData.orm = inspection.orm;
	if (inspection.migrationTool && inspection.migrationTool !== "none")
		gettingStartedData.migrationTool = inspection.migrationTool;
	if (inspection.migrationDir && inspection.migrationDir !== "none")
		gettingStartedData.migrationDir = inspection.migrationDir;
	if (selectedFeatures.length > 0)
		gettingStartedData.features = selectedFeatures;
	if (options.preview) gettingStartedData.preview = true;
	// Carry any explicitly provided IDs into the hand-off so the agent runs the
	// verified fast path (single `neon link`) instead of the selection flow.
	if (options.projectId) gettingStartedData.projectId = options.projectId;
	if (options.orgId) gettingStartedData.orgId = options.orgId;
	if (options.branchId) gettingStartedData.branchId = options.branchId;

	// Build a prompt for the user to paste into their agent chat
	const cmd = `neon init --agent --data '${JSON.stringify({ step: "getting-started", ...gettingStartedData })}'`;
	// Account for clack's "│  " prefix (3 chars) when wrapping
	const cols = (process.stdout.columns || 80) - 3;
	const promptText = `To finish setting up Neon using Neon's agent-guided onboarding experience, have your agent run this shell command: ${cmd}`;

	log.step("Next steps");
	log.message(dim("Copy the following into your agent chat:"));
	log.message(
		wordWrap(promptText, cols)
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
