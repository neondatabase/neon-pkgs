import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./lib/install.js", () => ({
	installNeon: vi.fn(),
}));

vi.mock("./lib/auth.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		isAuthenticated: vi.fn().mockResolvedValue(true),
	};
});

vi.mock("./lib/skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		installAgentSkills: vi.fn().mockResolvedValue(true),
		fetchSkillContent: vi
			.fn()
			.mockResolvedValue("# Getting Started\n\nTest content"),
	};
});

vi.mock("./lib/editors.js", () => ({
	detectAvailableEditors: vi.fn().mockResolvedValue([]),
}));

vi.mock("./lib/extension.js", () => ({
	usesExtension: vi.fn((e: string) => e === "VS Code" || e === "Cursor"),
	installExtension: vi.fn(),
	waitForExtensionInstalled: vi.fn(),
	configureExtension: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: { error: vi.fn(), warn: vi.fn(), step: vi.fn(), info: vi.fn() },
	note: vi.fn(),
	multiselect: vi.fn(),
	isCancel: vi.fn().mockReturnValue(false),
	spinner: vi.fn().mockReturnValue({
		start: vi.fn(),
		stop: vi.fn(),
	}),
}));

import { init } from "./index.js";
import { isAuthenticated } from "./lib/auth.js";
import { installNeon } from "./lib/install.js";
import { fetchSkillContent, installAgentSkills } from "./lib/skills.js";
import type { InitResult } from "./lib/types.js";

const mockIsAuthenticated = vi.mocked(isAuthenticated);
const mockInstallNeon = vi.mocked(installNeon);
const mockInstallAgentSkills = vi.mocked(installAgentSkills);
const mockFetchSkillContent = vi.mocked(fetchSkillContent);

