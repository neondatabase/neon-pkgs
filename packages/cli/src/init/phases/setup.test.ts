import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
	isAuthenticated: vi.fn().mockResolvedValue(true),
}));

const mockFindEditorCommand = vi.fn().mockResolvedValue("/usr/bin/cursor");
vi.mock("../extension.js", () => ({
	findEditorCommand: (...args: unknown[]) => mockFindEditorCommand(...args),
}));

const mockExeca = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
vi.mock("execa", () => ({
	execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("../inspect.js", () => ({
	inspectProject: vi.fn().mockResolvedValue({
		isVscodeIde: true,
	}),
}));

vi.mock("../vsix.js", () => ({
	NEON_EXTENSION_ID: "databricks.neon-local-connect",
	downloadVsix: vi.fn().mockResolvedValue(null),
}));

const mockEnsureNeonctl = vi.fn();
vi.mock("../neonctl.js", () => ({
	ensureNeonctl: (...args: unknown[]) => mockEnsureNeonctl(...args),
}));

const mockInstallMcp = vi.fn();
vi.mock("../install_mcp.js", () => ({
	installNeonMcpServer: (...args: unknown[]) => mockInstallMcp(...args),
}));

const mockEnsureSkills = vi.fn().mockResolvedValue(true);
vi.mock("../skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		ensureSkillsUpToDate: (...args: unknown[]) => mockEnsureSkills(...args),
	};
});

vi.mock("node:fs/promises", () => ({
	unlink: vi.fn().mockReturnValue(Promise.resolve()),
}));

// Mock global fetch for Open VSX VSIX download
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { handleSetupPhase } from "./setup.js";

describe("setup phase", () => {
	beforeEach(() => {
		mockEnsureNeonctl.mockReset().mockResolvedValue({
			status: "already_current",
			version: "2.23.1",
		});
		mockExeca.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
		mockInstallMcp.mockReset().mockReturnValue({
			ok: true,
			path: "/tmp/mcp.json",
		});
		mockEnsureSkills.mockReset().mockResolvedValue(true);
		mockFindEditorCommand.mockReset().mockResolvedValue("/usr/bin/cursor");
		mockFetch.mockReset().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					version: "1.0.0",
					files: {
						download:
							"https://open-vsx.org/api/databricks/neon-local-connect/1.0.0/file/databricks.neon-local-connect-1.0.0.vsix",
					},
				}),
			body: "mock-stream",
		});
	});

	test("returns inspection checks with phased userPreferences and instructions", async () => {
		const result = await handleSetupPhase({ agent: "claude" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
		expect(result.nextAction.type).toBe("agent_check");

		if (result.nextAction.type === "agent_check") {
			// Should have explicit workflow instructions
			expect(result.nextAction.instructions).toBeDefined();
			expect(result.nextAction.instructions).toContain("ONE AT A TIME");
			expect(result.nextAction.instructions).toContain("condition");

			// Only agent-specific checks — filesystem checks are done CLI-side
			const checkIds = result.nextAction.checks.map((c) => c.id);
			expect(checkIds).toContain("neonctl");
			expect(checkIds).toContain("mcp_server");
			expect(checkIds).toContain("agent_type");
			expect(checkIds).not.toContain("connection_string");
			expect(checkIds).not.toContain("project_stack");

			// reportBack data schema should only require agent-provided fields
			const dataPlaceholder = result.nextAction.reportBack.args.find(
				(a: string) => a.includes("json:"),
			);
			expect(dataPlaceholder).toContain("agent");
			expect(dataPlaceholder).toContain("mcpConfigured");
			// Should NOT ask for features or stack info anymore.
			expect(dataPlaceholder).not.toContain("framework");
			expect(dataPlaceholder).not.toContain("features");

			// reportBack should use --data flag
			expect(result.nextAction.reportBack.args[0]).toBe("setup");
			expect(result.nextAction.reportBack.args).toContain("--data");

			// No feature/consent preference — mode should be first
			const prefs = result.nextAction.userPreferences ?? [];
			expect(prefs.find((p) => p.id === "consent")).toBeUndefined();
			expect(prefs.find((p) => p.id === "features")).toBeUndefined();
			expect(prefs.find((p) => p.id === "template")).toBeUndefined();

			const modePref = prefs.find((p) => p.id === "mode");
			expect(modePref?.phase).toBe("after_checks");

			const mcpScopePref = prefs.find((p) => p.id === "mcpScope");
			expect(mcpScopePref?.phase).toBe("after_checks");
			expect(mcpScopePref?.condition).toEqual({
				preferenceId: "mode",
				equals: "customize",
			});

			const extensionPref = prefs.find(
				(p) => p.id === "installExtension",
			);
			expect(extensionPref?.condition).toEqual({
				preferenceId: "mode",
				equals: "customize",
			});
		}
	});

	test("defaults mode executes installation and hands off to the agent", async () => {
		const result = await handleSetupPhase({
			agent: "vscode",
			mcpConfigured: false,
			isVscodeIde: true,
			mode: "defaults",
		});

		expect(result.phase).toBe("setup");
		// CLI executed the installs
		expect(result.status).toBe("installed");
		expect(result.results).toBeDefined();

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("neonctl");
		expect(resultIds).toContain("install_mcp");
		expect(resultIds).toContain("install_skills");
		expect(resultIds).not.toContain("install_extension");
		expect(results.every((r) => r.status === "success")).toBe(true);

		// nextAction hands off to the agent — no more neon init commands.
		expect(result.nextAction.type).toBe("complete");
		if (result.nextAction.type === "complete") {
			expect(result.nextAction.message).toContain("tooling is installed");
		}

		// MCP is installed via the add-mcp library (not execa); skills via ensureSkillsUpToDate.
		// No extension in defaults mode, so execa is never called.
		expect(mockExeca).not.toHaveBeenCalled();
		expect(mockEnsureSkills).toHaveBeenCalled();

		// MCP should be installed at global scope
		expect(mockInstallMcp).toHaveBeenCalledTimes(1);
		expect(mockInstallMcp.mock.calls[0][0]).toMatchObject({
			scope: "global",
		});
	});

	test("defaults mode skips MCP when already configured", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: true,
			isVscodeIde: false,
			mode: "defaults",
		});

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("skip_mcp");
		expect(resultIds).not.toContain("install_mcp");
		// Should not have install_extension since not a vscode IDE
		expect(resultIds).not.toContain("install_extension");

		expect(result.nextAction.type).toBe("complete");
	});

	test("customize mode goes straight to execution and hands off", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			isVscodeIde: true,
			mode: "customize",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");
		expect(result.nextAction.type).toBe("complete");
	});

	test("defaults mode does not install the Cursor extension", async () => {
		mockFindEditorCommand.mockResolvedValue(
			"/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
		);

		const result = await handleSetupPhase({
			agent: "cursor",
			mcpConfigured: false,
			isVscodeIde: true,
			mode: "defaults",
		});

		const results = result.results as {
			id: string;
			status: string;
			description: string;
			manualAction?: boolean;
		}[];
		const extResult = results.find((r) => r.id === "install_extension");
		expect(extResult).toBeUndefined();
	});

	test("custom install falls back to manual when extension installation fails", async () => {
		mockFindEditorCommand.mockResolvedValue("/usr/bin/cursor");
		// Make direct install fail
		mockExeca.mockImplementation((_cmd: string, args: string[]) => {
			if (args?.includes?.("--install-extension")) {
				return Promise.reject(new Error("install failed"));
			}
			return Promise.resolve({ stdout: "", stderr: "" });
		});

		const result = await handleSetupPhase({
			agent: "cursor",
			mcpConfigured: false,
			isVscodeIde: true,
			mode: "customize",
			installExtension: true,
		});

		const results = result.results as {
			id: string;
			status: string;
			manualAction?: boolean;
		}[];
		const extResult = results.find((r) => r.id === "install_extension");
		expect(extResult?.status).toBe("success");
		expect(extResult?.manualAction).toBe(true);
	});

	test("customize mode with scopes installs MCP at project scope", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			isVscodeIde: true,
			mode: "customize",
			mcpScope: "project",
			skillsScope: "global",
			installExtension: false,
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("install_mcp");
		expect(resultIds).toContain("install_skills");
		// Extension should NOT be installed since installExtension=false
		expect(resultIds).not.toContain("install_extension");

		// MCP should be installed at project scope
		expect(mockInstallMcp).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "project" }),
		);
	});

	test("execute flag triggers installation directly", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			isVscodeIde: false,
			mcpScope: "project",
			skillsScope: "project",
			execute: true,
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");

		// MCP should be installed at project scope
		expect(mockInstallMcp).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "project" }),
		);
	});

	test("reports partial status when some installs fail", async () => {
		// MCP succeeds (default mock), skills fails
		mockEnsureSkills.mockResolvedValueOnce(false);

		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			isVscodeIde: false,
			mode: "defaults",
		});

		expect(result.status).toBe("partial");

		const results = result.results as {
			id: string;
			status: string;
			error?: string;
		}[];
		expect(results.find((r) => r.id === "install_mcp")?.status).toBe(
			"success",
		);
		expect(results.find((r) => r.id === "install_skills")?.status).toBe(
			"failed",
		);

		// Even on partial failure, hand off to the agent.
		expect(result.nextAction.type).toBe("complete");
	});
});
