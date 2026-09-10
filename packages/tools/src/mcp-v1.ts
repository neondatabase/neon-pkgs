import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type McpToolResult,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";
import type { NeonTool } from "./lib/operation.js";

export type McpToolServer = Pick<McpServer, "registerTool">;

export type { McpToolResult };

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, NeonTool>>,
): void => {
	registerNeonToolsWithSchema(server, tools, (tool) => tool.inputSchema);
};
