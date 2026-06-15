import type { Editor } from "./types.js";

export interface AgentConfig {
	editor: Editor;
	addMcpId: string;
	hint: string;
}

/**
 * All agents that can be configured via neon-init.
 * Aligns with add-mcp's supported agents table.
 * https://github.com/neondatabase/add-mcp#supported-agents
 */
export const ALL_CONFIGURABLE_AGENTS: AgentConfig[] = [
	{
		editor: "Cursor",
		addMcpId: "cursor",
		hint: "Neon Local Connect extension",
	},
	{
		editor: "VS Code",
		addMcpId: "vscode",
		hint: "Neon Local Connect extension",
	},
	{ editor: "Claude CLI", addMcpId: "claude-code", hint: "MCP Server" },
	{
		editor: "Claude Desktop",
		addMcpId: "claude-desktop",
		hint: "MCP Server",
	},
	{ editor: "Codex", addMcpId: "codex", hint: "MCP Server" },
	{ editor: "OpenCode", addMcpId: "opencode", hint: "MCP Server" },
	{ editor: "Antigravity", addMcpId: "antigravity", hint: "MCP Server" },
	{ editor: "Cline", addMcpId: "cline", hint: "MCP Server" },
	{ editor: "Cline CLI", addMcpId: "cline-cli", hint: "MCP Server" },
	{ editor: "Gemini CLI", addMcpId: "gemini-cli", hint: "MCP Server" },
	{
		editor: "GitHub Copilot CLI",
		addMcpId: "github-copilot-cli",
		hint: "MCP Server",
	},
	{ editor: "Goose", addMcpId: "goose", hint: "MCP Server" },
	{ editor: "MCPorter", addMcpId: "mcporter", hint: "MCP Server" },
	{ editor: "Zed", addMcpId: "zed", hint: "MCP Server" },
];

export function getAddMcpAgentId(editor: Editor): string {
	const agent = ALL_CONFIGURABLE_AGENTS.find((a) => a.editor === editor);
	if (!agent) {
		throw new Error(`No add-mcp agent ID found for editor: ${editor}`);
	}
	return agent.addMcpId;
}

/**
 * Maps a raw agent identifier (as reported by agents or passed via --agent)
 * to the add-mcp compatible agent ID.
 *
 * This handles aliases like "copilot" → "vscode", "claude" → "claude-code", etc.
 */
const AGENT_ALIAS_TO_MCP_ID: Record<string, string> = {
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
	"gemini-cli": "gemini-cli",
	gemini: "gemini-cli",
	goose: "goose",
	windsurf: "windsurf",
	"github-copilot-cli": "github-copilot-cli",
	mcporter: "mcporter",
	zed: "zed",
};

export function resolveAddMcpAgentId(rawAgent: string): string {
	const resolved = AGENT_ALIAS_TO_MCP_ID[rawAgent.toLowerCase()];
	if (!resolved) {
		throw new Error(
			`Unknown agent: "${rawAgent}". Supported agents: ${Object.keys(AGENT_ALIAS_TO_MCP_ID).join(", ")}`,
		);
	}
	return resolved;
}

/**
 * Maps a raw agent identifier to the skills CLI agent name.
 */
export function getSkillsAgentName(agent: string): string {
	switch (agent.toLowerCase()) {
		case "cursor":
			return "cursor";
		case "copilot":
		case "vscode":
		case "vs-code":
		case "github-copilot":
			return "github-copilot";
		case "claude":
		case "claude-code":
			return "claude-code";
		case "codex":
			return "codex";
		case "opencode":
			return "opencode";
		case "antigravity":
			return "antigravity";
		case "cline":
			return "cline";
		case "gemini-cli":
			return "gemini-cli";
		case "goose":
			return "goose";
		case "claude-desktop":
			return "claude-code";
		case "cline-cli":
			return "cline";
		case "gemini":
			return "gemini-cli";
		case "windsurf":
			return "windsurf";
		case "github-copilot-cli":
			return "github-copilot";
		case "mcporter":
			return "mcporter";
		case "zed":
			return "zed";
		default:
			// Fall back to "cursor" as a safe default — skills CLI uses the
			// agent name to pick the output directory (.agents/skills, .cursor/skills, etc.)
			// and "cursor" uses .agents/skills which works for all agents.
			return "cursor";
	}
}
