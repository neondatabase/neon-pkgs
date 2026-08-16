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
	test("MCP picker is every add-mcp agent", () => {
		expect(listMcpAgentIds()).toEqual(getAgentTypes());
		expect(listMcpAgentIds()).toContain("windsurf");
		expect(listMcpAgentIds()).toContain("grok-build");
	});

	test("resolves neon aliases to AgentType constants", () => {
		expect(resolveAddMcpAgentId("claude")).toBe("claude-code");
		expect(resolveAddMcpAgentId("grok")).toBe("grok-build");
		expect(resolveAddMcpAgentId("copilot")).toBe("vscode");
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
});
