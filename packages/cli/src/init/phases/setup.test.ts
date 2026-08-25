import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
	isAuthenticated: vi.fn().mockResolvedValue(true),
}));

const mockExeca = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
vi.mock("execa", () => ({
	execa: (...args: unknown[]) => mockExeca(...args),
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
			expect(checkIds).not.toContain("extension_installed");

			// reportBack data schema should only require agent-provided fields
			const dataPlaceholder = result.nextAction.reportBack.args.find(
				(a: string) => a.includes("json:"),
			);
			expect(dataPlaceholder).toContain("agent");
			expect(dataPlaceholder).toContain("mcpConfigured");
			// Should NOT ask for features or stack info anymore.
			expect(dataPlaceholder).not.toContain("framework");
			expect(dataPlaceholder).not.toContain("features");
			expect(dataPlaceholder).not.toContain("installExtension");

			// reportBack should use --data flag
			expect(result.nextAction.reportBack.args[0]).toBe("setup");
			expect(result.nextAction.reportBack.args).toContain("--data");

			// No feature/consent preference — mode should be first
			const prefs = result.nextAction.userPreferences ?? [];
			expect(prefs.find((p) => p.id === "consent")).toBeUndefined();
			expect(prefs.find((p) => p.id === "features")).toBeUndefined();
			expect(prefs.find((p) => p.id === "template")).toBeUndefined();
			expect(
				prefs.find((p) => p.id === "installExtension"),
			).toBeUndefined();

			const modePref = prefs.find((p) => p.id === "mode");
			expect(modePref?.phase).toBe("after_checks");

			const mcpScopePref = prefs.find((p) => p.id === "mcpScope");
			expect(mcpScopePref?.phase).toBe("after_checks");
			expect(mcpScopePref?.condition).toEqual({
				preferenceId: "mode",
				equals: "customize",
			});
		}
	});

	test("defaults mode executes installation and hands off to the agent", async () => {
		const result = await handleSetupPhase({
			agent: "vscode",
			mcpConfigured: false,
			mode: "defaults",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");
		expect(result.results).toBeDefined();

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("neonctl");
		expect(resultIds).toContain("install_mcp");
		expect(resultIds).toContain("install_skills");
		expect(results.every((r) => r.status === "success")).toBe(true);

		// nextAction hands off to the agent — no more neon init commands.
		expect(result.nextAction.type).toBe("complete");
		if (result.nextAction.type === "complete") {
			expect(result.nextAction.message).toContain("tooling is installed");
		}

		// MCP is installed via the add-mcp library (not execa); skills via ensureSkillsUpToDate.
		expect(mockExeca).not.toHaveBeenCalled();
		expect(mockEnsureSkills).toHaveBeenCalled();

		expect(mockInstallMcp).toHaveBeenCalledTimes(1);
		expect(mockInstallMcp.mock.calls[0][0]).toMatchObject({
			scope: "global",
		});
	});

	test("defaults mode skips MCP when already configured", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: true,
			mode: "defaults",
		});

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("skip_mcp");
		expect(resultIds).not.toContain("install_mcp");

		expect(result.nextAction.type).toBe("complete");
	});

	test("customize mode goes straight to execution and hands off", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			mode: "customize",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");
		expect(result.nextAction.type).toBe("complete");
	});

	test("customize mode with scopes installs MCP at project scope", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			mode: "customize",
			mcpScope: "project",
			skillsScope: "global",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("install_mcp");
		expect(resultIds).toContain("install_skills");

		// MCP should be installed at project scope
		expect(mockInstallMcp).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "project" }),
		);
	});

	test("execute flag triggers installation directly", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
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
