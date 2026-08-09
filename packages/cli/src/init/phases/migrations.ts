import {
	DO_NOT_SUBSTITUTE_HINT,
	formatExecCommand,
	formatInstallCommand,
	MISSING_BINARY_HINT,
	type PackageManager,
	resolvePackageManager,
} from "../../utils/package_manager.js";
import { ensureSkillsUpToDate } from "../skills.js";
import type { PhaseResponse } from "../types.js";

export type MigrationsPhaseOptions = {
	agent?: string;
	tool?: string;
	migrationDir?: string;
	scaffold?: "prisma" | "drizzle";
	apply?: boolean;
	/** The project directory the emitted commands will run in. */
	cwd: string;
};

export async function handleMigrationsPhase(
	options: MigrationsPhaseOptions,
): Promise<PhaseResponse> {
	// Ensure skills are up to date (no-op if recently updated)
	if (options.agent) {
		await ensureSkillsUpToDate(options.agent);
	}
	const agentArgs = options.agent
		? ["--agent", options.agent, "--json"]
		: ["--json"];
	const pm = resolvePackageManager(options.cwd);

	// --scaffold: set up a new migration framework
	if (options.scaffold) {
		if (options.scaffold === "prisma") {
			return {
				phase: "migrations",
				status: "scaffolding",
				tool: "prisma",
				nextAction: {
					type: "agent_action",
					steps: [
						{
							id: "install_prisma",
							description: `Install Prisma as a dev dependency. ${DO_NOT_SUBSTITUTE_HINT}`,
							command: formatInstallCommand(pm, ["prisma"], {
								dev: true,
							}),
						},
						{
							id: "init_prisma",
							description: `Initialize Prisma with PostgreSQL provider. ${MISSING_BINARY_HINT}`,
							command: formatExecCommand(pm, "prisma", [
								"init",
								"--datasource-provider",
								"postgresql",
							]),
						},
						{
							id: "configure_env",
							description:
								"Ensure DATABASE_URL in .env points to your Neon database. The prisma init command may have created a placeholder — replace it with the real connection string if needed.",
						},
						{
							id: "create_schema",
							description:
								"Help the user define their initial schema in prisma/schema.prisma based on their application needs.",
						},
						{
							id: "run_migration",
							description: `Create and apply the initial migration. ${MISSING_BINARY_HINT}`,
							command: formatExecCommand(pm, "prisma", [
								"migrate",
								"dev",
								"--name",
								"init",
							]),
						},
					],
					onComplete: {
						type: "complete",
						message: `Prisma is set up with your Neon database. You can now define models in schema.prisma and run migrations with \`${formatExecCommand(pm, "prisma", ["migrate", "dev"])}\`.`,
					},
				},
			};
		}

		// drizzle
		return {
			phase: "migrations",
			status: "scaffolding",
			tool: "drizzle",
			nextAction: {
				type: "agent_action",
				steps: [
					{
						id: "install_drizzle",
						description: `Install Drizzle ORM, drizzle-kit, and the Neon serverless driver. ${DO_NOT_SUBSTITUTE_HINT}`,
						command: [
							formatInstallCommand(pm, [
								"drizzle-orm",
								"@neondatabase/serverless",
							]),
							formatInstallCommand(pm, ["drizzle-kit"], {
								dev: true,
							}),
						].join(" && "),
					},
					{
						id: "create_config",
						description:
							"Create drizzle.config.ts at the project root. Set the dialect to 'postgresql' and dbCredentials.url to process.env.DATABASE_URL.",
					},
					{
						id: "create_schema",
						description:
							"Create a schema file (e.g. src/db/schema.ts) and help the user define their initial tables using Drizzle's table builder.",
					},
					{
						id: "run_migration",
						description: `Generate and apply the initial migration. ${MISSING_BINARY_HINT}`,
						command: drizzleGenerateAndMigrate(pm),
					},
				],
				onComplete: {
					type: "complete",
					message: `Drizzle ORM is set up with your Neon database. Define tables in your schema file and run migrations with \`${drizzleGenerateAndMigrate(pm)}\`.`,
				},
			},
		};
	}

	// --apply: apply existing migrations
	if (options.apply && options.tool) {
		const applySteps = getMigrationApplySteps(options.tool, pm);
		return {
			phase: "migrations",
			status: "applying",
			tool: options.tool,
			nextAction: {
				type: "agent_action",
				steps: applySteps,
				onComplete: {
					type: "complete",
					message: "Database migrations applied successfully.",
				},
			},
		};
	}

	// Agent reported detection results via --tool and --migration-dir
	if (options.tool && options.tool !== "none") {
		return {
			phase: "migrations",
			status: "found",
			detected: {
				tool: options.tool,
				migrationDir: options.migrationDir ?? null,
			},
			nextAction: {
				type: "ask_user",
				question: `Found ${options.tool} migrations${options.migrationDir ? ` in ${options.migrationDir}` : ""}. Would you like to apply them to your Neon database?`,
				options: [
					{ value: "apply", label: "Yes, apply migrations" },
					{ value: "skip", label: "Skip for now" },
				],
				responseMapping: {
					apply: {
						args: [
							"migrations",
							"--json",
							"--apply",
							"--tool",
							options.tool,
						],
					},
					skip: { args: [...agentArgs, "--skip-migrations"] },
				},
			},
		};
	}

	if (options.tool === "none") {
		return {
			phase: "migrations",
			status: "none_found",
			nextAction: {
				type: "ask_user",
				question:
					"No existing database migrations were found. Would you like to set up a migration framework?",
				options: [
					{
						value: "prisma",
						label: "Prisma (recommended for TypeScript)",
					},
					{ value: "drizzle", label: "Drizzle ORM" },
					{
						value: "skip",
						label: "Skip - I'll handle migrations myself",
					},
				],
				context:
					"A migration framework helps you version-control your database schema changes.",
				responseMapping: {
					prisma: {
						args: ["migrations", "--json", "--scaffold", "prisma"],
					},
					drizzle: {
						args: ["migrations", "--json", "--scaffold", "drizzle"],
					},
					skip: { args: [...agentArgs, "--skip-migrations"] },
				},
			},
		};
	}

	// Default: ask agent to detect migration tooling
	return {
		phase: "migrations",
		status: "detection_needed",
		nextAction: {
			type: "agent_check",
			checks: [
				{
					id: "existing_migrations",
					description:
						"Check if the project has existing database migrations",
					lookFor: [
						"prisma/migrations/ directory or schema.prisma file",
						"drizzle/ directory or drizzle.config.ts",
						"migrations/ or db/migrations/ directory",
						"knex migration files (knexfile.js/ts)",
					],
				},
			],
			reportBack: {
				type: "run_neon_init",
				args: [
					"migrations",
					"--json",
					"--tool",
					"<prisma|drizzle|knex|none>",
					"--migration-dir",
					"<path|none>",
				],
			},
		},
	};
}

