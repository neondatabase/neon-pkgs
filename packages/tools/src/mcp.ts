import { compactJsonSchema, toMcpInputSchema } from "./lib/mcp-json-schema.js";
import {
	type McpRegistrableTool,
	type McpToolResult,
	type McpToolServer,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";

export type { McpStandardSchema } from "./lib/mcp-json-schema.js";
export type { McpToolResult, McpToolServer };
export { compactJsonSchema, toMcpInputSchema };

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, McpRegistrableTool>>,
): void => {
	registerNeonToolsWithSchema(server, tools, (tool) =>
		toMcpInputSchema(tool.inputSchema),
	);
};
