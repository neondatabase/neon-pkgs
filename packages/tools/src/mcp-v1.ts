import {
	type McpRegistrableTool,
	type McpToolResult,
	type McpToolServer,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";

export type { McpToolResult, McpToolServer };

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, McpRegistrableTool>>,
): void => {
	registerNeonToolsWithSchema(server, tools, (tool) => tool.inputSchema);
};
