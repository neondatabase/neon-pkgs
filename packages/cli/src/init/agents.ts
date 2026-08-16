import {
	type AgentType,
	agents,
	detectGlobalAgents,
	detectProjectAgents,
	getAgentTypes,
} from "add-mcp";

export type { AgentType };

// add-mcp does not export aliases, so Neon preserves CLI compatibility here.
const AGENT_ALIASES = {
	cursor: "cursor",
	copilot: "vscode",
	"github-copilot": "vscode",
	"vs-code": "vscode",
	vscode: "vscode",
	claude: "claude-code",
	"claude-code": "claude-code",
	"claude-desktop": "claude-desktop",
	codex: "codex",
	opencode: "opencode",
	antigravity: "antigravity",
	cline: "cline",
	"cline-cli": "cline-cli",
	"cline-vscode": "cline",
	"gemini-cli": "gemini-cli",
	gemini: "gemini-cli",
	goose: "goose",
	windsurf: "windsurf",
	codeium: "windsurf",
	cascade: "windsurf",
	"github-copilot-cli": "github-copilot-cli",
	mcporter: "mcporter",
	zed: "zed",
	grok: "grok-build",
	"grok-build": "grok-build",
} as const satisfies Record<string, AgentType>;

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
	mcporter: "mcporter",
};

export function listMcpAgentIds(): AgentType[] {
	return getAgentTypes();
}

export function getAgentDisplayName(id: AgentType): string {
	return agents[id].displayName;
}

export function agentSupportsProjectMcp(id: AgentType): boolean {
	return Boolean(agents[id].localConfigPath);
}

export function agentSupportsHttpMcp(id: AgentType): boolean {
	return agents[id].supportedTransports.includes("http");
}

export function tryResolveAddMcpAgentId(
	rawAgent: string,
): AgentType | undefined {
	return AGENT_ALIASES[rawAgent.toLowerCase() as keyof typeof AGENT_ALIASES];
}

export function resolveAddMcpAgentId(rawAgent: string): AgentType {
	const resolved = tryResolveAddMcpAgentId(rawAgent);
	if (!resolved) {
		throw new Error(
			`Unknown agent: "${rawAgent}". Supported agents: ${listMcpAgentIds().join(", ")}`,
		);
	}
	return resolved;
}

export function getSkillsAgentName(agent: string): string | undefined {
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
		return "Connectors in the app — remote MCP is not writable via config";
	}
	if (supportsSkills(id)) return "MCP server, skills";
	return "MCP server";
}

export async function detectInstalledAgents(
	cwd = process.cwd(),
): Promise<AgentType[]> {
	const [globalAgents, projectAgents] = await Promise.all([
		detectGlobalAgents(),
		Promise.resolve(detectProjectAgents(cwd)),
	]);
	return [...new Set([...globalAgents, ...projectAgents])];
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
