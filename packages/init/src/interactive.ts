/**
 * Interactive v2 CLI — purpose-built guided flow for humans.
 * Uses the same underlying install functions but with a clean clack-based UX.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	confirm,
	isCancel,
	log,
	multiselect,
	outro,
	select,
	spinner,
	text,
} from "@clack/prompts";
import { execa } from "execa";
import { bold, dim } from "yoctocolors";
import { ALL_CONFIGURABLE_AGENTS, getAddMcpAgentId } from "./lib/agents.js";
import { ensureNeonctlAuth, isAuthenticated } from "./lib/auth.js";
import { detectAgent } from "./lib/detect-agent.js";
import { detectAvailableEditors } from "./lib/editors.js";
import {
	installExtension,
	isExtensionInstalled,
	usesExtension,
} from "./lib/extension.js";
import { inspectProject } from "./lib/inspect.js";
import { ensureNeonctl } from "./lib/neonctl.js";
import { installAgentSkills } from "./lib/skills.js";
import type { Editor } from "./lib/types.js";

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
	console.log();
	console.log(
		"\x1b[38;2;75;181;120m" +
			[
				" ██╗  ██╗██████╗  ██████╗ ██╗  ██╗",
				" ███╗ ██║██╔═══╝ ██╔═══██╗███╗ ██║",
				" ████╗██║██████╗ ██║   ██║████╗██║",
				" ██╔████║██╔═══╝ ██║   ██║██╔████║",
				" ██║╚███║██████╗ ╚██████╔╝██║╚███║",
				" ╚═╝ ╚══╝╚═════╝  ╚═════╝ ╚═╝ ╚══╝",
			].join("\n") +
			"\x1b[0m",
	);
	console.log(
		dim(
			wordWrap(
				"\nLet's get your project set up with Neon. We'll install the MCP server, agent skills, and IDE extension, then connect your app to a database.\n",
				process.stdout.columns || 80,
			),
		),
	);

	const detectedAgentId = detectAgent();
	const detectedEditor = detectedAgentId
		? agentIdToEditor(detectedAgentId)
		: null;
	let editorList = detectedEditor ?? "your editor";

	// -----------------------------------------------------------------------
	// Step 1: Inspect what's already in place
	// -----------------------------------------------------------------------
	const inspectSpinner = spinner();
	inspectSpinner.start("Checking existing configuration...");
	const inspection = await inspectProject([
		{ id: "mcp_server", description: "", lookFor: [] },
		{ id: "skills", description: "", lookFor: [] },
		{ id: "connection_string", description: "", lookFor: [] },
		{ id: "project_stack", description: "", lookFor: [] },
		{ id: "migrations", description: "", lookFor: [] },
		{ id: "ide_type", description: "", lookFor: [] },
	]);
	inspectSpinner.stop(dim("Configuration checked ✓"));

	const mcpAlready = inspection.mcpConfigured === true;
	const skillsAlready = inspection.skillsInstalled === true;
	const hasNeonConnection = inspection.connectionString === true;
	const needsMcp = !mcpAlready;
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
		log.step(dim("Neon MCP server already configured ✓"));
		log.step(dim("Neon agent skills already installed ✓"));
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
					"Your project is configured with Neon. You can set up Neon Auth later by having your agent run: neon-init neon-auth",
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
	if (mcpAlready) log.step(dim("Neon MCP server already configured ✓"));
	if (skillsAlready) log.step(dim("Neon agent skills already installed ✓"));

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
		let doInstallExtension =
			vscodeEditors.length > 0 && !extensionAlreadyInstalled;

		// Build hint showing only what needs installing
		const hintParts: string[] = [];
		if (needsMcp) hintParts.push("MCP server (global)");
		if (needsSkills) hintParts.push("agent skills (project)");
		if (doInstallExtension) hintParts.push("editor extension");

		// Installation preferences
		let mcpScope: "global" | "project" = "global";
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
						hint: "choose scopes and options",
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
					],
				});
				if (isCancel(scopeResult)) {
					outro("Setup cancelled.");
					return;
				}
				mcpScope = scopeResult as "global" | "project";
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

			if (doInstallExtension) {
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
				outro("Run neon-init again after signing in.");
				return;
			}
			authS.stop("Authenticated.");
		}

		// Ensure neonctl CLI is installed and up to date
		const nctlS = spinner();
		nctlS.start("Checking neonctl CLI...");
		const nctlResult = await ensureNeonctl();
		switch (nctlResult.status) {
			case "already_current":
				nctlS.stop(
					dim(`neonctl CLI is up to date (v${nctlResult.version}) ✓`),
				);
				break;
			case "installed":
				nctlS.stop(
					dim(`Installed neonctl CLI (v${nctlResult.version}) ✓`),
				);
				break;
			case "updated":
				nctlS.stop(
					dim(`Updated neonctl CLI to v${nctlResult.version} ✓`),
				);
				break;
			case "failed":
				nctlS.stop("Failed to install neonctl CLI");
				log.warn(
					"neonctl could not be installed automatically. The setup will continue using npx.",
				);
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

		editorList = selectedEditors.join(", ");
	}

	// -----------------------------------------------------------------------
	// Auth check (needed even if tooling is already installed)
	// -----------------------------------------------------------------------
	const authed = await isAuthenticated();
	if (!authed) {
		const authS = spinner();
		authS.start("Authenticating with Neon...");
		const authSuccess = await ensureNeonctlAuth();
		if (!authSuccess) {
			authS.stop("Authentication failed.");
			outro("Run neon-init again after signing in.");
			return;
		}
		authS.stop("Authenticated.");
	}

	// -----------------------------------------------------------------------
	// Step 6: Collect org/project context for the get-started prompt
	// -----------------------------------------------------------------------
	let orgName: string | null = null;
	let orgId: string | null = null;
	let projectName: string | null = null;
	let projectId: string | null = null;

	const collected = await collectProjectContext();
	if (collected === "cancelled") {
		outro(dim("Setup cancelled."));
		return;
	}
	if (collected === "no_orgs") {
		outro(dim("Run neon-init again after creating an organization."));
		return;
	}
	if (collected) {
		orgName = collected.orgName;
		orgId = collected.orgId;
		projectName = collected.projectName;
		projectId = collected.projectId;
	}

	// Write .neon context file if we have org/project info
	if (orgId || projectId) {
		writeNeonContext({ orgId, projectId });
	}

	// -----------------------------------------------------------------------
	// Step 7: Done — build enhanced get-started prompt
	// -----------------------------------------------------------------------

	// Build multi-line prompt for the user to paste
	const promptLines: string[] = ["Get started with Neon."];
	if (projectId && orgName && orgId) {
		promptLines.push(
			`Use project "${projectName}" (${projectId}) in org ${orgName} (${orgId}).`,
		);
	} else if (orgId && orgName) {
		promptLines.push(`Use org ${orgName} (${orgId}).`);
	}
	const stackParts: string[] = [];
	if (inspection.framework && inspection.framework !== "none") {
		stackParts.push(inspection.framework as string);
	}
	if (inspection.orm && inspection.orm !== "none") {
		if (stackParts.length > 0) {
			promptLines.push(
				`This is a ${stackParts[0]} app that uses ${inspection.orm}.`,
			);
		} else {
			promptLines.push(`This app uses ${inspection.orm}.`);
		}
	} else if (stackParts.length > 0) {
		promptLines.push(`This is a ${stackParts[0]} app.`);
	}

	log.step(`Next steps`);
	log.message(
		dim(
			`Restart ${editorList} to load the Neon MCP server, then copy the following into your agent chat:`,
		),
	);
	log.message(promptLines.map((line) => bold(neonGreenFn(line))).join("\n"));
	outro(dim("Have feedback? Email us at feedback@neon.tech"));
}

// ---------------------------------------------------------------------------
// Collect org/project context to enhance the get-started prompt
// ---------------------------------------------------------------------------

interface ProjectContext {
	orgId: string;
	orgName: string;
	projectId: string | null;
	projectName: string | null;
}

async function collectProjectContext(): Promise<
	ProjectContext | "cancelled" | "no_orgs" | null
> {
	let orgs: { id: string; name: string }[];
	const orgSpinner = spinner();
	orgSpinner.start("Loading organizations...");
	try {
		const result = await execa(
			"npx",
			["-y", "neonctl", "orgs", "list", "--output", "json"],
			{
				stdio: "pipe",
				timeout: 60000,
				env: { ...process.env, CI: undefined },
			},
		);
		orgs = JSON.parse(result.stdout);
		orgSpinner.stop(dim("Organizations loaded ✓"));
	} catch {
		orgSpinner.stop("Failed to load organizations.");
		return null;
	}

	if (orgs.length === 0) {
		log.warn(
			"No Neon organizations found for this account. Visit https://console.neon.tech to create an organization, then run neon-init again.",
		);
		return "no_orgs";
	}

	// Select org
	let orgId: string;
	let orgName: string;
	if (orgs.length === 1) {
		orgId = orgs[0].id;
		orgName = orgs[0].name;
	} else {
		const orgResult = await select({
			message: "Which organization?",
			options: orgs.map((o) => ({ value: o.id, label: o.name })),
		});
		if (isCancel(orgResult)) return "cancelled";
		orgId = orgResult as string;
		orgName = orgs.find((o) => o.id === orgId)?.name ?? orgId;
	}

	// List existing projects
	let projects: { id: string; name: string }[];
	const projSpinner = spinner();
	projSpinner.start("Loading projects...");
	try {
		const result = await execa(
			"npx",
			[
				"-y",
				"neonctl",
				"projects",
				"list",
				"--org-id",
				orgId,
				"--output",
				"json",
			],
			{
				stdio: "pipe",
				timeout: 60000,
				env: { ...process.env, CI: undefined },
			},
		);
		projects = JSON.parse(result.stdout);
		projSpinner.stop(dim("Projects loaded ✓"));
	} catch {
		projSpinner.stop("Failed to load projects.");
		return { orgId, orgName, projectId: null, projectName: null };
	}

	// Choose existing or create new
	const projectOptions: { value: string; label: string; hint?: string }[] = [
		{
			value: "__new__",
			label: "Create a new project",
			hint: "the agent will create it",
		},
		...projects.map((p) => ({ value: p.id, label: p.name, hint: p.id })),
	];

	const projectResult = await select({
		message: "Which Neon project should the agent use?",
		options: projectOptions,
	});
	if (isCancel(projectResult)) return "cancelled";

	if (projectResult === "__new__") {
		const dirName = basename(process.cwd());
		const nameResult = await text({
			message: "What should the new project be called?",
			defaultValue: dirName,
			placeholder: dirName,
		});
		if (isCancel(nameResult)) return "cancelled";

		const projectName = nameResult as string;

		// Create the project now so we have the ID for .neon
		const cs = spinner();
		cs.start(`Creating project "${projectName}"...`);
		try {
			const result = await execa(
				"npx",
				[
					"-y",
					"neonctl",
					"projects",
					"create",
					"--name",
					projectName,
					"--org-id",
					orgId,
					"--output",
					"json",
				],
				{
					stdio: "pipe",
					timeout: 30000,
					env: { ...process.env, CI: undefined },
				},
			);
			const created = JSON.parse(result.stdout);
			const projectId = created.project?.id ?? created.id;
			cs.stop(dim(`Project "${projectName}" created (${projectId}) ✓`));
			return { orgId, orgName, projectId, projectName };
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			cs.stop(`Failed to create project`);
			log.error(msg);
			return { orgId, orgName, projectId: null, projectName };
		}
	}

	const selectedProject = projects.find((p) => p.id === projectResult);
	return {
		orgId,
		orgName,
		projectId: projectResult as string,
		projectName: selectedProject?.name ?? null,
	};
}

// ---------------------------------------------------------------------------
// Maps detectAgent() IDs to Editor types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// .neon context file
// ---------------------------------------------------------------------------

function writeNeonContext(context: {
	orgId: string | null;
	projectId: string | null;
}): void {
	const neonPath = resolve(process.cwd(), ".neon");

	let existing: Record<string, unknown> = {};
	if (existsSync(neonPath)) {
		try {
			existing = JSON.parse(readFileSync(neonPath, "utf-8"));
		} catch {
			// Malformed file — we'll overwrite it
		}
	}

	// Only set fields we have values for; preserve existing fields (e.g. branch)
	const updated = { ...existing };
	if (context.orgId) updated.orgId = context.orgId;
	if (context.projectId) updated.projectId = context.projectId;

	// Check if anything actually changed
	const existingJson = JSON.stringify(existing, null, 2);
	const updatedJson = JSON.stringify(updated, null, 2);
	if (existingJson === updatedJson) {
		return;
	}

	writeFileSync(neonPath, `${updatedJson}\n`);
	if (Object.keys(existing).length > 0) {
		log.step(dim("Updated .neon context file ✓"));
	} else {
		log.step(
			dim("Created .neon context file (safe to commit — no secrets) ✓"),
		);
	}
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
