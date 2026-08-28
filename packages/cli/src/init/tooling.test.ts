import { describe, expect, test, vi } from "vitest";

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
});
