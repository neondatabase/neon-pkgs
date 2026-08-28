import { describe, expect, test, vi } from "vitest";

import type { AgentType } from "../mcp/agents.js";
import { runAgentTooling, runScaffoldFollowUp } from "./tooling.js";

const host = "https://console.neon.tech/api/v2";
const forward = {
	apiHost: host,
	contextFile: "/app/.neon",
};

describe("runScaffoldFollowUp", () => {
	test("--no-agent-setup and no link runs nothing", async () => {
		const run = vi.fn().mockResolvedValue(true);
		await runScaffoldFollowUp({
			cwd: "/app",
			yes: true,
			run,
			forward,
			skipAgentSetup: true,
			shouldLink: false,
			linkYes: true,
		});
		expect(run).not.toHaveBeenCalled();
	});

	test("--default without a project plugin agent: skills, mcp, link --yes", async () => {
		const run = vi.fn().mockResolvedValue(true);
		await runScaffoldFollowUp({
			cwd: "/app",
			yes: true,
			run,
			forward,
			skipAgentSetup: false,
			shouldLink: true,
			linkYes: true,
			hasProjectPlugins: async () => false,
		});
		expect(run.mock.calls.map((call) => call[0].slice(0, 2))).toEqual([
			["skills", "-y"],
			["mcp", "-y"],
			["link", "--yes"],
		]);
	});

	test("-y does not ask host when the project has agents", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const detectAgent = vi.fn((): AgentType | null => "claude-code");
		await runScaffoldFollowUp({
			cwd: "/app",
			yes: true,
			run,
			forward,
			skipAgentSetup: false,
			shouldLink: true,
			linkYes: true,
			detectProjectAgents: () => ["cursor"],
			detectAgent,
		});
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0].slice(0, 2)).toEqual(["plugins", "-y"]);
	});

	test("interactive plugin then link", async () => {
		const run = vi.fn().mockResolvedValue(true);
		await runScaffoldFollowUp({
			cwd: "/app",
			yes: false,
			run,
			forward,
			skipAgentSetup: false,
			shouldLink: true,
			linkYes: false,
			pickAgentSetup: async () => "plugin",
		});
		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"link",
		]);
	});
});

describe("runAgentTooling", () => {
	test("a resolved agentSetup does not call the picker", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const pickAgentSetup = vi.fn(async (): Promise<"plugin"> => "plugin");
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			run,
			forward,
			agentSetup: "skills-mcp",
			pickAgentSetup,
		});
		expect(pickAgentSetup).not.toHaveBeenCalled();
		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
		]);
	});

	test("interactive does not run -y detectors", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const detectProjectAgents = vi.fn((): readonly AgentType[] => [
			"cursor",
		]);
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			run,
			forward,
			pickAgentSetup: async () => "skip",
			detectProjectAgents,
			detectAgent,
		});
		expect(detectProjectAgents).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	test("named agents skip detection and the picker", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const pickAgentSetup = vi.fn(async () => "skip" as const);
		const detectAgent = vi.fn((): AgentType | null => "vscode");
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			run,
			forward,
			agents: ["cursor", "claude-code"],
			pickAgentSetup,
			detectAgent,
		});
		expect(pickAgentSetup).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0].slice(0, 5)).toEqual([
			"plugins",
			"--agent",
			"cursor",
			"--agent",
			"claude-code",
		]);
	});

	test("named -y forwards --agent and skips host detection", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		await runAgentTooling({
			cwd: "/app",
			yes: true,
			run,
			forward,
			agents: ["vscode"],
			detectProjectAgents: () => ["cursor"],
			detectAgent,
		});
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0].slice(0, 4)).toEqual([
			"skills",
			"-y",
			"--agent",
			"vscode",
		]);
		expect(run.mock.calls[1][0].slice(0, 4)).toEqual([
			"mcp",
			"-y",
			"--agent",
			"vscode",
		]);
	});

	test("named cursor plus vscode fails instead of dropping vscode", async () => {
		const run = vi.fn().mockResolvedValue(true);
		await expect(
			runAgentTooling({
				cwd: "/app",
				yes: true,
				run,
				forward,
				agents: ["cursor", "vscode"],
			}),
		).rejects.toThrow(/plugin and skills\/MCP/);
		expect(run).not.toHaveBeenCalled();
	});
});
