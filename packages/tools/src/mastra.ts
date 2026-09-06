import type * as z from "zod";
import type { NeonBearerCredential } from "./lib/auth.js";
import type {
	NeonTool,
	NeonToolExecutionContext,
	NeonToolResult,
} from "./lib/operation.js";

export interface MastraToolContext {
	abortSignal?: AbortSignal;
}

export interface MastraToolOptions {
	apiKey?: (context: MastraToolContext) => NeonBearerCredential | undefined;
}

export type MastraToolConfig<Tool extends NeonTool> = {
	id: Tool["id"];
	description: string;
	inputSchema: Tool["inputSchema"];
	requireApproval: boolean;
	execute(
		input: Parameters<Tool["execute"]>[0],
		context: MastraToolContext,
	): ReturnType<Tool["execute"]>;
};

export type MastraTools<Tools extends Readonly<Record<string, NeonTool>>> = {
	[Tool in Tools[keyof Tools] as Tool["id"]]: MastraToolConfig<Tool>;
};

type MastraToolSource = {
	id: string;
	description: string;
	inputSchema: z.ZodType;
	requiresApproval: boolean;
	execute: (
		input: never,
		context?: NeonToolExecutionContext,
	) => Promise<NeonToolResult<unknown>>;
};

const executionContext = (
	signal: AbortSignal | undefined,
	apiKey: NeonBearerCredential | undefined,
): NeonToolExecutionContext | undefined => {
	if (signal === undefined && apiKey === undefined) {
		return undefined;
	}
	return {
		...(signal === undefined ? {} : { signal }),
		...(apiKey === undefined ? {} : { apiKey }),
	};
};

export const toMastraTool = <const Tool extends MastraToolSource>(
	tool: Tool,
	options?: MastraToolOptions,
) => ({
	id: tool.id,
	description: tool.description,
	inputSchema: tool.inputSchema,
	requireApproval: tool.requiresApproval,
	execute: (
		input: Parameters<Tool["execute"]>[0],
		context: MastraToolContext,
	): ReturnType<Tool["execute"]> =>
		tool.execute(
			input,
			executionContext(context.abortSignal, options?.apiKey?.(context)),
		) as ReturnType<Tool["execute"]>,
});

function assertMastraTools<Tools extends Readonly<Record<string, NeonTool>>>(
	value: unknown,
	tools: Tools,
): asserts value is MastraTools<Tools> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Expected Mastra tools to be an object.");
	}
	for (const tool of Object.values(tools)) {
		if (!(tool.id in value)) {
			throw new TypeError(`Missing Mastra tool "${tool.id}".`);
		}
	}
}

export const toMastraTools = <
	const Tools extends Readonly<Record<string, NeonTool>>,
>(
	tools: Tools,
	options?: MastraToolOptions,
): MastraTools<Tools> => {
	const adapted: unknown = Object.fromEntries(
		Object.values(tools).map((tool) => [
			tool.id,
			toMastraTool(tool, options),
		]),
	);
	assertMastraTools(adapted, tools);
	return adapted;
};
