import type * as z from "zod";
import type { NeonTool } from "./lib/operation.js";

export interface EveToolContext {
	abortSignal: AbortSignal;
}

export const toEveTool = <
	const InputSchema extends z.ZodType,
	const Id extends string,
	Output,
>(
	tool: NeonTool<InputSchema, Id, Output>,
) => ({
	description: tool.description,
	inputSchema: tool.inputSchema,
	...(tool.requiresApproval ? { approval: () => true } : {}),
	execute: (input: z.input<InputSchema>, context: EveToolContext) =>
		tool.execute(input, { signal: context.abortSignal }),
});