/** `drizzle-kit generate` then `migrate`, both through the project's runner. */
const drizzleGenerateAndMigrate = (pm: PackageManager): string =>
	[
		formatExecCommand(pm, "drizzle-kit", ["generate"]),
		formatExecCommand(pm, "drizzle-kit", ["migrate"]),
	].join(" && ");

function getMigrationApplySteps(tool: string, pm: PackageManager) {
	switch (tool) {
		case "prisma":
			return [
				{
					id: "ensure_env",
					description: "Verify DATABASE_URL is set in .env",
				},
				{
					id: "apply",
					description: `Apply migrations to the Neon database. ${MISSING_BINARY_HINT}`,
					command: formatExecCommand(pm, "prisma", [
						"migrate",
						"deploy",
					]),
				},
				{
					// No MISSING_BINARY_HINT: the apply step immediately above
					// carries it, and `prisma generate` writes a client without
					// touching a database, so that warning is not true here.
					id: "generate",
					description: "Generate the Prisma client.",
					command: formatExecCommand(pm, "prisma", ["generate"]),
				},
			];
		case "drizzle":
			return [
				{
					id: "ensure_env",
					description: "Verify DATABASE_URL is set in .env",
				},
				{
					id: "apply",
					description: `Apply migrations to the Neon database. ${MISSING_BINARY_HINT}`,
					command: formatExecCommand(pm, "drizzle-kit", ["migrate"]),
				},
			];
		case "knex":
			return [
				{
					id: "ensure_env",
					description: "Verify DATABASE_URL is set in .env",
				},
				{
					id: "apply",
					description: `Apply migrations to the Neon database. ${MISSING_BINARY_HINT}`,
					command: formatExecCommand(pm, "knex", ["migrate:latest"]),
				},
			];
		default:
			return [
				{
					id: "ensure_env",
					description: "Verify DATABASE_URL is set in .env",
				},
				{
					id: "apply",
					description: `Apply ${tool} migrations to the Neon database using the appropriate command for your migration tool.`,
				},
			];
	}
}
