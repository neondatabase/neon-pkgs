import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock dependencies
vi.mock("./auth.js", () => ({
	isAuthenticated: vi.fn(),
}));

// Deliberately not spread over the real module: an fs call this suite has not
// declared should fail loudly rather than reach the checkout, since `existsSync`
// here describes a filesystem that does not exist.
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	statSync: vi.fn(),
	// Identity: these paths are fictional, so there is no symlink to resolve.
	realpathSync: vi.fn((path: string) => path),
}));

vi.mock("node:path", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual };
});

vi.mock("./skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

vi.mock("./resolve_context.js", () => ({
	resolveNeonContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("./bootstrap.js", () => {
	const templates = [
		{
			id: "hono",
			title: "Hono API",
			description: "A Hono template.",
			requires: ["database"],
			source: {
				owner: "neondatabase",
				repo: "examples",
				ref: "main",
				subdir: "with-hono",
			},
		},
	];
	return {
		fetchTemplates: vi.fn().mockResolvedValue(templates),
		FALLBACK_TEMPLATES: templates,
		findTemplate: (ts: typeof templates, id: string) =>
			ts.find((t) => t.id === id),
		scaffoldTemplate: vi.fn().mockResolvedValue(1),
	};
});

import { isAuthenticated } from "./auth.js";
import { orchestrate } from "./orchestrate.js";

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

const APP_PKG_JSON = JSON.stringify({
	dependencies: { next: "14.0.0" },
});

/** Simulate an app existing (package.json with deps) plus optional extra files */
function mockAppExists(extraFiles: Record<string, string> = {}) {
	mockFs({ "package.json": APP_PKG_JSON, ...extraFiles });
}

/** Simulate MCP + skills installed (Cursor config with neon, neon-postgres skill dir) */
function mockToolingInstalled(extraFiles: Record<string, string> = {}) {
	const files: Record<string, string> = {
		"package.json": APP_PKG_JSON,
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

	test("enters setup with bootstrap when no app is detected and --preview", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await orchestrate({ agent: "claude", preview: true });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("bootstrap_needed");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			// Should include template preference before mode
			const prefs = result.nextAction.userPreferences ?? [];
			expect(prefs[0]?.id).toBe("template");
			// skillsScope is present but conditional on customize mode
			// (if user picks a template, skills are bundled; if not, they need scope choice)
			const skillsPref = prefs.find((p) => p.id === "skillsScope");
			if (skillsPref) {
				expect(skillsPref.condition).toEqual({
					preferenceId: "mode",
					equals: "customize",
				});
			}
		}
	});

	test("skips bootstrap without --preview even when no app detected", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await orchestrate({ agent: "claude" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
		if (result.nextAction.type === "agent_check") {
			const prefs = result.nextAction.userPreferences ?? [];
			expect(prefs.find((p) => p.id === "template")).toBeUndefined();
		}
	});

	test("enters setup phase when no tooling is installed", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockAppExists();

		const result = await orchestrate({ agent: "claude" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			const prefs = result.nextAction.userPreferences ?? [];
			// Brownfield: features question first, then mode
			expect(prefs[0]?.id).toBe("features");
			expect(prefs[1]?.id).toBe("mode");
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

	test("skips setup and getting-started when fully configured, goes to migrations", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
			".neon": '{"projectId":"proj-123"}',
		});

		const result = await orchestrate({ agent: "cursor" });

		// With no features set, neon_auth is skipped, goes to migrations
		expect(result.phase).toBe("migrations");
	});

	test("skips neon_auth when features are empty", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
			".neon": '{"projectId":"proj-123"}',
		});

		const result = await orchestrate({
			agent: "claude",
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

	test("skips neon_auth when .neon _init features don't include auth", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
			".neon":
				'{"projectId":"proj-123","_init":{"features":["database"]}}',
		});

		const result = await orchestrate({ agent: "claude" });

		// Should skip neon_auth and go to migrations
		expect(result.phase).toBe("migrations");
	});

	test("runs neon_auth when .neon _init features include auth", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled({
			".env": "DATABASE_URL=postgres://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb",
			".neon":
				'{"projectId":"proj-123","_init":{"features":["database","auth"]}}',
		});

		const result = await orchestrate({ agent: "claude" });

		expect(result.phase).toBe("neon_auth");
	});

	test("enters setup even with DATABASE_URL if MCP not configured", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockAppExists({
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
