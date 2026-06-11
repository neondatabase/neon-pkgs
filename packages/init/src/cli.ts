#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { interactiveInit } from "./interactive.js";
import { detectAgent } from "./lib/detect-agent.js";
import { handleAuthPhase } from "./lib/phases/auth.js";
import { handleDbPhase } from "./lib/phases/db.js";
import { handleGettingStartedPhase } from "./lib/phases/getting-started.js";
import { handleMcpPhase } from "./lib/phases/mcp.js";
import { handleMigrationsPhase } from "./lib/phases/migrations.js";
import { handleNeonAuthPhase } from "./lib/phases/neon-auth.js";
import { handleSetupPhase } from "./lib/phases/setup.js";
import { handleSkillsPhase } from "./lib/phases/skills.js";
import { handleStatusPhase } from "./lib/phases/status.js";
import { orchestrate } from "./v2.js";

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

const jsonOption = {
	json: {
		type: "boolean" as const,
		default: false,
		description:
			"Output structured JSON for agent consumption. Suppresses interactive UI.",
	},
};

const agentOption = {
	agent: {
		alias: "a",
		type: "string" as const,
		description: "Agent to configure (cursor, copilot, claude, etc.).",
	},
};

// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

/**
 * Resolve the agent ID: use the explicit --agent value if provided,
 * otherwise auto-detect from the environment.
 */
function resolveAgent(explicit: string | undefined): string | undefined {
	return explicit ?? detectAgent() ?? undefined;
}

/**
 * Detects if an AI agent is invoking the CLI programmatically.
 *
 * Uses two signals:
 * 1. Agent-specific env vars (CLAUDECODE, CODEX, CLINE) — unambiguous.
 * 2. IDE env vars (TERM_PROGRAM=cursor) + non-TTY stdin — an IDE terminal
 *    where stdin is piped means an agent spawned us via execa/subprocess.
 *    A human typing in the same terminal would have isTTY=true.
 */
