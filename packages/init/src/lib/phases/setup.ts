import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";
import { resolveAddMcpAgentId } from "../agents.js";
import {
	FALLBACK_TEMPLATES,
	fetchTemplates,
	findTemplate,
	type NeonFeature,
	scaffoldTemplate,
} from "../bootstrap.js";
import {
	detectIde,
	isCursorInstalled,
	isVSCodeInstalled,
} from "../detect-agent.js";
import { findEditorCommand } from "../extension.js";
import { inspectProject } from "../inspect.js";
import { ensureNeonctl } from "../neonctl.js";
import { ensureSkillsUpToDate } from "../skills.js";
import type { Editor, PhaseResponse } from "../types.js";
import { downloadVsix, NEON_EXTENSION_ID } from "../vsix.js";

export interface SetupPhaseOptions {
	agent?: string;
	/** The IDE/editor the user is running in (e.g. "cursor", "vscode") — reported by agent */
	ide?: string;
	/** Enable preview skills (neon-object-storage, neon-functions, neon-ai-gateway) */
	preview?: boolean;
	/** Whether the directory already contains an application */
	hasApp?: boolean;
	/** Template ID to scaffold (when bootstrapping a new project) */
	template?: string;
	/** Neon features required by the selected template */
	templateRequires?: NeonFeature[];
	/** Neon features selected by the user (brownfield flows) */
	features?: NeonFeature[];
	// Inspection results — pre-filled by orchestrator or reported by agent
	mcpConfigured?: boolean | null;
	skillsInstalled?: boolean | null;
	connectionString?: boolean | null;
	connectionParams?: string; // JSON with host/dbname/etc if found
	framework?: string;
	orm?: string;
	migrationTool?: string;
	migrationDir?: string;
	isVscodeIde?: boolean | null;
	// User preferences (also used for pre-detected scope from inspection)
	mode?: string;
	mcpScope?: string;
	skillsScope?: string;
	installExtension?: boolean;
	// Execution flags
	execute?: boolean;
}

/**
 * Comprehensive setup phase: inspects repo state, collects user preferences,
 * then batches all installation commands together.
 *
 * With --data JSON, the agent sends inspection results AND user preferences
 * in a single call, so the CLI can go straight to installation.
 */
