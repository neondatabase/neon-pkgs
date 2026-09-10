import type { NeonAdapterNameOptions } from "./lib/adapter-name.js";
import { compactJsonSchema, toMcpInputSchema } from "./lib/mcp-json-schema.js";
import {
	type McpToolResult,
	type McpToolServer,
	registerNeonToolsWithSchema,
} from "./lib/mcp-register.js";
import type { NeonTool } from "./lib/operation.js";

export type { NeonAdapterNameOptions } from "./lib/adapter-name.js";
export type { McpStandardSchema } from "./lib/mcp-json-schema.js";
export type { McpToolResult, McpToolServer };
export { compactJsonSchema, toMcpInputSchema };

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, NeonTool>>,
	options?: NeonAdapterNameOptions,
): void => {
	registerNeonToolsWithSchema(
		server,
		tools,
		(tool) => toMcpInputSchema(tool.inputSchema),
		options,
	);
};
