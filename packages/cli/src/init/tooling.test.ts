import { describe, expect, test, vi } from "vitest";

import { log } from "../log.js";
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

	test("--default with no agents skips tooling and still links", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const info = vi.spyOn(log, "info");
		await runScaffoldFollowUp({
			cwd: "/app",
			yes: true,
			run,
			forward,
			skipAgentSetup: false,
			shouldLink: true,
			linkYes: true,
			detectProjectAgents: () => [],
			detectAgent: () => null,
			detectInstalledAgents: async () => [],
		});
		expect(run.mock.calls.map((call) => call[0].slice(0, 2))).toEqual([
			["link", "--yes"],
		]);
		expect(
			info.mock.calls.some((call) =>
				String(call[0]).includes("skipped agent setup"),
			),
		).toBe(true);
		info.mockRestore();
	});

	test("host Cursor installs the plugin then links", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		await runScaffoldFollowUp({
			cwd: "/app",
			yes: true,
			run,
			forward,
			skipAgentSetup: false,
			shouldLink: true,
			linkYes: true,
			detectProjectAgents: () => [],
			detectAgent: () => "cursor",
			detectInstalledAgents,
		});
		expect(run.mock.calls.map((call) => call[0])).toEqual([
			expect.arrayContaining(["plugins", "-y", "--agent", "cursor"]),
			expect.arrayContaining(["link", "--yes"]),
		]);
		expect(run.mock.calls[0][0].slice(0, 4)).toEqual([
			"plugins",
			"-y",
			"--agent",
			"cursor",
		]);
		expect(detectInstalledAgents).not.toHaveBeenCalled();
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
	test("-y does not ask host or installed when the project has agents", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const detectAgent = vi.fn((): AgentType | null => "claude-code");
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		await runAgentTooling({
			cwd: "/app",
			yes: true,
			run,
			forward,
			detectProjectAgents: () => ["cursor"],
			detectAgent,
			detectInstalledAgents,
		});
		expect(detectAgent).not.toHaveBeenCalled();
		expect(detectInstalledAgents).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0].slice(0, 4)).toEqual([
			"plugins",
			"-y",
			"--agent",
			"cursor",
		]);
	});

	test("interactive does not run -y detectors", async () => {
		const run = vi.fn().mockResolvedValue(true);
		const detectProjectAgents = vi.fn((): readonly AgentType[] => [
			"cursor",
		]);
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["cursor"],
		);
		await runAgentTooling({
			cwd: "/app",
			yes: false,
			run,
			forward,
			pickAgentSetup: async () => "skip",
			detectProjectAgents,
			detectAgent,
			detectInstalledAgents,
		});
		expect(detectProjectAgents).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(detectInstalledAgents).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});
});
