import type { McpServer } from "@modelcontextprotocol/server";
import { compactJsonSchema, toMcpInputSchema } from "./lib/mcp-json-schema.js";
import {
	type McpToolResult,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";
import type { NeonTool } from "./lib/operation.js";

export type McpToolServer = Pick<McpServer, "registerTool">;

export type { McpStandardSchema } from "./lib/mcp-json-schema.js";
export type { McpToolResult };
export { compactJsonSchema, toMcpInputSchema };

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, NeonTool>>,
): void => {
	registerNeonToolsWithSchema(server, tools, (tool) =>
		toMcpInputSchema(tool.inputSchema),
	);
};
