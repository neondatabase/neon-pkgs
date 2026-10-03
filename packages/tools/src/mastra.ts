import type { NeonExecutableTool } from "./lib/operation.js";

export interface MastraToolContext {
	abortSignal?: AbortSignal;
}

export type MastraToolConfig<Tool extends NeonExecutableTool> = {
	id: Tool["id"];
	description: string;
	inputSchema: Tool["inputSchema"];
	requireApproval: boolean;
	execute(
		input: Parameters<Tool["execute"]>[0],
		context: MastraToolContext,
	): ReturnType<Tool["execute"]>;
};

export type MastraTools<
	Tools extends Readonly<Record<string, NeonExecutableTool>>,
> = {
	[Tool in Tools[keyof Tools] as Tool["id"]]: MastraToolConfig<Tool>;
};

type MastraToolSource = Pick<
	NeonExecutableTool,
	"id" | "description" | "inputSchema" | "requiresApproval" | "execute"
>;

export const toMastraTool = <const Tool extends MastraToolSource>(
	tool: Tool,
) => ({
	id: tool.id,
	description: tool.description,
	inputSchema: tool.inputSchema,
	requireApproval: tool.requiresApproval,
	execute: (
		input: Parameters<Tool["execute"]>[0],
		context: MastraToolContext,
	): ReturnType<Tool["execute"]> =>
		tool.execute(input, { signal: context.abortSignal }) as ReturnType<
			Tool["execute"]
		>,
});

function assertMastraTools<
	Tools extends Readonly<Record<string, NeonExecutableTool>>,
>(value: unknown, tools: Tools): asserts value is MastraTools<Tools> {
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
	const Tools extends Readonly<Record<string, NeonExecutableTool>>,
>(
	tools: Tools,
): MastraTools<Tools> => {
	const adapted: unknown = Object.fromEntries(
		Object.values(tools).map((tool) => [tool.id, toMastraTool(tool)]),
	);
	assertMastraTools(adapted, tools);
	return adapted;
};
