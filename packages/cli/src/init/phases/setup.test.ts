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
		connectionString: false,
		framework: "next",
		orm: "prisma",
		migrationTool: "prisma",
		migrationDir: "prisma/migrations",
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

vi.mock("../bootstrap.js", () => {
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
			expect(checkIds).toContain("neon");
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
			// Should NOT require framework/orm/etc — CLI handles those
			expect(dataPlaceholder).not.toContain("framework");

			// reportBack should use --data flag
			expect(result.nextAction.reportBack.args[0]).toBe("setup");
			expect(result.nextAction.reportBack.args).toContain("--data");

			// No consent preference — mode should be first
			const prefs = result.nextAction.userPreferences ?? [];
			expect(prefs.find((p) => p.id === "consent")).toBeUndefined();

			const modePref = prefs.find((p) => p.id === "mode");
			expect(modePref?.phase).toBe("after_checks");
			const defaultsOption = modePref?.options.find(
				(option) =>
					typeof option !== "string" && option.value === "defaults",
			);
			expect(
				typeof defaultsOption === "string"
					? defaultsOption
					: defaultsOption?.label,
			).not.toContain("extension");

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

	test("asks defaults vs customize after inspection results received (legacy flags)", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: false,
			framework: "next",
			orm: "prisma",
			migrationTool: "prisma",
			migrationDir: "prisma/migrations",
			isVscodeIde: true,
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
		expect(result.nextAction.type).toBe("agent_check");

		if (result.nextAction.type === "agent_check") {
			const prefs = (
				result.nextAction as unknown as Record<string, unknown>
			).userPreferences as { id: string }[];
			expect(prefs.some((p) => p.id === "mode")).toBe(true);
		}
	});

	test("defaults mode executes installation and chains to getting-started", async () => {
		const result = await handleSetupPhase({
			agent: "vscode",
			mcpConfigured: false,
			connectionString: false,
			framework: "next",
			orm: "prisma",
			isVscodeIde: true,
			mode: "defaults",
		});

		expect(result.phase).toBe("setup");
		// CLI executed the installs
		expect(result.status).toBe("installed");
		expect(result.results).toBeDefined();

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("neon");
		expect(resultIds).toContain("install_mcp");
		expect(resultIds).toContain("install_skills");
		expect(resultIds).not.toContain("install_extension");
		expect(results.every((r) => r.status === "success")).toBe(true);

		// nextAction should chain to the getting-started CLI command
		expect(result.nextAction.type).toBe("run_neon_init");
		const args = (result.nextAction as { args: string[] }).args;
		expect(args[0]).toBe("getting-started");

		// Should have called execa for MCP only (neon CLI mocked, skills via ensureSkillsUpToDate)
		expect(mockExeca).toHaveBeenCalledTimes(1);
		expect(mockEnsureSkills).toHaveBeenCalled();

		// MCP call should use -g for global scope
		const mcpCall = mockExeca.mock.calls[0];
		expect(mcpCall[0]).toBe("npx");
		expect(mcpCall[1]).toContain("-g");
		expect(mcpCall[1]).toContain("add-mcp");
	});

	test("defaults mode skips MCP when already configured", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: true,
			connectionString: true,
			framework: "express",
			orm: "none",
			isVscodeIde: false,
			mode: "defaults",
		});

		const results = result.results as { id: string; status: string }[];
		const resultIds = results.map((r) => r.id);
		expect(resultIds).toContain("skip_mcp");
		expect(resultIds).not.toContain("install_mcp");
		// Should not have install_extension since not a vscode IDE
		expect(resultIds).not.toContain("install_extension");

		// nextAction should chain to getting-started with --data containing hasConnectionString
		if (result.nextAction.type === "run_neon_init") {
			expect(result.nextAction.args).toContain("--data");
			const dataArg =
				result.nextAction.args[
					result.nextAction.args.indexOf("--data") + 1
				];
			expect(JSON.parse(dataArg)).toHaveProperty(
				"hasConnectionString",
				true,
			);
		}
	});

	test("customize mode goes straight to execution", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: false,
			framework: "none",
			orm: "none",
			isVscodeIde: true,
			mode: "customize",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");
	});

	test("customize mode without vscode IDE omits extension options", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: false,
			framework: "none",
			orm: "none",
			isVscodeIde: false,
			mode: "customize",
		});

		if (result.nextAction.type === "ask_user") {
			const optionValues = (
				result.nextAction.options as { value: string; label: string }[]
			).map((o) => o.value);
			expect(optionValues).not.toContain("global_project_noext");
		}
	});

	test("defaults mode does not install the Cursor extension", async () => {
		mockFindEditorCommand.mockResolvedValue(
			"/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
		);

		const result = await handleSetupPhase({
			agent: "cursor",
			mcpConfigured: false,
			connectionString: false,
			framework: "django",
			orm: "none",
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
			connectionString: false,
			framework: "none",
			orm: "none",
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

	test("--data with defaults mode executes installation directly", async () => {
		const result = await handleSetupPhase({
			agent: "cursor",
			mcpConfigured: false,
			connectionString: false,
			framework: "next",
			orm: "prisma",
			migrationTool: "prisma",
			migrationDir: "prisma/migrations",
			isVscodeIde: true,
			mode: "defaults",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");

		const results = result.results as { id: string; status: string }[];
		expect(results.every((r) => r.status === "success")).toBe(true);

		// nextAction should chain to the getting-started CLI command
		expect(result.nextAction.type).toBe("run_neon_init");
		const args = (result.nextAction as { args: string[] }).args;
		expect(args[0]).toBe("getting-started");
	});

	test("--data with customize mode and scopes executes installation directly", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: true,
			framework: "remix",
			orm: "drizzle",
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

		// MCP should be project scope (no -g flag)
		const mcpCall = mockExeca.mock.calls.find((call) =>
			call[1]?.includes("add-mcp"),
		);
		expect(mcpCall?.[1]).not.toContain("-g");
	});

	test("--data with customize mode goes straight to execution", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: false,
			framework: "none",
			orm: "none",
			isVscodeIde: true,
			mode: "customize",
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");
	});

	test("execute flag triggers installation directly", async () => {
		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: true,
			framework: "remix",
			orm: "drizzle",
			isVscodeIde: false,
			mcpScope: "project",
			skillsScope: "project",
			execute: true,
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("installed");

		// MCP call should not include -g for project scope
		const mcpCall = mockExeca.mock.calls.find((call) =>
			call[1]?.includes("add-mcp"),
		);
		expect(mcpCall?.[1]).not.toContain("-g");
	});

	test("reports partial status when some installs fail", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "", stderr: "" }); // MCP succeeds
		// Skills fails
		mockEnsureSkills.mockResolvedValueOnce(false);

		const result = await handleSetupPhase({
			agent: "claude",
			mcpConfigured: false,
			connectionString: false,
			framework: "none",
			orm: "none",
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

		// Should still proceed to getting-started even with partial failure
		expect(result.nextAction.type).toBe("run_neon_init");
		const args = (result.nextAction as { args: string[] }).args;
		expect(args[0]).toBe("getting-started");
	});
});
