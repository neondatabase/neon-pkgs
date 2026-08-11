import type { NeonTool } from "./lib/operation.js";

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
}

export interface McpToolServer {
	registerTool: object;
}

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const signalFrom = (context: unknown): AbortSignal | undefined => {
	if (
		typeof context !== "object" ||
		context === null ||
		!("signal" in context) ||
		!(context.signal instanceof AbortSignal)
	) {
		return undefined;
	}
	return context.signal;
};

export const registerNeonTools = (
	server: McpToolServer,
	tools: Readonly<Record<string, NeonTool>>,
): void => {
	if (typeof server.registerTool !== "function") {
		throw new TypeError("Expected an MCP server with registerTool().");
	}

	for (const tool of Object.values(tools)) {
		Reflect.apply(server.registerTool, server, [
			tool.id,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
				_meta: { "neon/requiresApproval": tool.requiresApproval },
			},
			async (
				input: unknown,
				context: unknown,
			): Promise<McpToolResult> => {
				try {
					const result = await tool.execute(input, {
						signal: signalFrom(context),
					});
					const structuredContent = { data: result.data };
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(structuredContent),
							},
						],
						structuredContent,
					};
				} catch (error) {
					const structuredContent = {
						error: { message: errorMessage(error) },
					};
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(structuredContent),
							},
						],
						structuredContent,
						isError: true,
					};
				}
			},
		]);
	}
};
