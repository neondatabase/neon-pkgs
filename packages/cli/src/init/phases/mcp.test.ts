import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
	isAuthenticated: vi.fn(),
}));

const mockInstallMcp = vi.fn().mockReturnValue({
	ok: true,
	path: "/tmp/mcp.json",
});
vi.mock("../install_mcp.js", () => ({
	installNeonMcpServer: (...args: unknown[]) => mockInstallMcp(...args),
}));

import { isAuthenticated } from "../auth.js";
import { handleMcpPhase } from "./mcp.js";

const mockIsAuthenticated = vi.mocked(isAuthenticated);

describe("handleMcpPhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInstallMcp.mockReturnValue({
			ok: true,
			path: "/tmp/mcp.json",
		});
	});

	test("asks agent to detect MCP by default", async () => {
		const result = await handleMcpPhase({ agent: "claude" });

		expect(result.phase).toBe("tooling");
		expect(result.status).toBe("detection_needed");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			expect(result.nextAction.checks[0].id).toBe("mcp_server");
			expect(result.nextAction.reportBack.args).toContain(
				"--mcp-configured",
			);
		}
	});

	test("chains to skills install when mcp-configured is true", async () => {
		const result = await handleMcpPhase({
			agent: "claude",
			mcpConfigured: true,
		});

		expect(result.status).toBe("mcp_configured");
		expect(result.nextAction.type).toBe("run_neon_init");
		if (result.nextAction.type === "run_neon_init") {
			expect(result.nextAction.args).toContain("skills");
			expect(result.nextAction.args).toContain("--install");
		}
	});

	test("omits project scope when the agent has no project MCP path", async () => {
		const result = await handleMcpPhase({
			agent: "windsurf",
			mcpConfigured: false,
		});

		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			const values = result.nextAction.options.map((option) =>
				typeof option === "string" ? option : option.value,
			);
			expect(values).toContain("defaults");
			expect(values).not.toContain("project_scope");
		}
	});

	test("asks user to install when mcp-configured is false", async () => {
		const result = await handleMcpPhase({
			agent: "claude",
			mcpConfigured: false,
		});

		expect(result.status).toBe("install_needed");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			expect(result.nextAction.responseMapping).toHaveProperty(
				"defaults",
			);
			expect(result.nextAction.responseMapping).toHaveProperty("skip");
		}
	});

	test("--install writes MCP in-process and chains to skills", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await handleMcpPhase({
			agent: "claude",
			install: true,
		});

		expect(result.status).toBe("installed");
		expect(mockInstallMcp).toHaveBeenCalledWith(
			expect.objectContaining({
				agent: "claude-code",
				scope: "global",
			}),
		);
		expect(result.nextAction.type).toBe("run_neon_init");
		if (result.nextAction.type === "run_neon_init") {
			expect(result.nextAction.args).toContain("skills");
			expect(result.nextAction.args).toContain("--install");
		}
	});

	test("--install skips skills when the agent has no skills target", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await handleMcpPhase({
			agent: "grok-build",
			install: true,
		});

		expect(result.status).toBe("installed");
		expect(result.nextAction.type).toBe("run_neon_init");
		if (result.nextAction.type === "run_neon_init") {
			expect(result.nextAction.args).not.toContain("skills");
		}
	});

	test("--install requires auth", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await handleMcpPhase({
			agent: "claude",
			install: true,
		});

		expect(result.status).toBe("auth_required");
		expect(result.nextAction.type).toBe("run_neon_init");
	});

	test("--status returns agent_check", async () => {
		const result = await handleMcpPhase({
			agent: "claude",
			status: true,
		});

		expect(result.status).toBe("status");
		expect(result.nextAction.type).toBe("agent_check");
	});
});