export async function handleSetupPhase(
	options: SetupPhaseOptions,
): Promise<PhaseResponse> {
	// Parse features from comma-separated string (e.g. "database,auth" from agent --data)
	if (typeof options.features === "string") {
		options.features = (options.features as unknown as string)
			.split(",")
			.map((f) => f.trim()) as NeonFeature[];
	}

	// Treat "none" as no template selected
	const templateWasAnswered = options.template !== undefined;
	if (options.template === "none") {
		options.template = undefined;
	}

	// Resolve template requirements if a template was selected but requires not yet populated
	if (options.template && !options.templateRequires) {
		const templates = await fetchTemplates();
		const selected = templates.find((t) => t.id === options.template);
		if (selected) {
			options.templateRequires = selected.requires;
		}
	}

	// --execute: run the batched installation (legacy path)
	if (options.execute) {
		return executeBatchedInstallation(await mergeCliInspection(options));
	}

	// Treat any explicit mode value that isn't "customize"/"custom" as defaults.
	// Also treat as defaults when mode is missing but agent reported back
	// (template was answered, nothing left to customize).
	const hasReportedBack = options.mode || templateWasAnswered;
	if (
		hasReportedBack &&
		options.mode !== "customize" &&
		options.mode !== "custom"
	) {
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

	// Default: send inspection checks with user preferences (all in one response)
	return buildBulkInspection(options);
}

function buildTemplatePreference(
	templates: {
		id: string;
		title: string;
		description: string;
		tools?: string[];
	}[],
) {
	return [
		{
			id: "template",
			question:
				"No application was detected in this directory. Would you like to scaffold a new project from a template?",
			phase: "before_checks" as const,
			options: [
				...templates.map((t) => {
					const tools =
						t.tools && t.tools.length > 0
							? ` (${t.tools.join(", ")})`
							: "";
					return {
						value: t.id,
						label: `${t.title}${tools} — ${t.description}`,
					};
				}),
				{
					value: "none",
					label: "No thanks — continue without scaffolding",
				},
			],
			default: "none",
		},
	];
}

async function buildBulkInspection(
	options: SetupPhaseOptions,
): Promise<PhaseResponse> {
	const hasApp = options.hasApp !== false;
	const detectedIde = detectIde();

	// If no IDE detected (e.g. standalone terminal), check what's installed
	const installedEditors: string[] = [];
	if (!detectedIde) {
		if (isCursorInstalled()) installedEditors.push("cursor");
		if (isVSCodeInstalled()) installedEditors.push("vscode");
	}

	// Fetch available templates when no app is detected
	let templatePreferences: ReturnType<typeof buildTemplatePreference> = [];
	if (!hasApp) {
		let templates = FALLBACK_TEMPLATES;
		try {
			const fetched = await fetchTemplates();
			if (fetched && fetched.length > 0) templates = fetched;
		} catch {}
		templatePreferences = buildTemplatePreference(templates);
	}

	return {
		phase: "setup",
		status: hasApp ? "pending" : "bootstrap_needed",
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
				"IMPORTANT: Do NOT summarize this response or ask the user for consent/confirmation before starting. Proceed IMMEDIATELY with the first userPreference question.",
				"",
				hasApp
					? "Perform the agent checks listed above (MCP server status and your agent identity), then present each userPreference question to the user ONE AT A TIME, in order. Wait for the user's answer before showing the next question. Respect the `condition` field — only show a question if its condition is met."
					: "No application was detected in this directory. Ask the user if they'd like to scaffold a new project from a template (the `template` preference). Present ALL template options and the 'No thanks' option — do NOT auto-select even if there is only one template. If the user selects a template, the scaffolded template includes agent skills so skills installation will be skipped. If the user chooses 'none', continue with the remaining setup preferences normally. Then perform the agent checks and present the remaining preferences ONE AT A TIME.",
				"",
				`The CLI has pre-detected the following from the filesystem: MCP server: ${options.mcpConfigured ? `configured (${options.mcpScope})` : "not configured"}. Agent skills: ${options.skillsInstalled ? `installed (${options.skillsScope})` : String(options.skillsScope ?? "").includes("partial") ? `partially installed (${options.skillsScope}) — missing skills will be auto-installed to the same scope` : "not installed"}. Report these findings to the user before asking preferences. Only ask about scope/options for components that are NOT already configured. Do NOT ask about skills scope if skills are partially installed — they will be completed automatically.`,
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
				...templatePreferences,
				// For brownfield flows, ask which Neon features to enable
				...(hasApp
					? [
							{
								id: "features",
								question:
									"Which Neon features would you like to enable for this project?",
								phase: "after_checks" as const,
								options: [
									{
										value: "database",
										label: "Database (always included)",
									},
									{
										value: "database,auth",
										label: "Database + Neon Auth (adds authentication via Neon)",
									},
								],
								default: "database",
								context:
									"Database connectivity is always set up. Neon Auth adds user authentication powered by Neon. More features (Functions, AI Gateway, Object Storage) will be available soon.",
							},
						]
					: []),
				// Only show defaults/customize when there's something to customize:
				// MCP not configured, skills need scope choice, or extension not detected.
				...(() => {
					const isPartialSkills = String(
						options.skillsScope ?? "",
					).includes("partial");
					const needsMcpChoice = !options.mcpConfigured;
					const needsSkillsChoice =
						!options.skillsInstalled && !isPartialSkills;
					const hasCustomizableOptions =
						needsMcpChoice || needsSkillsChoice;
					if (!hasCustomizableOptions) return [];
					return [
						{
							id: "mode",
							question: "Use default settings or customize?",
							phase: "after_checks" as const,
							options: [
								{
									value: "defaults",
									label: hasApp
										? "Use defaults (Neon CLI, MCP: global, skills: project-level, extension if applicable — already-configured components will be skipped)"
										: "Use defaults (Neon CLI, MCP: global, extension if applicable — skills included in template)",
								},
								{
									value: "customize",
									label: "Customize installation settings",
								},
							],
							default: "defaults",
						},
					];
				})(),
				{
					id: "mcpScope",
					question: "Where should the Neon MCP server be configured?",
					context:
						"SKIP this question entirely if the mcp_server check found it is already configured. Only ask if MCP is NOT yet configured. NOTE: Cursor disables project-level MCP servers by default — if the user is in Cursor, recommend global scope or warn that they will need to manually enable the server in Cursor Settings > MCP.",
					phase: "after_checks",
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
				...(!options.skillsInstalled &&
				!String(options.skillsScope ?? "").includes("partial")
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
					phase: "after_checks",
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
						const partialScope = String(
							options.skillsScope ?? "",
						).replace("-partial", "");
						const hasPartial = String(
							options.skillsScope ?? "",
						).includes("partial");
						const previewFlag = options.preview
							? ", preview: true"
							: "";
						const needsMcpChoice = !options.mcpConfigured;
						const needsSkillsChoice =
							!options.skillsInstalled && !hasPartial;
						const hasModeQuestion =
							needsMcpChoice || needsSkillsChoice;
						const modeField = hasModeQuestion
							? ", mode: string"
							: "";
						const mcpField = hasModeQuestion
							? ", mcpScope?: 'global'|'project'|'none'"
							: "";
						const skillsField = needsSkillsChoice
							? ", skillsScope?: string"
							: "";
						const extField = hasModeQuestion
							? ", installExtension?: bool"
							: "";
						const prefilledSkills =
							options.skillsInstalled || hasPartial
								? `, skillsScope: "${options.skillsInstalled ? options.skillsScope || "project" : partialScope}"`
								: skillsField;
						return `<json: { agent: string, ide: string, mcpConfigured: bool${prefilledSkills}${previewFlag}${modeField}${mcpField}${extField}${hasApp ? ", features?: string" : ", template: string"} }>`;
					})(),
				],
			},
		},
	};
}