describe("init() with json mode", () => {
	const originalHome = process.env.HOME;

	beforeEach(() => {
		vi.clearAllMocks();
		mockIsAuthenticated.mockResolvedValue(true);
		mockInstallAgentSkills.mockResolvedValue(true);
		mockFetchSkillContent.mockResolvedValue(
			"# Getting Started\n\nTest content",
		);
		process.env.HOME = "/tmp/test-home";
	});

	afterEach(() => {
		process.env.HOME = originalHome;
	});

	test("returns structured InitResult on success", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.success).toBe(true);
		expect(result.auth).toBe(true);
		expect(result.editors).toEqual([
			{ editor: "Claude CLI", status: "success", type: "mcp" },
		]);
		expect(result.neonctl.authenticated).toBe(true);
		expect(result.neonctl.commands.listOrgs).toContain("neonctl orgs list");
		expect(result.neonctl.commands.listProjects).toContain(
			"neonctl projects list",
		);
		expect(result.neonctl.commands.createProject).toContain(
			"neonctl projects create",
		);
		expect(result.neonctl.commands.getConnectionString).toContain(
			"neonctl connection-string",
		);
		expect(result.mcpServer.configured).toBe(true);
		expect(result.mcpServer.requiresRestart).toBe(true);
	});

	test("includes skill references in JSON output", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.skills.installed).toBe(true);
		expect(result.skills.gettingStarted).toBe(
			"# Getting Started\n\nTest content",
		);
		expect(result.skills.references).toHaveProperty("connectionMethods");
		expect(result.skills.references).toHaveProperty("neonCli");
		expect(result.skills.references).not.toHaveProperty("gettingStarted");
	});

	test("handles auth failure in JSON mode", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "failed"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: false,
		});

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.success).toBe(false);
		expect(result.auth).toBe(false);
		expect(result.editors).toEqual([
			{ editor: "Claude CLI", status: "failed", type: "mcp" },
		]);
		expect(result.neonctl.authenticated).toBe(false);
	});

	test("returns failure when HOME is not set", async () => {
		delete process.env.HOME;
		delete process.env.USERPROFILE;

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.success).toBe(false);
		expect(result.auth).toBe(false);
	});

	test("does not call clack UI functions in JSON mode", async () => {
		const { intro, outro, note, log } = await import("@clack/prompts");

		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		await init({ agent: "Claude CLI", json: true });

		expect(intro).not.toHaveBeenCalled();
		expect(outro).not.toHaveBeenCalled();
		expect(note).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
		expect(log.step).not.toHaveBeenCalled();
		expect(log.info).not.toHaveBeenCalled();
	});

	test("calls clack UI functions in non-json mode", async () => {
		const { intro, outro, note } = await import("@clack/prompts");

		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		await init({ agent: "Claude CLI", json: false });

		expect(intro).toHaveBeenCalled();
		expect(outro).toHaveBeenCalled();
		expect(note).toHaveBeenCalled();
	});

	test("passes json flag to installNeon", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		await init({ agent: "Claude CLI", json: true });

		expect(mockInstallNeon).toHaveBeenCalledWith(["Claude CLI"], {
			json: true,
		});
	});

	test("passes json flag to installAgentSkills", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		await init({ agent: "Claude CLI", json: true });

		expect(mockInstallAgentSkills).toHaveBeenCalledWith(["Claude CLI"], {
			json: true,
		});
	});

	test("handles fetchSkillContent failure gracefully", async () => {
		mockFetchSkillContent.mockResolvedValue(null);

		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.success).toBe(true);
		expect(result.skills.gettingStarted).toBeNull();
	});

	test("result conforms to InitResult interface shape", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		const result: InitResult = await init({
			agent: "Claude CLI",
			json: true,
		});

		expect(typeof result.success).toBe("boolean");
		expect(typeof result.auth).toBe("boolean");
		expect(Array.isArray(result.editors)).toBe(true);
		expect(typeof result.skills.installed).toBe("boolean");
		expect(typeof result.neonctl.authenticated).toBe("boolean");
		expect(typeof result.neonctl.commands).toBe("object");
		expect(typeof result.mcpServer.configured).toBe("boolean");
		expect(typeof result.mcpServer.requiresRestart).toBe("boolean");
	});

	test("extension editors get type 'extension' in result", async () => {
		const resultsMap = new Map<string, string>([
			["Cursor", "success"],
			["Claude CLI", "success"],
		]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		const result = await init({ agent: "Cursor", json: true });

		const cursorEditor = result.editors.find((e) => e.editor === "Cursor");
		if (cursorEditor) {
			expect(cursorEditor.type).toBe("extension");
		}
	});

	test("returns authRequired when not authenticated in JSON mode", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.success).toBe(false);
		expect(result.auth).toBe(false);
		expect(result.authRequired).toBe(true);
		expect(result.authInstructions).toBeDefined();
		expect(result.authInstructions).toContain(
			"Do you already have a Neon account",
		);
		expect(result.authInstructions).toContain("NEW ACCOUNT");
		expect(result.authInstructions).toContain("/signup");
		expect(result.authInstructions).toContain("EXISTING ACCOUNT");
		expect(result.authInstructions).toContain("neonctl auth");
		expect(result.authInstructions).toContain("email verification");
		expect(result.authInstructions).toContain(
			"Do NOT write wrapper scripts",
		);
		expect(result.authInstructions).toContain("exit code 2");
		expect(result.authInstructions).toContain("Re-run neonctl init");
		expect(mockInstallNeon).not.toHaveBeenCalled();
	});

	test("authRequired result still includes skill references", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.skills.gettingStarted).toBe(
			"# Getting Started\n\nTest content",
		);
		expect(result.skills.references).toHaveProperty("connectionMethods");
		expect(result.skills.references).toHaveProperty("neonAuth");
	});

	test("success result includes agentInstructions", async () => {
		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.agentInstructions).toBeDefined();
		expect(result.agentInstructions).toContain("IMPORTANT");
		expect(result.agentInstructions).toContain("List organizations");
		expect(result.agentInstructions).toContain("List projects");
		expect(result.agentInstructions).toContain("Get connection string");
		expect(result.agentInstructions).toContain(
			"Do NOT auto-create a project",
		);
	});

	test("authRequired result does not include agentInstructions", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await init({ agent: "Claude CLI", json: true });

		expect(result.agentInstructions).toBeUndefined();
	});

	test("skips auth check in non-json mode", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const resultsMap = new Map<string, string>([["Claude CLI", "success"]]);
		mockInstallNeon.mockResolvedValue({
			results: resultsMap as never,
			authSuccess: true,
		});

		await init({ agent: "Claude CLI", json: false });

		expect(mockIsAuthenticated).not.toHaveBeenCalled();
		expect(mockInstallNeon).toHaveBeenCalled();
	});
});
