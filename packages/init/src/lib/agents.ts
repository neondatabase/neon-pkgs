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
