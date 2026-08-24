import { agents } from "add-mcp";

import {
	type AgentType,
	agentSupportsHttpMcp,
	agentSupportsProjectMcp,
	detectInstalledAgents,
	getAgentDisplayName,
	listMcpAgentIds,
	resolveAddMcpAgentId,
	tryResolveAddMcpAgentId,
} from "../mcp/agents.js";

export type { AgentType };
export {
	agentSupportsHttpMcp,
	agentSupportsProjectMcp,
	detectInstalledAgents,
	getAgentDisplayName,
	listMcpAgentIds,
	resolveAddMcpAgentId,
	tryResolveAddMcpAgentId,
};

const SKILLS_AGENT_BY_TYPE: { [K in AgentType]?: string } = {
	cursor: "cursor",
	vscode: "github-copilot",
	"claude-code": "claude-code",
	"claude-desktop": "claude-code",
	codex: "codex",
	opencode: "opencode",
	antigravity: "antigravity",
	cline: "cline",
	"cline-cli": "cline",
	"gemini-cli": "gemini-cli",
	goose: "goose",
	"github-copilot-cli": "github-copilot",
	windsurf: "windsurf",
	zed: "zed",
	"grok-build": "grok",
};

export function getSkillsAgentName(agent: string): string | undefined {
	if (Object.prototype.hasOwnProperty.call(SKILLS_AGENT_BY_TYPE, agent)) {
		return SKILLS_AGENT_BY_TYPE[agent as AgentType];
	}
	const id = tryResolveAddMcpAgentId(agent);
	if (!id) return undefined;
	return SKILLS_AGENT_BY_TYPE[id];
}

export function supportsSkills(agent: string): boolean {
	return getSkillsAgentName(agent) !== undefined;
}

export function agentPickerHint(id: AgentType): string {
	if (id === "cursor" || id === "vscode") {
		return "Neon Local Connect extension";
	}
	if (id === "claude-desktop") {
		return supportsSkills(id)
			? "Connectors in the app, skills"
			: (agents[id].unsupportedTransportMessage ??
					"Add remote servers through Connectors in the app");
	}
	if (supportsSkills(id)) return "MCP server, skills";
	return "MCP server";
}

export function mcpPickerOptions(): {
	value: AgentType;
	label: string;
	hint: string;
}[] {
	return listMcpAgentIds().map((id) => ({
		value: id,
		label: getAgentDisplayName(id),
		hint: agentPickerHint(id),
	}));
}

export function skillsPickerOptions(): {
	value: AgentType;
	label: string;
	hint: string;
}[] {
	return listMcpAgentIds()
		.filter((id) => supportsSkills(id))
		.map((id) => ({
			value: id,
			label: getAgentDisplayName(id),
			hint: "agent skills",
		}));
}
