import { getAgentTypes } from "add-mcp";
import { describe, expect, test } from "vitest";

import {
	getSkillsAgentName,
	listMcpAgentIds,
	resolveAddMcpAgentId,
	supportsSkills,
	tryResolveAddMcpAgentId,
} from "./agents.js";

describe("add-mcp agent ids", () => {
	test("MCP picker is every add-mcp agent except Mastra Code", () => {
		expect(listMcpAgentIds()).toEqual(
			getAgentTypes().filter((id) => id !== "mastracode"),
		);
		expect(tryResolveAddMcpAgentId("mastracode")).toBeUndefined();
		expect(listMcpAgentIds()).toContain("windsurf");
		expect(listMcpAgentIds()).toContain("grok-build");
	});

	test("resolves neon aliases to AgentType constants", () => {
		expect(resolveAddMcpAgentId("claude")).toBe("claude-code");
		expect(resolveAddMcpAgentId("grok")).toBe("grok-build");
		expect(resolveAddMcpAgentId("copilot")).toBe("vscode");
		expect(resolveAddMcpAgentId("kimi")).toBe("kimi-code");
		expect(resolveAddMcpAgentId("droid")).toBe("factory-droid");
		expect(resolveAddMcpAgentId("kilo")).toBe("kilo-code");
		expect(resolveAddMcpAgentId("kiro")).toBe("kiro-cli");
		expect(resolveAddMcpAgentId("hermes-agent")).toBe("hermes");
		expect(tryResolveAddMcpAgentId("not-an-agent")).toBeUndefined();
	});

	test("skills map is hardcoded and maps grok-build to grok", () => {
		expect(getSkillsAgentName("cursor")).toBe("cursor");
		expect(getSkillsAgentName("vscode")).toBe("github-copilot");
		expect(getSkillsAgentName("claude")).toBe("claude-code");
		expect(getSkillsAgentName("claude-desktop")).toBe("claude-code");
		expect(getSkillsAgentName("github-copilot-cli")).toBe("github-copilot");
		expect(getSkillsAgentName("opencode")).toBe("opencode");
		expect(getSkillsAgentName("grok-build")).toBe("grok");
		expect(getSkillsAgentName("grok")).toBe("grok");
		expect(supportsSkills("grok-build")).toBe(true);
		expect(getSkillsAgentName("mcporter")).toBeUndefined();
		expect(supportsSkills("mcporter")).toBe(false);
		expect(supportsSkills("cursor")).toBe(true);
	});

	test("maps every new add-mcp agent to its skills CLI agent", () => {
		expect(getSkillsAgentName("factory-droid")).toBe("droid");
		expect(getSkillsAgentName("fx")).toBe("fx");
		expect(getSkillsAgentName("hermes")).toBe("hermes-agent");
		expect(getSkillsAgentName("junie")).toBe("junie");
		expect(getSkillsAgentName("kilo-code")).toBe("kilo");
		expect(getSkillsAgentName("kimi-code")).toBe("kimi-code-cli");
		expect(getSkillsAgentName("kiro-cli")).toBe("kiro-cli");
		expect(getSkillsAgentName("pi")).toBe("pi");
	});
});
