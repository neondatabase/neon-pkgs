import type { NeonTool } from "./operation.js";

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
}

type McpToolRegistrar = {
	registerTool: unknown;
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const authInfoFrom = (context: unknown): unknown => {
	if (!isRecord(context)) {
		return undefined;
	}
	if (isRecord(context.http) && "authInfo" in context.http) {
		return context.http.authInfo;
	}
	if ("authInfo" in context) {
		return context.authInfo;
	}
	return undefined;
};

const bearerCredentialFromMcpContext = (
	context: unknown,
): string | undefined => {
	const authInfo = authInfoFrom(context);
	if (authInfo === undefined) {
		return undefined;
	}
	if (
		!isRecord(authInfo) ||
		typeof authInfo.token !== "string" ||
		authInfo.token.length === 0
	) {
		throw new TypeError("A Neon API key or OAuth access token is required");
	}
	return authInfo.token;
};

const signalFrom = (context: unknown): AbortSignal | undefined => {
	if (!isRecord(context)) {
		return undefined;
	}
	if (context.signal instanceof AbortSignal) {
		return context.signal;
	}
	if (
		isRecord(context.mcpReq) &&
		context.mcpReq.signal instanceof AbortSignal
	) {
		return context.mcpReq.signal;
	}
	return undefined;
};

const createToolHandler =
	(tool: NeonTool) =>
	async (input: unknown, context: unknown): Promise<McpToolResult> => {
		try {
			const apiKey = bearerCredentialFromMcpContext(context);
			const result = await tool.execute(input, {
				signal: signalFrom(context),
				...(apiKey === undefined ? {} : { apiKey }),
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
	};

export const registerNeonToolsWithSchema = (
	server: McpToolRegistrar,
	tools: Readonly<Record<string, NeonTool>>,
	inputSchema: (tool: NeonTool) => unknown,
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
				inputSchema: inputSchema(tool),
				annotations: tool.annotations,
				_meta: { "neon/requiresApproval": tool.requiresApproval },
			},
			createToolHandler(tool),
		]);
	}
};
