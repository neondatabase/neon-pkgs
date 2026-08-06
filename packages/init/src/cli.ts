#!/usr/bin/env node

import { writeSync } from "node:fs";
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
import pkg from "./pkg.js";
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
		type: "boolean" as const,
		default: false,
		description: "Enable agent/JSON mode (agent type is auto-detected).",
	},
};

// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

import { enrichResponse } from "./lib/enrich-output.js";

function outputJson(data: unknown): void {
	console.log(JSON.stringify(enrichResponse(data), null, 2));
}

/**
 * What yargs parsed, once it has parsed anything. Recorded by a middleware so the failure
 * handler can use the real value rather than re-deriving it.
 */
let parsedJsonMode: boolean | undefined;

/**
 * Whether this invocation asked for JSON.
 *
 * Prefers what yargs parsed, because matching its semantics by hand is a losing game:
 * `--json=true`, `-a=true` and `--no-json` are all valid and none of them is the bare token
 * this used to look for, so an agent passing `--json=true` got a plaintext error.
 *
 * The raw scan is the fallback for a *parse* error, where there is no parsed argv to consult
 * and the mode still decides how the failure has to be shaped. It is last-wins, as yargs is.
 */
function jsonRequested(): boolean {
	if (parsedJsonMode !== undefined) return parsedJsonMode;
	return rawJsonFlag() ?? detectAgentInvocation() !== null;
}

/**
 * Write every byte to a file descriptor before returning.
 *
 * `process.stdout.write` buffers on a pipe, which is exactly where an agent reads from, so the
 * `process.exit` that has to follow a failure would cut the message in half. A partial write is
 * normal on a pipe and `EAGAIN` is normal on a non-blocking one; both mean "call again".
 */
