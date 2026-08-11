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
		".cursor/skills/neon/SKILL.md": "",
		...extraFiles,
	};
	mockFs(files);
}

describe("v2 orchestrator (minimal: install tooling, then hand off)", () => {
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

	test("enters setup phase when no tooling is installed", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockAppExists();

		const result = await orchestrate({ agent: "claude" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			const prefs = result.nextAction.userPreferences ?? [];
			// No feature question anymore — install preferences only, starting with mode.
			expect(prefs.find((p) => p.id === "features")).toBeUndefined();
			expect(prefs.find((p) => p.id === "template")).toBeUndefined();
			expect(prefs[0]?.id).toBe("mode");
		}
	});

	test("enters setup when MCP configured but skills missing", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockAppExists({
			".cursor/mcp.json":
				'{"mcpServers":{"Neon":{"url":"https://mcp.neon.tech/mcp"}}}',
		});

		const result = await orchestrate({ agent: "cursor" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
	});

	test("hands off to the agent once MCP + skills are installed", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockToolingInstalled();

		const result = await orchestrate({ agent: "cursor" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("complete");
		expect(result.nextAction.type).toBe("complete");
		if (result.nextAction.type === "complete") {
			expect(result.nextAction.message).toContain("tooling is installed");
		}
	});

	test("hand-off does not depend on a database or .neon file", async () => {
		mockIsAuthenticated.mockResolvedValue(true);
		// Tooling installed, no .env / no .neon — still a clean hand-off.
		mockToolingInstalled();

		const result = await orchestrate({ agent: "claude" });

		expect(result.nextAction.type).toBe("complete");
	});
});
