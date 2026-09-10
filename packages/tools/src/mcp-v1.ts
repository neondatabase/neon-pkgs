import {
	type McpToolResult,
	type McpToolServer,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";
import type { NeonTool } from "./lib/operation.js";

export type { McpToolResult, McpToolServer };

export const registerNeonToolsV1 = (
	server: McpToolServer,
	tools: Readonly<Record<string, NeonTool>>,
): void => {
	registerNeonToolsWithSchema(server, tools, (tool) => tool.inputSchema);
};

/** @deprecated Use registerNeonToolsV1. */
export const registerNeonTools = registerNeonToolsV1;
