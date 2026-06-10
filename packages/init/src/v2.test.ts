import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock dependencies
vi.mock("./lib/auth.js", () => ({
	isAuthenticated: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock("node:path", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual };
});

vi.mock("./lib/skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

vi.mock("./lib/resolve-context.js", () => ({
	resolveNeonContext: vi.fn().mockResolvedValue(null),
}));

import { isAuthenticated } from "./lib/auth.js";
import { orchestrate } from "./v2.js";

const mockIsAuthenticated = vi.mocked(isAuthenticated);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// Helpers to build filesystem mocks
function mockFs(files: Record<string, string>) {
	mockExistsSync.mockImplementation((p) => {
		const path = String(p);
		return Object.keys(files).some((f) => path.endsWith(f));
	});
	mockReadFileSync.mockImplementation((p) => {
		const path = String(p);
		for (const [suffix, content] of Object.entries(files)) {
			if (path.endsWith(suffix)) return content;
		}
		return "";
	});
}

/** Simulate MCP + skills installed (Cursor config with neon, neon-postgres skill dir) */
function mockToolingInstalled(extraFiles: Record<string, string> = {}) {
	const files: Record<string, string> = {
		".cursor/mcp.json":
			'{"mcpServers":{"Neon":{"url":"https://mcp.neon.tech/mcp"}}}',
		// skills directory exists and contains neon-postgres skill with SKILL.md
		".cursor/skills/neon-postgres/SKILL.md": "",
		...extraFiles,
	};
	mockFs(files);
}

describe("v2 orchestrator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
	});

	test("returns auth phase with ask_user when not authenticated", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await orchestrate({ agent: "claude" });

		expect(result.phase).toBe("auth");
		expect(result.status).toBe("required");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			expect(result.nextAction.responseMapping).toHaveProperty(
				"existing_account",
			);
			expect(result.nextAction.responseMapping).toHaveProperty(
				"new_account",
			);
		}
	});

	test("enters setup phase when no tooling is installed", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await orchestrate({ agent: "claude" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			expect(result.nextAction.userPreferences?.[0]?.id).toBe("mode");
		}
	});

	test("skips setup, goes to getting-started when MCP + skills installed but no connection string", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled();

		const result = await orchestrate({ agent: "cursor" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		expect(result.nextAction.type).toBe("agent_action");
	});

	test("skips setup and getting-started when fully configured, goes to neon_auth", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
			".neon": '{"projectId":"proj-123"}',
		});

		const result = await orchestrate({ agent: "cursor" });

		expect(result.phase).toBe("neon_auth");
		expect(result.nextAction.type).toBe("ask_user");
	});

	test("skips neon_auth when --skip-neon-auth is set", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
			".neon": '{"projectId":"proj-123"}',
		});

		const result = await orchestrate({
			agent: "claude",
			skipNeonAuth: true,
		});

		expect(result.phase).toBe("migrations");
	});

	test("reaches complete when all phases are satisfied or skipped", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb\nNEON_AUTH_TOKEN=abc",
			".neon": '{"projectId":"proj-123"}',
		});

		const result = await orchestrate({
			agent: "claude",
			skipMigrations: true,
		});

		expect(result.nextAction.type).toBe("complete");
		if (result.nextAction.type === "complete") {
			expect(result.nextAction.message).toContain("complete");
		}
	});

	test("enters setup even with DATABASE_URL if MCP not configured", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockFs({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
		});

		const result = await orchestrate({ agent: "cursor" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
	});

	test("auth phase existing_account maps to inline run_command", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await orchestrate({ agent: "cursor" });

		if (result.nextAction.type === "ask_user") {
			const existing = result.nextAction.responseMapping.existing_account;
			expect("action" in existing).toBe(true);
			if ("action" in existing) {
				expect(existing.action.type).toBe("run_command");
			}
		}
	});

	test("passes detected stack info to getting-started phase", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			"package.json": JSON.stringify({
				dependencies: { next: "14.0.0", "@prisma/client": "5.0.0" },
				devDependencies: { prisma: "5.0.0" },
			}),
			"prisma/schema.prisma": "generator client {}",
		});

		const result = await orchestrate({ agent: "cursor" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		if (result.nextAction.type === "agent_action") {
			// Should include migration step since prisma was detected
			const stepIds = result.nextAction.steps.map(
				(s: { id: string }) => s.id,
			);
			expect(stepIds).toContain("run_migrations");
		}
	});
});
