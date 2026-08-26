import {
	DO_NOT_SUBSTITUTE_HINT,
	formatExecCommand,
	formatInstallCommand,
	MISSING_BINARY_HINT,
	resolvePackageManager,
} from "../../utils/package_manager.js";
import { neonctlCmd } from "../neonctl.js";
import { ensureSkillsUpToDate, SKILL_REFERENCE_URLS } from "../skills.js";
import type { PhaseResponse } from "../types.js";

export type GettingStartedPhaseOptions = {
	agent?: string;
	hasConnectionString?: boolean;
	framework?: string;
	orm?: string;
	migrationTool?: string;
	migrationDir?: string;
	/** Neon features required by the project (from .neon or template) */
	features?: string[];
	/** Preview mode — restricts project creation to new projects in AWS us-east */
	preview?: boolean;
	/** The project directory the emitted commands will run in. */
	cwd: string;
};

/**
 * Initiates the "Get started with Neon" workflow.
 *
 * Steps are concrete and executable — each has a CLI command to run
 * or a specific file operation. The agent should attempt each step
 * in order and actually perform the action using the Neon CLI.
 */
export async function handleGettingStartedPhase(
	options: GettingStartedPhaseOptions,
): Promise<PhaseResponse> {
	// Ensure skills are up to date (no-op if recently updated)
	if (options.agent) {
		await ensureSkillsUpToDate(options.agent);
	}
	const steps: { id: string; description: string; command?: string }[] = [];

	const installPm = resolvePackageManager(options.cwd);

	if (!options.hasConnectionString) {
		if (options.preview) {
			// Public beta: platform features are only in AWS us-east-2 for now
			steps.push(
				{
					id: "select_org",
					description: [
						"List the user's Neon organizations using the CLI command below.",
						"If only one org exists, use it automatically.",
						"If multiple orgs exist, ask the user which one to use.",
						"Remember the selected org ID for the next steps.",
					].join(" "),
					command: `${neonctlCmd()} orgs list --output json`,
				},
				{
					id: "select_or_create_project",
					description: [
						"List existing Neon projects in the selected organization using the CLI command below (replace <org-id> with the selected org ID).",
						"IMPORTANT: Neon features (Functions, Object Storage, and AI Gateway) are currently in beta and only available in the AWS us-east-2 region (more regions coming shortly). Projects must have region_id 'aws-us-east-2' and be created on or after 2026-06-15.",
						"Filter the project list to ONLY show projects where region_id is 'aws-us-east-2' AND created_at is on or after '2026-06-15'.",
						"If eligible projects exist, present them alongside a 'Create new project' option.",
						"If no eligible projects exist, tell the user and proceed directly to creating a new one.",
						"IMPORTANT: Always include --org-id when creating a project to avoid interactive prompts.",
					].join(" "),
					command: `${neonctlCmd()} projects list --org-id <org-id> --output json`,
				},
				{
					id: "create_project_if_needed",
					description: [
						"If the user chose to create a new project, create it in the AWS us-east-2 region using the CLI command below (replace <org-id> and <project-name>).",
						"Ask the user for a project name (suggest the current directory name).",
						"If the user chose an existing eligible project, skip this step.",
					].join(" "),
					command: `${neonctlCmd()} projects create --name <project-name> --org-id <org-id> --region-id aws-us-east-2 --output json --no-secrets`,
				},
			);
		} else {
			// Standard mode: let user choose existing or create new
			steps.push(
				{
					id: "select_org",
					description: [
						"List the user's Neon organizations using the CLI command below.",
						"If only one org exists, use it automatically.",
						"If multiple orgs exist, ask the user which one to use.",
						"Remember the selected org ID for the next steps.",
					].join(" "),
					command: `${neonctlCmd()} orgs list --output json`,
				},
				{
					id: "select_or_create_project",
					description: [
						"List existing Neon projects in the selected organization using the CLI command below (replace <org-id> with the selected org ID).",
						"Ask the user whether they want to use an existing project or create a new one.",
						"If creating new, ask the user for a project name (suggest the current directory name).",
						"IMPORTANT: Always include --org-id when creating a project to avoid interactive prompts.",
					].join(" "),
					command: `${neonctlCmd()} projects list --org-id <org-id> --output json`,
				},
				{
					id: "create_project_if_needed",
					description: [
						"If the user chose to create a new project, create it using the CLI command below (replace <org-id> and <project-name>).",
						"If the user chose an existing project, skip this step.",
					].join(" "),
					command: `${neonctlCmd()} projects create --name <project-name> --org-id <org-id> --output json --no-secrets`,
				},
			);
		}

		// Create/update .neon context file
		steps.push({
			id: "create_neon_context",
			description: [
				"Update the .neon context file in the project root with the selected org and project IDs.",
				"IMPORTANT: If a .neon file already exists, you MUST read it first, then merge the new orgId and projectId into the existing content. Do NOT overwrite the file — other fields (like _init, branch, etc.) must be preserved.",
				"If no .neon file exists, create one.",
				'The file is JSON. Add/update only the orgId and projectId fields: {"orgId": "<org-id>", "projectId": "<project-id>", ...existing fields}.',
				"This file is safe to commit — it contains no secrets.",
			].join(" "),
		});

		// Install project dependencies (required before env pull — config files may import packages)
		steps.push({
			id: "install_dependencies",
			description: [
				"Check if node_modules exists in the project root. If not, install the project's dependencies.",
				DO_NOT_SUBSTITUTE_HINT,
				"This must be done before `neon env pull` because the project's Neon config file may import packages that need to be installed first.",
			].join(" "),
			command: formatInstallCommand(installPm),
		});

		// Pull environment variables (connection string, etc.) from Neon
		steps.push({
			id: "pull_env",
			description: [
				"Now that the .neon context file is in place and dependencies are installed, run `neon env pull` to populate the project's environment variables.",
				"This automatically writes the database connection string (and any other Neon-managed env vars) to the correct env file.",
				"It reads the .neon context file to determine the project, and writes to the appropriate env file for the project.",
				"Ensure the target env file is listed in .gitignore.",
			].join(" "),
			command: `${neonctlCmd()} env pull`,
		});

		// Step 6: Install Neon serverless driver if needed
		if (options.orm === "prisma") {
			steps.push({
				id: "install_driver",
				description: [
					"Install the @neondatabase/serverless driver adapter for Prisma.",
					"This enables Prisma to use Neon's serverless driver for edge/serverless deployments.",
					DO_NOT_SUBSTITUTE_HINT,
				].join(" "),
				command: formatInstallCommand(installPm, [
					"@neondatabase/serverless",
					"@prisma/adapter-neon",
				]),
			});
		} else if (options.orm === "drizzle" || options.orm === "drizzle-orm") {
			steps.push({
				id: "install_driver",
				description: `Install the Neon serverless driver for Drizzle. ${DO_NOT_SUBSTITUTE_HINT}`,
				command: formatInstallCommand(installPm, [
					"@neondatabase/serverless",
				]),
			});
		} else if (!options.orm || options.orm === "none") {
			steps.push({
				id: "install_driver",
				description: `Install the Neon serverless driver for direct database access. ${DO_NOT_SUBSTITUTE_HINT}`,
				command: formatInstallCommand(installPm, [
					"@neondatabase/serverless",
				]),
			});
		}
	}

	// Run migrations if applicable
	if (options.migrationTool && options.migrationTool !== "none") {
		const tool = options.migrationTool.toLowerCase();
		const migrationDir = options.migrationDir;
		const hasMigrationDir = migrationDir && migrationDir !== "none";

		if (tool === "drizzle") {
			const migrate = formatExecCommand(installPm, "drizzle-kit", [
				"migrate",
			]);
			const generate = formatExecCommand(installPm, "drizzle-kit", [
				"generate",
			]);
			steps.push({
				id: "run_migrations",
				description: [
					hasMigrationDir
						? `Check if the ${migrationDir} directory contains .sql migration files.`
						: "Check if a drizzle migrations directory exists with .sql files.",
					`If .sql files exist, apply them with \`${migrate}\`.`,
					`If the directory is empty or missing but a drizzle schema file exists (e.g. src/db/schema.ts, drizzle/schema.ts), run \`${generate}\` first to create migrations, then \`${migrate}\` to apply them.`,
					"If neither schema nor migrations exist, skip this step.",
					MISSING_BINARY_HINT,
				].join(" "),
				command: migrate,
			});
		} else if (tool === "prisma") {
			const deploy = formatExecCommand(installPm, "prisma", [
				"migrate",
				"deploy",
			]);
			steps.push({
				id: "run_migrations",
				description: [
					hasMigrationDir
						? `Check if the ${migrationDir} directory contains migration folders.`
						: "Check if prisma/migrations contains migration folders.",
					`If migrations exist, apply them with \`${deploy}\`.`,
					`If the migrations directory is empty or missing but prisma/schema.prisma has models defined, run \`${formatExecCommand(installPm, "prisma", ["migrate", "dev", "--name", "init"])}\` to create and apply the initial migration.`,
					"If no models are defined, skip this step.",
					MISSING_BINARY_HINT,
				].join(" "),
				command: deploy,
			});
		} else if (tool === "knex") {
			steps.push({
				id: "run_migrations",
				description: `Apply existing knex migrations to the Neon database. ${MISSING_BINARY_HINT}`,
				command: formatExecCommand(installPm, "knex", [
					"migrate:latest",
				]),
			});
		}
	} else if (options.preview) {
		// Bootstrap flow: migration tool wasn't detected because the project was
		// inspected before scaffolding. Detect and run migrations from the scaffolded template.
		steps.push({
			id: "run_migrations",
			description: [
				"Check the scaffolded project for a migration tool and schema.",
				"Look for: drizzle.config.ts/js (Drizzle), prisma/schema.prisma (Prisma), or knexfile.ts/js (Knex).",
				`If Drizzle is found: check if a drizzle migrations directory exists with .sql files. If .sql files exist, run \`${formatExecCommand(installPm, "drizzle-kit", ["migrate"])}\`. If the directory is empty or missing but a schema file exists, run \`${formatExecCommand(installPm, "drizzle-kit", ["generate"])}\` first, then \`${formatExecCommand(installPm, "drizzle-kit", ["migrate"])}\`.`,
				`If Prisma is found: check if prisma/migrations contains migration folders. If yes, run \`${formatExecCommand(installPm, "prisma", ["migrate", "deploy"])}\`. If not but models exist, run \`${formatExecCommand(installPm, "prisma", ["migrate", "dev", "--name", "init"])}\`.`,
				"If no migration tool is found, skip this step.",
				MISSING_BINARY_HINT,
			].join(" "),
		});
	}

	// Verify the connection
	steps.push({
		id: "verify_connection",
		description: [
			"Verify the database connection works by running a SQL query against the Neon database.",
			"Write and run a short script that connects using DATABASE_URL from the project's env file and executes `SELECT 1` (or queries a table from the migration if migrations were run).",
			"Do NOT use the Neon CLI or MCP tools for this — use a direct database connection to verify end-to-end connectivity.",
		].join(" "),
	});

	return {
		phase: "setup",
		status: "getting_started",
		nextAction: {
			type: "agent_action",
			prerequisite: SKILL_REFERENCE_URLS.gettingStarted,
			steps,
			onComplete: buildOnComplete(options),
		},
	};
}

function buildOnComplete(
	options: GettingStartedPhaseOptions,
): import("../types.js").RunNeonInitAction {
	const agentArgs = options.agent ? ["--agent", options.agent] : [];
	const features = options.features ?? [];
	const hasFeatureRequirements = features.length > 0;

	// If features are specified and auth is not required, go to finalize
	if (hasFeatureRequirements && !features.includes("auth")) {
		return {
			type: "run_neon_init",
			args: ["finalize", "--json", ...agentArgs],
		};
	}

	// Chain to neon-auth — if user already selected auth via features, go straight to setup
	const authSetup =
		hasFeatureRequirements && features.includes("auth") ? ["--setup"] : [];
	return {
		type: "run_neon_init",
		args: ["neon-auth", "--json", ...agentArgs, ...authSetup],
	};
}
