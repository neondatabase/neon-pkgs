import { ensureSkillsUpToDate, SKILL_REFERENCE_URLS } from "../skills.js";
import type { PhaseResponse } from "../types.js";

export interface GettingStartedPhaseOptions {
	agent?: string;
	hasConnectionString?: boolean;
	framework?: string;
	orm?: string;
	migrationTool?: string;
	migrationDir?: string;
}

/**
 * Initiates the "Get started with Neon" workflow.
 *
 * Steps are concrete and executable — each has either an MCP tool to call,
 * a CLI command to run, or a specific file operation. The agent should
 * attempt each step in order and actually perform the action.
 */
export async function handleGettingStartedPhase(
	options: GettingStartedPhaseOptions,
): Promise<PhaseResponse> {
	// Ensure skills are up to date (no-op if recently updated)
	if (options.agent) {
		await ensureSkillsUpToDate(options.agent);
	}
	const steps: { id: string; description: string; command?: string }[] = [];

	if (!options.hasConnectionString) {
		// Step 1: List organizations and let user choose
		steps.push({
			id: "select_org",
			description: [
				"List the user's Neon organizations.",
				"Try using the Neon MCP tool `list_organizations` first.",
				"If MCP is not available, use the CLI command below.",
				"If only one org exists, use it automatically.",
				"If multiple orgs exist, ask the user which one to use.",
				"Remember the selected org ID for the next steps.",
			].join(" "),
			command: "CI= npx -y neonctl orgs list --output json",
		});

		// Step 2: List projects and let user choose or create new
		steps.push({
			id: "select_or_create_project",
			description: [
				"List existing Neon projects in the selected organization.",
				"Try using the Neon MCP tool `list_projects` first.",
				"If MCP is not available, use the CLI command below (replace <org-id> with the selected org ID).",
				"Ask the user whether they want to use an existing project or create a new one.",
				"If creating new, ask the user for a project name (suggest the current directory name).",
				"IMPORTANT: Always include --org-id when creating a project to avoid interactive prompts.",
			].join(" "),
			command:
				"CI= npx -y neonctl projects list --org-id <org-id> --output json",
		});

		// Step 3: Create project if needed (only if user chose to create new)
		steps.push({
			id: "create_project_if_needed",
			description: [
				"If the user chose to create a new project, create it now.",
				"Try using the Neon MCP tool `create_project` first.",
				"If MCP is not available, use the CLI command below (replace <org-id> and <project-name>).",
				"If the user chose an existing project, skip this step.",
			].join(" "),
			command:
				"CI= npx -y neonctl projects create --name <project-name> --org-id <org-id> --output json",
		});

		// Step 4: Create .neon context file
		steps.push({
			id: "create_neon_context",
			description: [
				"Create a .neon context file in the project root with the selected org and project IDs.",
				'The file is JSON with this format: {"orgId": "<org-id>", "projectId": "<project-id>"}',
				"If a .neon file already exists, update only the fields that are missing or different. Do NOT overwrite fields the user may have customized (e.g. branch).",
				"This file is safe to commit — it contains no secrets.",
			].join(" "),
		});

		// Step 5: Get connection string and write to .env
		steps.push({
			id: "set_connection_string",
			description: [
				"Get the database connection string for the selected or newly created project.",
				"Try using the Neon MCP tool `get_connection_string` first.",
				"If MCP is not available, use the CLI command below.",
				"Then write DATABASE_URL=<connection_string> to the .env file.",
				"Create .env if it doesn't exist. Do NOT overwrite existing entries.",
				"Ensure .env is listed in .gitignore.",
			].join(" "),
			command:
				"CI= npx -y neonctl connection-string --project-id <project-id>",
		});

		// Step 6: Install Neon serverless driver if needed
		if (options.orm === "prisma") {
			steps.push({
				id: "install_driver",
				description: [
					"Install the @neondatabase/serverless driver adapter for Prisma.",
					"This enables Prisma to use Neon's serverless driver for edge/serverless deployments.",
				].join(" "),
				command:
					"npm install @neondatabase/serverless @prisma/adapter-neon",
			});
		} else if (options.orm === "drizzle" || options.orm === "drizzle-orm") {
			steps.push({
				id: "install_driver",
				description: "Install the Neon serverless driver for Drizzle.",
				command: "npm install @neondatabase/serverless",
			});
		} else if (!options.orm || options.orm === "none") {
			steps.push({
				id: "install_driver",
				description:
					"Install the Neon serverless driver for direct database access.",
				command: "npm install @neondatabase/serverless",
			});
		}
	}

	// Run migrations if applicable
	if (options.migrationTool && options.migrationTool !== "none") {
		const migrationCommands: Record<string, string> = {
			prisma: "npx prisma migrate deploy",
			drizzle: "npx drizzle-kit migrate",
			knex: "npx knex migrate:latest",
		};
		const cmd = migrationCommands[options.migrationTool.toLowerCase()];
		if (cmd) {
			steps.push({
				id: "run_migrations",
				description: `Apply existing ${options.migrationTool} migrations to the Neon database.`,
				command: cmd,
			});
		}
	}

	// Verify the connection
	steps.push({
		id: "verify_connection",
		description: [
			"Verify the database connection works by running a SQL query against the Neon database.",
			"Use the Neon MCP tool `run_sql` to query a table from the migration (if migrations were run), or run `SELECT 1` as a basic connectivity check.",
			"If MCP is not available, write and run a short script that connects using DATABASE_URL from .env and executes the query.",
			"Do NOT use the neonctl CLI for queries.",
		].join(" "),
	});

	return {
		phase: "setup",
		status: "getting_started",
		nextAction: {
			type: "agent_action",
			prerequisite: SKILL_REFERENCE_URLS.gettingStarted,
			steps,
			onComplete: {
				type: "run_neon_init",
				args: [
					"neon-auth",
					"--json",
					...(options.agent ? ["--agent", options.agent] : []),
				],
			},
		},
	};
}
