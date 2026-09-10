import type { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk-v1/server/mcp.js";
import type { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { createNeonTools } from "./index.js";
import { registerNeonTools as registerNeonToolsV2 } from "./mcp.js";
import { registerNeonTools as registerNeonToolsV1 } from "./mcp-v1.js";

const mcpTools = createNeonTools({
	apiKey: "test-key",
	tools: ["projects.list"] as const,
});

declare const mcpV2: McpServerV2;
declare const mcpV1: McpServerV1;

registerNeonToolsV2(mcpV2, mcpTools);
registerNeonToolsV1(mcpV1, mcpTools);

// @ts-expect-error MCP 2 registerTool is not a dummy object
registerNeonToolsV2({ registerTool: {} }, mcpTools);

// @ts-expect-error MCP 1 registerTool is not a dummy object
registerNeonToolsV1({ registerTool: {} }, mcpTools);
