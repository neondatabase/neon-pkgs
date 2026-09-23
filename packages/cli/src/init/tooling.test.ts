import { describe, expect, test, vi } from "vitest";
import type { AgentType } from "../mcp/agents.js";
import { runAgentTooling, runToolingSteps } from "./tooling.js";

const auth = {
	apiClient: {} as never,
	apiKey: "",
	apiHost: "https://console.neon.tech/api/v2",
	contextFile: "/app/.neon",
};

const pluginsOutcome = {
	scope: "project" as const,
	rows: [],
	failed: [],
};
const skillsOutcome = {
	scope: "project" as const,
	agents: [],
	rows: [],
	failed: [],
};
const mcpOutcome = {
	scope: "project" as const,
	rows: [],
	failedAgents: [],
	url: "https://mcp.neon.tech/mcp",
	auth: "oauth" as const,
};

const operations = () => ({
	installPlugins: vi.fn().mockResolvedValue(pluginsOutcome),
	installSkills: vi.fn().mockResolvedValue(skillsOutcome),
	installMcp: vi.fn().mockResolvedValue(mcpOutcome),
});

describe("runAgentTooling", () => {
	test("a resolved agentSetup does not call the picker", async () => {
		const ops = operations();
		const pickAgentSetup = vi.fn(async (): Promise<"plugin"> => "plugin");
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			output: "table",
			auth,
			operations: ops,
			agentSetup: "skills-mcp",
			pickAgentSetup,
		});
		expect(pickAgentSetup).not.toHaveBeenCalled();
		expect(ops.installSkills).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/app" }),
		);
		expect(ops.installMcp).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/app" }),
		);
		expect(ops.installPlugins).not.toHaveBeenCalled();
	});

	test("interactive does not run -y detectors", async () => {
		const ops = operations();
		const detectProjectAgents = vi.fn((): readonly AgentType[] => [
			"cursor",
		]);
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			output: "table",
			auth,
			operations: ops,
			pickAgentSetup: async () => "skip",
			detectProjectAgents,
			detectAgent,
		});
		expect(detectProjectAgents).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(ops.installPlugins).not.toHaveBeenCalled();
		expect(ops.installSkills).not.toHaveBeenCalled();
		expect(ops.installMcp).not.toHaveBeenCalled();
	});

	test("named agents skip detection and the picker", async () => {
		const ops = operations();
		const pickAgentSetup = vi.fn(async () => "skip" as const);
		const detectAgent = vi.fn((): AgentType | null => "vscode");
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			output: "table",
			auth,
			operations: ops,
			agents: ["cursor", "claude-code"],
			pickAgentSetup,
			detectAgent,
		});
		expect(pickAgentSetup).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(ops.installPlugins).toHaveBeenCalledWith(
			expect.objectContaining({
				agents: ["cursor", "claude-code"],
				cwd: "/app",
			}),
		);
	});

	test("named -y forwards agents and skips host detection", async () => {
		const ops = operations();
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		await runAgentTooling({
			cwd: "/app",
			yes: true,
			output: "table",
			auth,
			operations: ops,
			agents: ["vscode"],
			detectProjectAgents: () => ["cursor"],
			detectAgent,
		});
		expect(detectAgent).not.toHaveBeenCalled();
		expect(ops.installSkills).toHaveBeenCalledWith(
			expect.objectContaining({ agents: ["vscode"], cwd: "/app" }),
		);
		expect(ops.installMcp).toHaveBeenCalledWith(
			expect.objectContaining({ agents: ["vscode"], cwd: "/app" }),
		);
	});

	test("named cursor plus vscode fails on bootstrap instead of dropping vscode", async () => {
		const ops = operations();
		await expect(
			runAgentTooling({
				cwd: "/app",
				yes: true,
				output: "table",
				auth,
				operations: ops,
				command: "bootstrap",
				agents: ["cursor", "vscode"],
			}),
		).rejects.toThrow(/plugin and skills\/MCP/);
		expect(ops.installPlugins).not.toHaveBeenCalled();
		expect(ops.installSkills).not.toHaveBeenCalled();
	});
});

describe("runToolingSteps", () => {
	test("human narrate prints the step label", async () => {
		const ops = operations();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await runToolingSteps([{ kind: "plugins", options: { yes: true } }], {
			cwd: "/app",
			output: "table",
			auth,
			operations: ops,
			narrate: "human",
		});
		expect(
			stdout.mock.calls.map((call) => String(call[0])).join(""),
		).toContain("Installing the Neon plugin...");
		stdout.mockRestore();
	});

	test("non-human narrate logs a reconstructed command instead", async () => {
		const ops = operations();
		const info = vi.spyOn(console, "error").mockImplementation(() => {});
		await runToolingSteps(
			[{ kind: "mcp", options: { yes: true, oauth: true } }],
			{ cwd: "/app", output: "table", auth, operations: ops },
		);
		info.mockRestore();
		expect(ops.installMcp).toHaveBeenCalledWith(
			expect.objectContaining({ yes: true, oauth: true, cwd: "/app" }),
		);
	});

	test("throws the plugins error and does not run later steps", async () => {
		const ops = operations();
		ops.installPlugins.mockResolvedValue({
			...pluginsOutcome,
			failed: [{ agents: ["cursor"], message: "boom" }],
		});
		await expect(
			runToolingSteps(
				[
					{ kind: "plugins", options: { yes: true } },
					{ kind: "skills", options: { yes: true } },
				],
				{ cwd: "/app", output: "table", auth, operations: ops },
			),
		).rejects.toThrow(/Failed to install the Neon plugin/);
		expect(ops.installSkills).not.toHaveBeenCalled();
	});
});
