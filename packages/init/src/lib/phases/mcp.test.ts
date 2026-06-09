import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
	isAuthenticated: vi.fn(),
}));

import { isAuthenticated } from "../auth.js";
import { handleMcpPhase } from "./mcp.js";

const mockIsAuthenticated = vi.mocked(isAuthenticated);

describe("handleMcpPhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

	test("--install returns run_command when authenticated", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await handleMcpPhase({
			agent: "claude",
			install: true,
		});

		expect(result.status).toBe("installing");
		expect(result.nextAction.type).toBe("run_command");
		if (result.nextAction.type === "run_command") {
			expect(result.nextAction.command).toContain("add-mcp");
			expect(result.nextAction.command).toContain("mcp.neon.tech");
			// After install, should chain to skills, not loop back to MCP
			expect(result.nextAction.onSuccess.args).toContain("skills");
			expect(result.nextAction.onSuccess.args).toContain("--install");
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
