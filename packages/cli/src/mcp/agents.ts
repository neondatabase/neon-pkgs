import {
	type AgentType,
	agents,
	detectProjectAgents as detectAddMcpProjectAgents,
	detectGlobalAgents,
	getAgentTypes,
} from "add-mcp";

export type { AgentType };

// The skills CLI has no Mastra Code agent, so Neon cannot install its skills there.
const UNSUPPORTED_AGENTS: ReadonlySet<AgentType> = new Set(["mastracode"]);

const isSupportedAgent = (id: AgentType): boolean =>
	!UNSUPPORTED_AGENTS.has(id);

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
	"factory-droid": "factory-droid",
	droid: "factory-droid",
	factory: "factory-droid",
	fx: "fx",
	hermes: "hermes",
	"hermes-agent": "hermes",
	junie: "junie",
	"kilo-code": "kilo-code",
	kilo: "kilo-code",
	"kimi-code": "kimi-code",
	kimi: "kimi-code",
	"kimi-code-cli": "kimi-code",
	"kiro-cli": "kiro-cli",
	kiro: "kiro-cli",
	pi: "pi",
} as const satisfies Record<string, AgentType>;

export function listMcpAgentIds(): AgentType[] {
	return getAgentTypes().filter(isSupportedAgent);
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
	return (await detectGlobalAgents()).filter(isSupportedAgent);
}

export function detectProjectAgents(cwd: string): AgentType[] {
	return detectAddMcpProjectAgents(cwd).filter(isSupportedAgent);
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
