import {
	type McpToolResult,
	type McpToolServer,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";
import type { NeonTool } from "./lib/operation.js";

export type { McpToolResult, McpToolServer };

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, NeonTool>>,
): void => {
	registerNeonToolsWithSchema(server, tools, (tool) => tool.inputSchema);
};