function detectAgentInvocation(): string | null {
	const env = process.env;

	// Agent-specific env vars (always definitive)
	if (
		env.CLAUDECODE === "1" ||
		env.CLAUDE_CODE === "1" ||
		env.CLAUDE_CLI === "1"
	)
		return "claude-code";
	if (env.CODEX === "1") return "codex";
	if (env.CLINE === "1") return "cline";

	// IDE detected + non-interactive stdin = agent spawned us
	if (!process.stdin.isTTY) {
		const ide = detectAgent();
		if (ide) return ide;
	}

	return null;
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const cli = yargs(hideBin(process.argv))
	.scriptName("neon-init")
	.usage("$0 [command] [options]")

	// -----------------------------------------------------------------------
	// Default command: orchestrator (v2 json) or v1 interactive
	// -----------------------------------------------------------------------
	.command(
		"$0",
		"Initialize Neon for your project",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("skip-neon-auth", {
					type: "boolean",
					default: false,
					description: "Skip the Neon Auth setup phase.",
				})
				.option("skip-migrations", {
					type: "boolean",
					default: false,
					description: "Skip the migrations phase.",
				})
				.option("preview", {
					type: "boolean",
					default: false,
					description:
						"Enable preview features (e.g. project bootstrapping from templates).",
				}),
		async (argv) => {
			const detectedAgent = detectAgentInvocation();
			const agent = resolveAgent(
				argv.agent ?? detectedAgent ?? undefined,
			);
			const jsonMode =
				argv.json || argv.agent !== undefined || detectedAgent !== null;

			if (jsonMode) {
				// v2: agent-driven state machine
				const result = await orchestrate({
					agent,
					skipNeonAuth: argv.skipNeonAuth,
					skipMigrations: argv.skipMigrations,
					preview: argv.preview,
				});
				outputJson(result);
				process.exit(0);
			}

			// v2 interactive mode — same phase logic, driven by terminal prompts
			await interactiveInit({ preview: argv.preview });
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// auth
	// -----------------------------------------------------------------------
	.command(
		"auth",
		"Manage Neon platform authentication",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("method", {
					type: "string",
					choices: ["existing", "new"] as const,
					description:
						'Auth method: "existing" for OAuth sign-in, "new" for sign-up flow.',
				})
				.option("verify", {
					type: "boolean",
					default: false,
					description:
						"Just check if authentication is valid, don't initiate a flow.",
				}),
		async (argv) => {
			const result = await handleAuthPhase({
				agent: resolveAgent(argv.agent),
				method: argv.method as "existing" | "new" | undefined,
				verify: argv.verify,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// mcp
	// -----------------------------------------------------------------------
	.command(
		"mcp",
		"Manage the Neon MCP server",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("status", {
					type: "boolean",
					default: false,
					description: "Check if the MCP server is configured.",
				})
				.option("install", {
					type: "boolean",
					default: false,
					description: "Install or update the MCP server.",
				})
				.option("update", {
					type: "boolean",
					default: false,
					description: "Alias for --install.",
				})
				.option("scope", {
					type: "string",
					choices: ["global", "project"] as const,
					default: "global",
					description: "Where to configure the MCP server.",
				})
				.option("mcp-configured", {
					type: "string",
					description:
						"Agent reports MCP detection result (true|false).",
				}),
		async (argv) => {
			let mcpConfigured: boolean | null = null;
			if (argv.mcpConfigured === "true") mcpConfigured = true;
			else if (argv.mcpConfigured === "false") mcpConfigured = false;

			const result = await handleMcpPhase({
				agent: resolveAgent(argv.agent),
				status: argv.status,
				install: argv.install || argv.update,
				scope: argv.scope as "global" | "project",
				mcpConfigured,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// skills
	// -----------------------------------------------------------------------
	.command(
		"skills",
		"Manage Neon agent skills",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("status", {
					type: "boolean",
					default: false,
					description: "Check if skills are installed.",
				})
				.option("install", {
					type: "boolean",
					default: false,
					description: "Install agent skills.",
				})
				.option("update", {
					type: "boolean",
					default: false,
					description: "Update agent skills to latest.",
				}),
		async (argv) => {
			const result = await handleSkillsPhase({
				agent: resolveAgent(argv.agent),
				status: argv.status,
				install: argv.install,
				update: argv.update,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// setup (comprehensive inspection + batched install)
	// -----------------------------------------------------------------------
	.command(
		"setup",
		"Inspect project and batch-install Neon tooling (MCP, skills, extension)",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("data", {
					type: "string",
					description:
						"JSON object with inspection results and user preferences (replaces individual flags).",
				})
				.option("mcp-configured", {
					type: "string",
					description:
						"Agent reports MCP detection result (true|false).",
				})
				.option("connection-string", {
					type: "string",
					description:
						"Agent reports if a connection string was found (true|false).",
				})
				.option("connection-params", {
					type: "string",
					description:
						"JSON with connection parameters found by agent.",
				})
				.option("framework", {
					type: "string",
					description: "Framework detected by agent.",
				})
				.option("orm", {
					type: "string",
					description: "ORM detected by agent.",
				})
				.option("migration-tool", {
					type: "string",
					description:
						"Migration tool detected by agent (prisma|drizzle|knex|none).",
				})
				.option("migration-dir", {
					type: "string",
					description: "Migration directory detected by agent.",
				})
				.option("is-vscode-ide", {
					type: "string",
					description:
						"Agent reports if user is in a VS Code-based IDE (true|false).",
				})
				.option("mode", {
					type: "string",
					choices: ["defaults", "customize"] as const,
					description: "Installation mode chosen by user.",
				})
				.option("mcp-scope", {
					type: "string",
					choices: ["global", "project"] as const,
					description: "Where to install MCP server.",
				})
				.option("skills-scope", {
					type: "string",
					choices: ["global", "project"] as const,
					description: "Where to install skills.",
				})
				.option("install-extension", {
					type: "string",
					description:
						"Whether to install VS Code extension (true|false).",
				})
				.option("execute", {
					type: "boolean",
					default: false,
					description:
						"Execute the batched installation with given options.",
				}),
		async (argv) => {
			// --data JSON path: parse and pass directly to handleSetupPhase
			if (argv.data) {
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(argv.data);
				} catch {
					console.error(
						"Invalid JSON in --data flag. Expected a JSON object.",
					);
					process.exit(1);
					return;
				}

				// Normalize string booleans from preference answers (e.g. "true" → true)
				for (const key of [
					"mcpConfigured",
					"connectionString",
					"isVscodeIde",
					"installExtension",
					"execute",
				]) {
					if (data[key] === "true") data[key] = true;
					else if (data[key] === "false") data[key] = false;
				}

				const result = await handleSetupPhase({
					agent: resolveAgent(argv.agent),
					...data,
				} as import("./lib/phases/setup.js").SetupPhaseOptions);
				outputJson(result);
				process.exit(0);
				return;
			}

			// Legacy individual flags path
			let mcpConfigured: boolean | null = null;
			if (argv.mcpConfigured === "true") mcpConfigured = true;
			else if (argv.mcpConfigured === "false") mcpConfigured = false;

			let connectionString: boolean | null = null;
			if (argv.connectionString === "true") connectionString = true;
			else if (argv.connectionString === "false")
				connectionString = false;

			let isVscodeIde: boolean | null = null;
			if (argv.isVscodeIde === "true") isVscodeIde = true;
			else if (argv.isVscodeIde === "false") isVscodeIde = false;

			const result = await handleSetupPhase({
				agent: resolveAgent(argv.agent),
				mcpConfigured,
				connectionString,
				connectionParams: argv.connectionParams,
				framework: argv.framework,
				orm: argv.orm,
				migrationTool: argv.migrationTool,
				migrationDir: argv.migrationDir,
				isVscodeIde,
				mode: argv.mode as "defaults" | "customize" | undefined,
				mcpScope: argv.mcpScope as "global" | "project" | undefined,
				skillsScope: argv.skillsScope as
					| "global"
					| "project"
					| undefined,
				installExtension: argv.installExtension === "true",
				execute: argv.execute,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// getting-started
	// -----------------------------------------------------------------------
	.command(
		"getting-started",
		"Start the Get Started with Neon workflow",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("data", {
					type: "string",
					description:
						"JSON object with project context (hasConnectionString, framework, orm, migrationTool, migrationDir).",
				})
				.option("has-connection-string", {
					type: "boolean",
					default: false,
					description: "Whether a connection string was found.",
				})
				.option("framework", {
					type: "string",
					description: "Framework detected by agent.",
				})
				.option("orm", {
					type: "string",
					description: "ORM detected by agent.",
				})
				.option("migration-tool", {
					type: "string",
					description: "Migration tool in use.",
				})
				.option("migration-dir", {
					type: "string",
					description: "Migration directory path.",
				}),
		async (argv) => {
			if (argv.data) {
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(argv.data);
				} catch {
					console.error("Invalid JSON in --data flag.");
					process.exit(1);
					return;
				}
				const result = await handleGettingStartedPhase({
					agent: resolveAgent(argv.agent),
					...data,
				} as import("./lib/phases/getting-started.js").GettingStartedPhaseOptions);
				outputJson(result);
				process.exit(0);
				return;
			}

			const result = await handleGettingStartedPhase({
				agent: resolveAgent(argv.agent),
				hasConnectionString: argv.hasConnectionString,
				framework: argv.framework,
				orm: argv.orm,
				migrationTool: argv.migrationTool,
				migrationDir: argv.migrationDir,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// db
	// -----------------------------------------------------------------------
	.command(
		"db",
		"Set up a Neon database project",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("org-id", {
					type: "string",
					description: "Pre-select a Neon organization.",
				})
				.option("project-id", {
					type: "string",
					description: "Pre-select a Neon project.",
				})
				.option("orgs-result", {
					type: "string",
					description:
						"JSON output from neonctl orgs list (agent passes back).",
				})
				.option("projects-result", {
					type: "string",
					description:
						"JSON output from neonctl projects list (agent passes back).",
				})
				.option("framework", {
					type: "string",
					description: "Framework detected by agent.",
				})
				.option("orm", {
					type: "string",
					description: "ORM detected by agent.",
				})
				.option("error", {
					type: "string",
					description: "Error from a previous step.",
				}),
		async (argv) => {
			const result = await handleDbPhase({
				agent: resolveAgent(argv.agent),
				orgId: argv.orgId,
				projectId: argv.projectId,
				orgsResult: argv.orgsResult,
				projectsResult: argv.projectsResult,
				framework: argv.framework,
				orm: argv.orm,
				error: argv.error,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// neon-auth
	// -----------------------------------------------------------------------
	.command(
		"neon-auth",
		"Set up Neon Auth (user authentication for your app)",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("setup", {
					type: "boolean",
					default: false,
					description: "Begin the Neon Auth setup flow.",
				})
				.option("info", {
					type: "boolean",
					default: false,
					description:
						"Return information about Neon Auth without setting it up.",
				})
				.option("project-id", {
					type: "string",
					description: "Neon project ID to configure.",
				}),
		async (argv) => {
			const result = await handleNeonAuthPhase({
				agent: resolveAgent(argv.agent),
				setup: argv.setup,
				info: argv.info,
				projectId: argv.projectId,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// migrations
	// -----------------------------------------------------------------------
	.command(
		"migrations",
		"Detect and manage database migrations",
		(y) =>
			y
				.options(jsonOption)
				.options(agentOption)
				.option("tool", {
					type: "string",
					description:
						"Migration tool detected by agent (prisma|drizzle|knex|none).",
				})
				.option("migration-dir", {
					type: "string",
					description: "Migration directory detected by agent.",
				})
				.option("scaffold", {
					type: "string",
					choices: ["prisma", "drizzle"] as const,
					description: "Scaffold a new migration setup.",
				})
				.option("apply", {
					type: "boolean",
					default: false,
					description: "Apply pending migrations.",
				}),
		async (argv) => {
			const result = await handleMigrationsPhase({
				agent: resolveAgent(argv.agent),
				tool: argv.tool,
				migrationDir: argv.migrationDir,
				scaffold: argv.scaffold as "prisma" | "drizzle" | undefined,
				apply: argv.apply,
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// finalize (internal — called at the end of feature chains)
	// -----------------------------------------------------------------------
	.command(
		"finalize",
		false, // hidden from help
		(y) => y.options(jsonOption).options(agentOption),
		async () => {
			const { handleCleanup } = await import("./lib/phases/cleanup.js");
			const result = handleCleanup();
			outputJson(result);
			process.exit(0);
		},
	)

	// -----------------------------------------------------------------------
	// status
	// -----------------------------------------------------------------------
	.command(
		"status",
		"Check the status of your Neon setup",
		(y) => y.options(jsonOption).options(agentOption),
		async (argv) => {
			const result = await handleStatusPhase({
				agent: resolveAgent(argv.agent),
			});
			outputJson(result);
			process.exit(0);
		},
	)

	.help()
	.strict();

// Parse and execute
cli.parse();
