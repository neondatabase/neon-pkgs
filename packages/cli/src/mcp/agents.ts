import {
	type AgentType,
	agents,
	detectGlobalAgents,
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

export async function detectInstalledAgents(): Promise<AgentType[]> {
	return detectGlobalAgents();
}

export function uniqueAgentIds(ids: readonly AgentType[]): AgentType[] {
	const seen = new Set<AgentType>();
	const out: AgentType[] = [];
	for (const id of ids) {
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		out.push(id);
	}
	return out;
}
