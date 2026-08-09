import {
	formatInstallCommand,
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
							description: "Install Prisma as a dev dependency",
							command: formatInstallCommand(pm, ["prisma"], {
								dev: true,
							}),
						},
						{
							id: "init_prisma",
							description:
								"Initialize Prisma with PostgreSQL provider",
							command:
								"npx prisma init --datasource-provider postgresql",
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
							description:
								"Create and apply the initial migration",
							command: "npx prisma migrate dev --name init",
						},
					],
					onComplete: {
						type: "complete",
						message:
							"Prisma is set up with your Neon database. You can now define models in schema.prisma and run migrations with `npx prisma migrate dev`.",
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
						description:
							"Install Drizzle ORM, drizzle-kit, and the Neon serverless driver",
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
						description: "Generate and apply the initial migration",
						command:
							"npx drizzle-kit generate && npx drizzle-kit migrate",
					},
				],
				onComplete: {
					type: "complete",
					message:
						"Drizzle ORM is set up with your Neon database. Define tables in your schema file and run migrations with `npx drizzle-kit generate && npx drizzle-kit migrate`.",
				},
			},
		};
	}

	// --apply: apply existing migrations
	if (options.apply && options.tool) {
		const applySteps = getMigrationApplySteps(options.tool);
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

function getMigrationApplySteps(tool: string) {
	switch (tool) {
		case "prisma":
			return [
				{
					id: "ensure_env",
					description: "Verify DATABASE_URL is set in .env",
				},
				{
					id: "apply",
					description: "Apply migrations to the Neon database",
					command: "npx prisma migrate deploy",
				},
				{
					id: "generate",
					description: "Generate the Prisma client",
					command: "npx prisma generate",
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
					description: "Apply migrations to the Neon database",
					command: "npx drizzle-kit migrate",
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
					description: "Apply migrations to the Neon database",
					command: "npx knex migrate:latest",
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