function _buildModeQuestion(options: SetupPhaseOptions): PhaseResponse {
	const agentArgs = options.agent ? ["--agent", options.agent] : [];

	// Build a context summary from what the agent found
	const findings: string[] = [];
	if (options.mcpConfigured) {
		findings.push(
			"Neon MCP server is already configured (will be upgraded to evergreen)",
		);
	} else {
		findings.push("Neon MCP server is not configured");
	}
	if (options.connectionString) {
		findings.push("A Neon connection string was found in the project");
	} else {
		findings.push("No Neon connection string found — will need to add one");
	}
	if (options.framework && options.framework !== "none") {
		findings.push(`Framework detected: ${options.framework}`);
	}
	if (options.orm && options.orm !== "none") {
		findings.push(`ORM detected: ${options.orm}`);
	}
	if (options.migrationTool && options.migrationTool !== "none") {
		findings.push(`Migration tool detected: ${options.migrationTool}`);
	}
	if (options.isVscodeIde) {
		findings.push("VS Code-based IDE detected — Neon extension available");
	}

	const inspectionArgs = buildInspectionArgs(options);

	// Build defaults label showing only what will be installed
	const defaultsParts: string[] = ["Neon CLI"];
	if (!options.mcpConfigured) defaultsParts.push("MCP global");
	defaultsParts.push("skills in project");
	if (options.isVscodeIde) defaultsParts.push("install extension");
	const defaultsLabel =
		defaultsParts.length > 0
			? `Use defaults (${defaultsParts.join(", ")})`
			: "Use defaults";

	return {
		phase: "setup",
		status: "preferences_needed",
		inspection: {
			mcpConfigured: options.mcpConfigured,
			connectionString: options.connectionString,
			framework: options.framework,
			orm: options.orm,
			migrationTool: options.migrationTool,
			migrationDir: options.migrationDir,
			isVscodeIde: options.isVscodeIde,
		},
		nextAction: {
			type: "ask_user",
			question: "Use default settings or customize?",
			options: [
				{
					value: "defaults",
					label: defaultsLabel,
				},
				{
					value: "customize",
					label: "Customize installation settings",
				},
			],
			context: `Project inspection results:\n${findings.map((f) => `- ${f}`).join("\n")}`,
			responseMapping: {
				defaults: {
					args: [
						"setup",
						"--json",
						...agentArgs,
						...inspectionArgs,
						"--mode",
						"defaults",
					],
				},
				customize: {
					args: [
						"setup",
						"--json",
						...agentArgs,
						...inspectionArgs,
						"--mode",
						"customize",
					],
				},
			},
		},
	};
}

