import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { inspectProject } from "./inspect.js";
import type { AgentCheck } from "./types.js";

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `neon-inspect-test-${Date.now()}`);
	mkdirSync(testDir, { recursive: true });
	vi.stubEnv("HOME", testDir);
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function makeCheck(id: string): AgentCheck {
	return { id, description: "", lookFor: [] };
}

describe("inspectProject", () => {
	test("detects connection string in .env", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		writeFileSync(
			join(testDir, ".env"),
			"DATABASE_URL=postgresql://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
		);

		const result = await inspectProject([makeCheck("connection_string")]);
		expect(result.connectionString).toBe(true);

		process.cwd = originalCwd;
	});

	test("returns false when no neon connection string", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		writeFileSync(
			join(testDir, ".env"),
			"DATABASE_URL=postgresql://localhost:5432/mydb",
		);

		const result = await inspectProject([makeCheck("connection_string")]);
		expect(result.connectionString).toBe(false);

		process.cwd = originalCwd;
	});

	test("detects framework and ORM from package.json", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify({
				dependencies: { next: "14.0.0", "@prisma/client": "5.0.0" },
				devDependencies: { prisma: "5.0.0" },
			}),
		);

		const result = await inspectProject([makeCheck("project_stack")]);
		expect(result.framework).toBe("next");
		expect(result.orm).toBe("prisma");

		process.cwd = originalCwd;
	});

	test("detects prisma migrations", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		mkdirSync(join(testDir, "prisma", "migrations"), { recursive: true });
		writeFileSync(
			join(testDir, "prisma", "schema.prisma"),
			"generator client {}",
		);

		const result = await inspectProject([makeCheck("migrations")]);
		expect(result.migrationTool).toBe("prisma");
		expect(result.migrationDir).toBe("prisma/migrations");

		process.cwd = originalCwd;
	});

	test("detects drizzle config", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		writeFileSync(join(testDir, "drizzle.config.ts"), "export default {}");
		mkdirSync(join(testDir, "drizzle"), { recursive: true });

		const result = await inspectProject([makeCheck("migrations")]);
		expect(result.migrationTool).toBe("drizzle");
		expect(result.migrationDir).toBe("drizzle");

		process.cwd = originalCwd;
	});

	test("returns none when no migrations found", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		const result = await inspectProject([makeCheck("migrations")]);
		expect(result.migrationTool).toBe("none");

		process.cwd = originalCwd;
	});

	test("detects MCP server in cursor config", async () => {
		const originalCwd = process.cwd;
		process.cwd = () => testDir;

		mkdirSync(join(testDir, ".cursor"), { recursive: true });
		writeFileSync(
			join(testDir, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: { Neon: { url: "https://mcp.neon.tech/mcp" } },
			}),
		);

		const result = await inspectProject([makeCheck("mcp_server")]);
		expect(result.mcpConfigured).toBe(true);

		process.cwd = originalCwd;
	});

	test("detects VS Code-based IDE from env", async () => {
		vi.stubEnv("TERM_PROGRAM", "cursor");

		const result = await inspectProject([makeCheck("ide_type")]);
		expect(result.isVscodeIde).toBe(true);
	});
});
