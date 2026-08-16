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

	test("skills map is hardcoded and omits grok-build", () => {
		expect(getSkillsAgentName("cursor")).toBe("cursor");
		expect(getSkillsAgentName("vscode")).toBe("github-copilot");
		expect(getSkillsAgentName("claude")).toBe("claude-code");
		expect(getSkillsAgentName("claude-desktop")).toBe("claude-code");
		expect(getSkillsAgentName("github-copilot-cli")).toBe("github-copilot");
		expect(getSkillsAgentName("grok-build")).toBeUndefined();
		expect(getSkillsAgentName("grok")).toBeUndefined();
		expect(supportsSkills("grok-build")).toBe(false);
		expect(supportsSkills("cursor")).toBe(true);
	});
});
