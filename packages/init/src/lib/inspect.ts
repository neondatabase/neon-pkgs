/**
 * Filesystem-based project inspection for interactive (agentless) mode.
 * Replaces the "agent_check" pattern — instead of asking an agent to look,
 * we examine the filesystem directly.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentCheck } from "./types.js";

export interface InspectionResults {
	[key: string]: unknown;
	mcpConfigured?: boolean;
	skillsInstalled?: boolean;
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
			case "mcp_server":
				results.mcpConfigured = checkMcpServer(cwd);
				break;
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
			case "skills":
				results.skillsInstalled = checkSkillsInstalled(cwd);
				break;
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

function checkMcpServer(cwd: string): boolean {
	// Check project-level Cursor config
	const cursorMcp = resolve(cwd, ".cursor", "mcp.json");
	if (existsSync(cursorMcp)) {
		try {
			const content = readFileSync(cursorMcp, "utf-8");
			if (content.includes("neon") || content.includes("mcp.neon.tech")) {
				return true;
			}
		} catch {}
	}

	// Check global Cursor config
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const globalCursorMcp = resolve(home, ".cursor", "mcp.json");
	if (existsSync(globalCursorMcp)) {
		try {
			const content = readFileSync(globalCursorMcp, "utf-8");
			if (content.includes("neon") || content.includes("mcp.neon.tech")) {
				return true;
			}
		} catch {}
	}

	// Check Claude Code config (add-mcp writes to settings.local.json)
	for (const claudeFile of ["settings.local.json", "settings.json"]) {
		const claudeConfig = resolve(home, ".claude", claudeFile);
		if (existsSync(claudeConfig)) {
			try {
				const content = readFileSync(claudeConfig, "utf-8");
				if (
					content.includes("neon") ||
					content.includes("mcp.neon.tech")
				) {
					return true;
				}
			} catch {}
		}
	}

	// Check VS Code settings
	const vscodeSettings = resolve(cwd, ".vscode", "settings.json");
	if (existsSync(vscodeSettings)) {
		try {
			const content = readFileSync(vscodeSettings, "utf-8");
			if (content.includes("neon") || content.includes("mcp.neon.tech")) {
				return true;
			}
		} catch {}
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

function checkSkillsInstalled(cwd: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE || "";

	// Check for neon-postgres SKILL.md in known skill directories (project and global)
	const skillsDirs = [
		resolve(cwd, ".cursor", "skills"),
		resolve(cwd, ".claude", "skills"),
		resolve(cwd, ".agents", "skills"),
		resolve(home, ".cursor", "skills"),
		resolve(home, ".claude", "skills"),
	];
	for (const dir of skillsDirs) {
		// Verify the actual skill content file exists, not just the directory
		const skillMd = resolve(dir, "neon-postgres", "SKILL.md");
		if (existsSync(skillMd)) return true;
	}

	// Check CLAUDE.md for neon skill references (injected by skills CLI)
	const claudeMd = resolve(cwd, "CLAUDE.md");
	if (existsSync(claudeMd)) {
		try {
			const content = readFileSync(claudeMd, "utf-8");
			if (content.includes("neon-postgres")) return true;
		} catch {}
	}

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
