/**
 * Filesystem-based project inspection for interactive (agentless) mode.
 * Replaces the "agent_check" pattern — instead of asking an agent to look,
 * we examine the filesystem directly.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentCheck } from "./types.js";

export type DetectedScope = "global" | "project" | false;

export interface InspectionResults {
	[key: string]: unknown;
	mcpConfigured?: boolean;
	mcpScope?: DetectedScope;
	skillsInstalled?: boolean;
	skillsScope?: DetectedScope;
	/** True if a Neon-specific connection string (DATABASE_URL with "neon" or PGHOST with "neon") is found */
	connectionString?: boolean;
	/** True if any DATABASE_URL is set in .env (regardless of provider) */
	databaseUrl?: boolean;
	framework?: string;
	orm?: string;
	migrationTool?: string;
	migrationDir?: string;
	isVscodeIde?: boolean;
	agent?: string;
	/** True if the directory contains an application (package.json with deps, or source files) */
	hasApp?: boolean;
}

/**
 * Runs filesystem checks based on the agent_check descriptors.
 * Maps check IDs to concrete inspection functions.
 */
export async function inspectProject(
	checks: AgentCheck[],
): Promise<InspectionResults> {
	const results: InspectionResults = {};
	const cwd = process.cwd();

	for (const check of checks) {
		switch (check.id) {
			case "mcp_server": {
				const mcpScope = checkMcpServer(cwd);
				results.mcpConfigured = mcpScope !== false;
				results.mcpScope = mcpScope;
				break;
			}
			case "connection_string":
				results.connectionString = checkConnectionString(cwd);
				break;
			case "database_url":
				results.databaseUrl = checkDatabaseUrl(cwd);
				break;
			case "project_stack": {
				const stack = detectProjectStack(cwd);
				results.framework = stack.framework;
				results.orm = stack.orm;
				break;
			}
			case "migrations": {
				const migrations = detectMigrations(cwd);
				results.migrationTool = migrations.tool;
				results.migrationDir = migrations.dir;
				break;
			}
			case "skills": {
				const skillsScope = checkSkillsInstalled(cwd);
				results.skillsInstalled = skillsScope !== false;
				results.skillsScope = skillsScope;
				break;
			}
			case "ide_type":
				results.isVscodeIde = checkVscodeIde();
				break;
			case "has_app":
				results.hasApp = checkHasApp(cwd);
				break;
			case "agent_type":
				// Handled by the interactive runner (prompt or env detection)
				break;
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Individual check implementations
// ---------------------------------------------------------------------------

function checkMcpServer(cwd: string): DetectedScope {
	const home = process.env.HOME || process.env.USERPROFILE || "";

	// Check project-level configs first
	const projectConfigs = [
		resolve(cwd, ".cursor", "mcp.json"),
		resolve(cwd, ".vscode", "settings.json"),
	];
	for (const configPath of projectConfigs) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				if (
					content.includes("neon") ||
					content.includes("mcp.neon.tech")
				) {
					return "project";
				}
			} catch {}
		}
	}

	// Check global configs
	const globalConfigs = [
		resolve(home, ".cursor", "mcp.json"),
		// Claude Code config (add-mcp writes to settings.local.json)
		resolve(home, ".claude", "settings.local.json"),
		resolve(home, ".claude", "settings.json"),
	];
	for (const configPath of globalConfigs) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				if (
					content.includes("neon") ||
					content.includes("mcp.neon.tech")
				) {
					return "global";
				}
			} catch {}
		}
	}

	return false;
}

function checkConnectionString(cwd: string): boolean {
	for (const envFile of [".env", ".env.local"]) {
		const envPath = resolve(cwd, envFile);
		if (existsSync(envPath)) {
			try {
				const content = readFileSync(envPath, "utf-8");
				if (
					/^DATABASE_URL=.*neon/m.test(content) ||
					/^PGHOST=.*neon/m.test(content)
				) {
					return true;
				}
			} catch {}
		}
	}
	return false;
}

interface StackResult {
	framework: string;
	orm: string;
}

function detectProjectStack(cwd: string): StackResult {
	const result: StackResult = { framework: "none", orm: "none" };

	const pkgPath = resolve(cwd, "package.json");
	if (!existsSync(pkgPath)) return result;

	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const allDeps = {
			...pkg.dependencies,
			...pkg.devDependencies,
		};

		// Framework detection
		if (allDeps.next) result.framework = "next";
		else if (allDeps.remix || allDeps["@remix-run/node"])
			result.framework = "remix";
		else if (allDeps.express) result.framework = "express";
		else if (allDeps.hono) result.framework = "hono";
		else if (allDeps.fastify) result.framework = "fastify";
		else if (allDeps["@sveltejs/kit"]) result.framework = "sveltekit";
		else if (allDeps.nuxt) result.framework = "nuxt";
		else if (allDeps.astro) result.framework = "astro";

		// ORM detection
		if (allDeps.prisma || allDeps["@prisma/client"]) result.orm = "prisma";
		else if (allDeps["drizzle-orm"]) result.orm = "drizzle";
		else if (allDeps.knex) result.orm = "knex";
		else if (allDeps.typeorm) result.orm = "typeorm";
		else if (allDeps.sequelize) result.orm = "sequelize";
		else if (allDeps["@neondatabase/serverless"])
			result.orm = "neon-serverless";
	} catch {}

	return result;
}