function writeAllSync(fd: number, text: string): void {
	let buffer = Buffer.from(text, "utf8");
	while (buffer.length > 0) {
		try {
			buffer = buffer.subarray(writeSync(fd, buffer));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EAGAIN") return;
			// Wait for the reader rather than spinning on it. A pipe nobody is draining would
			// otherwise burn a core until it is; failure output is small enough that this
			// should never be reached, which is the reason to bound it rather than assume so.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}

/** The spellings yargs reads as false for a boolean option. */
const FALSEY = new Set(["false", "0"]);

/**
 * `--json`, `--json=false`, `--json 0`, `--no-agent`, `-a` … or `undefined` when none was passed.
 *
 * The two flags are tracked separately and then OR'd, because that is what the parsed value is:
 * folding them into one last-wins slot made `--json --no-agent` answer plaintext despite `json`
 * being true. Each is last-wins on its own, as yargs is.
 */
function rawJsonFlag(): boolean | undefined {
	const argv = process.argv.slice(2);
	let json: boolean | undefined;
	let agent: boolean | undefined;

	for (const [index, arg] of argv.entries()) {
		const match = /^(?:--(no-)?(json|agent)|(-a))(?:=(.*))?$/.exec(arg);
		if (!match) continue;
		const [, negated, long, short, assigned] = match;
		// A boolean also takes its value as the next token: `--json false`.
		const separate = assigned === undefined ? argv[index + 1] : undefined;
		const value =
			assigned ??
			(separate !== undefined &&
			(FALSEY.has(separate) || separate === "true" || separate === "1")
				? separate
				: undefined);
		const asked = value === undefined || !FALSEY.has(value.toLowerCase());
		const resolved = negated ? !asked : asked;
		if (short !== undefined || long === "agent") agent = resolved;
		else json = resolved;
	}

	if (json === undefined && agent === undefined) return undefined;
	return Boolean(json) || Boolean(agent);
}

/**
 * Resolve the agent ID from the environment.
 */
function resolveAgent(): string | undefined {
	return detectAgent() ?? undefined;
}

/**
 * Detects if an AI agent is invoking the CLI programmatically.
 *
 * Agent-specific env vars (CLAUDECODE, CODEX, CLINE) are unambiguous.
 * For IDE-based agents (Cursor, VS Code, Windsurf), we require non-TTY
 * stdin to distinguish "agent spawned this" from "human typed this in
 * the IDE's integrated terminal".
 */
function detectAgentInvocation(): string | null {
	const env = process.env;

	// Agent-specific env vars (always definitive, regardless of TTY)
	if (
		env.CLAUDECODE === "1" ||
		env.CLAUDE_CODE === "1" ||
		env.CLAUDE_CLI === "1"
	)
		return "claude-code";
	if (env.CODEX === "1") return "codex";
	if (env.CLINE === "1") return "cline";

	// IDE detected + non-interactive stdin = agent spawned us
	// (a human typing in the same terminal would have isTTY=true)
	if (!process.stdin.isTTY) {
		return detectAgent();
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
				.option("data", {
					type: "string",
					description:
						'JSON object with a "step" field to route to a specific phase (auth, db, setup, getting-started, mcp, skills, migrations, neon-auth, status, finalize) and phase-specific options.',
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
			const agent = resolveAgent();
			const jsonMode = argv.json || argv.agent || detectedAgent !== null;

			// --data with a "step" field routes to the appropriate phase
			if (argv.data && jsonMode) {
				const { routeDataStep } = await import(
					"./lib/route-command.js"
				);
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
				if (typeof data.step === "string") {
					const result = await routeDataStep(data, agent);
					outputJson(result);
					process.exit(0);
					return;
				}
			}

			// --data with a "step" field routes to the appropriate phase
			if (argv.data && jsonMode) {
				const { routeDataStep } = await import(
					"./lib/route-command.js"
				);
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
				if (typeof data.step === "string") {
					const result = await routeDataStep(data, agent);
					outputJson(result);
					process.exit(0);
					return;
				}
			}

			if (jsonMode) {
				// v2: agent-driven state machine
				const result = await orchestrate({
					agent,
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
		"Manage Neon authentication",
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
				agent: resolveAgent(),
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
				agent: resolveAgent(),
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
				agent: resolveAgent(),
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
					agent: resolveAgent(),
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
				agent: resolveAgent(),
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
					agent: resolveAgent(),
					...data,
				} as import("./lib/phases/getting-started.js").GettingStartedPhaseOptions);
				outputJson(result);
				process.exit(0);
				return;
			}

			const result = await handleGettingStartedPhase({
				agent: resolveAgent(),
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
						"JSON output from neon orgs list (agent passes back).",
				})
				.option("projects-result", {
					type: "string",
					description:
						"JSON output from neon projects list (agent passes back).",
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
				agent: resolveAgent(),
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
				agent: resolveAgent(),
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
				agent: resolveAgent(),
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
		async (_argv) => {
			const result = await handleStatusPhase({
				agent: resolveAgent(),
			});
			outputJson(result);
			process.exit(0);
		},
	)

	// Runs for every command once parsing succeeds, so the failure handler below reports in
	// whichever mode yargs actually resolved rather than in one re-derived from raw argv.
	.middleware((argv) => {
		parsedJsonMode =
			Boolean(argv.json) ||
			Boolean(argv.agent) ||
			detectAgentInvocation() !== null;
	})
	.help()
	// Without this yargs guesses the version, and in an ESM bin it guesses
	// wrong — `neon-init --version` printed "unknown".
	.version(pkg.version)
	.strict()
	// Report a failure in the idiom the caller asked for. Without this, anything thrown from a
	// handler reached yargs' default path and printed the whole help screen followed by a Node
	// stack trace — and under `--json`, output that is not JSON at all, which is the one thing
	// an agent parsing this cannot recover from. Reached by a damaged credentials file, whose
	// whole point is to fail rather than be silently replaced.
	.fail((msg, err) => {
		const message = err?.message ?? msg ?? "neon-init failed";
		// Written synchronously so that exiting on the next line cannot truncate it. Deferring
		// the exit to a write callback instead lets yargs carry on: on a parse error it
		// reported the bad argument and then ran the command anyway, printing two answers.
		if (jsonRequested()) {
			writeAllSync(
				1,
				`${JSON.stringify(enrichResponse({ success: false, error: message }), null, 2)}\n`,
			);
		} else {
			writeAllSync(2, `Error: ${message}\n`);
		}
		process.exit(1);
	});

// Parse and execute
cli.parse();