function _buildCustomizeQuestions(options: SetupPhaseOptions): PhaseResponse {
	const agentArgs = options.agent ? ["--agent", options.agent] : [];
	const inspectionArgs = buildInspectionArgs(options);

	const needsMcp = !options.mcpConfigured;
	const mcpScopes = needsMcp ? ["global", "project", "none"] : ["skip"];
	const skillsScopes = ["global", "project"];
	const extOptions = options.isVscodeIde ? ["ext", "noext"] : ["ext"];

	// Build all combinations of configurable options
	const customOptions: { value: string; label: string }[] = [];
	for (const mcp of mcpScopes) {
		for (const skills of skillsScopes) {
			for (const ext of extOptions) {
				const parts: string[] = [];
				if (mcp === "none") parts.push("Skip MCP");
				else if (mcp !== "skip") parts.push(`MCP: ${mcp}`);
				if (skills !== "skip")
					parts.push(
						`Skills: ${skills === "project" ? "project-level" : skills}`,
					);
				if (options.isVscodeIde) {
					parts.push(
						ext === "ext" ? "Install extension" : "Skip extension",
					);
				}
				customOptions.push({
					value: `${mcp}_${skills}_${ext}`,
					label: parts.join(", "),
				});
			}
		}
	}

	const responseMapping: Record<string, { args: string[] }> = {};

	for (const opt of customOptions) {
		const parts = opt.value.split("_");
		const mcpScope = parts[0] === "skip" ? "global" : parts[0]; // "none" passes through
		const skillsScope = parts[1] === "skip" ? "project" : parts[1];
		const installExt = parts[2] === "ext";

		responseMapping[opt.value] = {
			args: [
				"setup",
				"--json",
				...agentArgs,
				...inspectionArgs,
				"--mode",
				"customize",
				"--mcp-scope",
				mcpScope,
				"--skills-scope",
				skillsScope,
				...(options.isVscodeIde
					? ["--install-extension", installExt ? "true" : "false"]
					: []),
				"--execute",
			],
		};
	}

	return {
		phase: "setup",
		status: "customizing",
		nextAction: {
			type: "ask_user",
			question: "Choose your installation configuration:",
			options: customOptions,
			context:
				"Global scope means settings apply across all your projects. Project-level means settings are scoped to this project only." +
				(options.mcpConfigured
					? "\nSince Neon tools are already installed, they will be upgraded to the latest evergreen version."
					: "") +
				(isCursorAgent(options)
					? "\nNote: Cursor disables project-level MCP servers by default. If you choose project scope, you will need to manually enable the Neon server in Cursor Settings > MCP."
					: ""),
			responseMapping,
		},
	};
}

interface InstallResult {
	id: string;
	description: string;
	status: "success" | "failed";
	error?: string;
	/** True when the step wasn't automated — the description contains manual instructions for the user */
	manualAction?: boolean;
	/** Shell commands the agent can run to complete this step manually */
	commands?: string[];
}

/**
 * Executes the batched installation of MCP server, skills, and extension.
 * Runs commands directly in the CLI process — the agent does NOT run these.
 * Returns results and chains to the getting-started phase.
 */