interface MigrationResult {
	tool: string;
	dir: string;
}

function detectMigrations(cwd: string): MigrationResult {
	// Prisma
	if (existsSync(resolve(cwd, "prisma", "schema.prisma"))) {
		const migrationsDir = resolve(cwd, "prisma", "migrations");
		return {
			tool: "prisma",
			dir: existsSync(migrationsDir) ? "prisma/migrations" : "none",
		};
	}

	// Drizzle
	if (
		existsSync(resolve(cwd, "drizzle.config.ts")) ||
		existsSync(resolve(cwd, "drizzle.config.js"))
	) {
		const drizzleDir = resolve(cwd, "drizzle");
		return {
			tool: "drizzle",
			dir: existsSync(drizzleDir) ? "drizzle" : "none",
		};
	}

	// Knex
	if (
		existsSync(resolve(cwd, "knexfile.js")) ||
		existsSync(resolve(cwd, "knexfile.ts"))
	) {
		const migrationsDir = resolve(cwd, "migrations");
		return {
			tool: "knex",
			dir: existsSync(migrationsDir) ? "migrations" : "none",
		};
	}

	return { tool: "none", dir: "none" };
}

function checkDatabaseUrl(cwd: string): boolean {
	const envPath = resolve(cwd, ".env");
	if (existsSync(envPath)) {
		try {
			const content = readFileSync(envPath, "utf-8");
			if (/^DATABASE_URL=/m.test(content)) return true;
		} catch {}
	}
	return false;
}

function checkSkillsInstalled(cwd: string): DetectedScope {
	const home = process.env.HOME || process.env.USERPROFILE || "";

	const skillNames = ["neon", "neon-postgres"];

	// Check project-level skill directories — ALL base skills must exist
	const projectDirs = [
		resolve(cwd, ".cursor", "skills"),
		resolve(cwd, ".claude", "skills"),
		resolve(cwd, ".agents", "skills"),
	];
	const allProjectSkills = skillNames.every((skill) =>
		projectDirs.some((dir) => existsSync(resolve(dir, skill, "SKILL.md"))),
	);
	if (allProjectSkills) return "project";

	// Check CLAUDE.md for neon skill references (injected by skills CLI)
	// Only counts as installed if both skill names are referenced
	const claudeMd = resolve(cwd, "CLAUDE.md");
	if (existsSync(claudeMd)) {
		try {
			const content = readFileSync(claudeMd, "utf-8");
			if (
				content.includes("neon-postgres") &&
				content.includes("neon/SKILL.md")
			)
				return "project";
		} catch {}
	}

	// Check global skill directories — ALL base skills must exist
	const globalDirs = [
		resolve(home, ".cursor", "skills"),
		resolve(home, ".claude", "skills"),
		resolve(home, ".agents", "skills"),
	];
	const allGlobalSkills = skillNames.every((skill) =>
		globalDirs.some((dir) => existsSync(resolve(dir, skill, "SKILL.md"))),
	);
	if (allGlobalSkills) return "global";

	return false;
}

function checkVscodeIde(): boolean {
	const env = process.env;
	return !!(
		env.TERM_PROGRAM === "vscode" ||
		env.TERM_PROGRAM === "cursor" ||
		env.TERM_PROGRAM === "windsurf" ||
		env.VSCODE_PID ||
		env.VSCODE_CWD
	);
}

/**
 * Detects whether the current directory contains an application.
 * Returns true if package.json has dependencies or common source directories exist.
 */
function checkHasApp(cwd: string): boolean {
	const pkgPath = resolve(cwd, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			const deps = Object.keys(pkg.dependencies ?? {});
			const devDeps = Object.keys(pkg.devDependencies ?? {});
			if (deps.length > 0 || devDeps.length > 0) return true;
		} catch {}
	}

	// Check for common source directories / entry files
	const indicators = [
		"src",
		"app",
		"pages",
		"lib",
		"index.ts",
		"index.js",
		"main.ts",
		"main.js",
	];
	for (const indicator of indicators) {
		if (existsSync(resolve(cwd, indicator))) return true;
	}

	return false;
}
