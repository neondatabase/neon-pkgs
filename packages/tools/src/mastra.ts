import type * as z from "zod";
import type { NeonTool } from "./lib/operation.js";

export interface MastraToolContext {
	abortSignal?: AbortSignal;
}

export const toMastraTool = <const InputSchema extends z.ZodType>(
	tool: NeonTool<InputSchema>,
) => ({
	id: tool.id,
	description: tool.description,
	inputSchema: tool.inputSchema,
	requireApproval: tool.requiresApproval,
	execute: (input: z.input<InputSchema>, context: MastraToolContext) =>
		tool.execute(input, { signal: context.abortSignal }),
});

export const toMastraTools = (tools: Readonly<Record<string, NeonTool>>) =>
	Object.fromEntries(
		Object.values(tools).map((tool) => [tool.id, toMastraTool(tool)]),
	);