async function executeBatchedInstallation(
	options: SetupPhaseOptions,
): Promise<PhaseResponse> {
	const mcpScope = options.mcpScope ?? "global";
	const agentId = options.agent ?? "cursor";
	const mcpAgentId = resolveAddMcpAgentId(agentId);
	const installExt = options.installExtension === true;

	const results: InstallResult[] = [];
	const isBootstrap = !!options.template;

	// Step 0: Bootstrap project from template if specified
	if (isBootstrap && options.template) {
		try {
			const templates = await fetchTemplates();
			const template =
				findTemplate(templates, options.template) ??
				findTemplate(FALLBACK_TEMPLATES, options.template);
			if (!template) {
				throw new Error(`Unknown template "${options.template}".`);
			}
			await scaffoldTemplate(template, ".");
			results.push({
				id: "bootstrap",
				description: `Scaffolded project from template "${options.template}"`,
				status: "success",
			});

			// Write template features to .neon under _init (ephemeral, cleaned up when init completes)
			if (options.templateRequires) {
				const neonContextPath = resolve(process.cwd(), ".neon");
				const context: Record<string, unknown> = {
					_init: { features: options.templateRequires },
				};
				writeFileSync(
					neonContextPath,
					`${JSON.stringify(context, null, 2)}\n`,
				);
			}
		} catch (err) {
			results.push({
				id: "bootstrap",
				description: `Failed to scaffold project from template "${options.template}"`,
				status: "failed",
				error: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}

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
		const mcpArgs = [
			"-y",
			"add-mcp",
			"https://mcp.neon.tech/mcp",
			...(mcpScope === "global" ? ["-g"] : []),
			"-n",
			"Neon",
			"-y",
			"-a",
			mcpAgentId,
		];
		try {
			await execa("npx", mcpArgs, { stdio: "pipe", timeout: 60000 });
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
		} catch (err) {
			results.push({
				id: "install_mcp",
				description: "Failed to install Neon MCP server",
				status: "failed",
				error: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}

	// Step 3: Install/update skills (skip when bootstrapping — templates bundle skills)
	if (isBootstrap) {
		results.push({
			id: "install_skills",
			description: "Neon agent skills included in template",
			status: "success",
		});
	} else {
		const skillsScope = (options.skillsScope ?? "project") as
			| "global"
			| "project";
		const skillsOk = await ensureSkillsUpToDate(
			agentId,
			skillsScope,
			options.preview,
		);
		if (skillsOk) {
			results.push({
				id: "install_skills",
				description: "Neon agent skills installed",
				status: "success",
			});
		} else {
			// Build the install commands for the agent to run directly
			// (sandboxed environments may block child process writes)
			const { getSkillList } = await import("../skills.js");
			const skillList = getSkillList(options.preview);
			const cmds = skillList.map(
				(s) =>
					`skills add neondatabase/agent-skills --skill ${s} --agent ${agentId}${skillsScope === "global" ? " -g" : ""} -y`,
			);
			results.push({
				id: "install_skills",
				description:
					"Failed to install Neon agent skills automatically. Run these commands to install manually:",
				status: "failed",
				commands: cmds,
			});
		}
	}

	// Step 4: Install editor extension if requested
	// Use the agent-reported IDE (not agent identity) — e.g. Claude Code running in
	// Cursor should install the extension for Cursor, not skip it.
	if (installExt) {
		const extResult = await installExtensionForIde(options.ide ?? agentId);
		results.push(extResult);
	}

	// Step 5: Write selected features to .neon under _init for brownfield flows
	// (Bootstrap flows already wrote _init in step 0)
	if (!isBootstrap && options.features && options.features.length > 0) {
		const neonContextPath = resolve(process.cwd(), ".neon");
		const context: Record<string, unknown> = {
			_init: { features: options.features },
		};
		writeFileSync(neonContextPath, `${JSON.stringify(context, null, 2)}\n`);
	}

	const allSucceeded = results.every((r) => r.status === "success");

	// Build args to chain to the getting-started phase as a separate CLI call.
	// This ensures the agent gets a clean response with ONLY the getting-started
	// action — no competing "results" array to distract it.
	const gettingStartedData: Record<string, unknown> = {};
	if (options.connectionString) gettingStartedData.hasConnectionString = true;
	if (options.framework) gettingStartedData.framework = options.framework;
	if (options.orm) gettingStartedData.orm = options.orm;
	if (options.migrationTool)
		gettingStartedData.migrationTool = options.migrationTool;
	if (options.migrationDir)
		gettingStartedData.migrationDir = options.migrationDir;
	// Pass features so getting-started knows which phases to chain to
	const resolvedFeatures = options.templateRequires ?? options.features;
	if (resolvedFeatures && resolvedFeatures.length > 0)
		gettingStartedData.features = resolvedFeatures;
	// Bootstrap implies preview mode (new project in us-east required)
	if (isBootstrap) gettingStartedData.preview = true;
	const gettingStartedArgs = [
		"getting-started",
		"--json",
		"--data",
		JSON.stringify(gettingStartedData),
	];

	return {
		phase: "setup",
		status: allSucceeded ? "installed" : "partial",
		results,
		nextAction: {
			type: "run_neon_init",
			args: gettingStartedArgs,
		},
	};
}

function buildInspectionArgs(options: SetupPhaseOptions): string[] {
	const args: string[] = [];
	if (options.mcpConfigured !== null && options.mcpConfigured !== undefined) {
		args.push("--mcp-configured", options.mcpConfigured ? "true" : "false");
	}
	if (
		options.connectionString !== null &&
		options.connectionString !== undefined
	) {
		args.push(
			"--connection-string",
			options.connectionString ? "true" : "false",
		);
	}
	if (options.framework) {
		args.push("--framework", options.framework);
	}
	if (options.orm) {
		args.push("--orm", options.orm);
	}
	if (options.migrationTool) {
		args.push("--migration-tool", options.migrationTool);
	}
	if (options.migrationDir) {
		args.push("--migration-dir", options.migrationDir);
	}
	if (options.isVscodeIde !== null && options.isVscodeIde !== undefined) {
		args.push("--is-vscode-ide", options.isVscodeIde ? "true" : "false");
	}
	return args;
}

/**
 * Fills in missing filesystem inspection fields by running inspectProject().
 * Agent-reported data (mcpConfigured, agent, mode, scopes) is preserved.
 * CLI-detectable fields (framework, orm, migrations, connectionString, isVscodeIde)
 * are filled in only if not already present.
 */
async function mergeCliInspection(
	options: SetupPhaseOptions,
): Promise<SetupPhaseOptions> {
	// If the agent already provided these, no need to re-inspect
	if (options.framework !== undefined && options.orm !== undefined) {
		return options;
	}

	const inspection = await inspectProject([
		{ id: "connection_string", description: "", lookFor: [] },
		{ id: "project_stack", description: "", lookFor: [] },
		{ id: "migrations", description: "", lookFor: [] },
		{ id: "ide_type", description: "", lookFor: [] },
	]);

	// Also detect IDE if not already reported by the agent
	const ide =
		options.ide?.toLowerCase().replace(/\s+/g, "-") ||
		detectIde()?.toLowerCase().replace(/\s+/g, "-") ||
		undefined;

	return {
		...options,
		ide,
		connectionString:
			options.connectionString ??
			(inspection.connectionString as boolean | undefined),
		framework:
			options.framework ?? (inspection.framework as string | undefined),
		orm: options.orm ?? (inspection.orm as string | undefined),
		migrationTool:
			options.migrationTool ??
			(inspection.migrationTool as string | undefined),
		migrationDir:
			options.migrationDir ??
			(inspection.migrationDir as string | undefined),
		isVscodeIde:
			options.isVscodeIde ??
			(inspection.isVscodeIde as boolean | undefined),
	};
}

/**
 * Checks whether the user is in a VS Code-based IDE that supports extensions.
 * Uses agent-reported `ide` field first, then falls back to `isVscodeIde` from inspection.
 */
function isCursorAgent(options: SetupPhaseOptions): boolean {
	const ide = options.ide?.toLowerCase();
	if (ide === "cursor") return true;
	const agent = options.agent?.toLowerCase();
	if (agent === "cursor") return true;
	return false;
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
