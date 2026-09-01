import type * as z from "zod";
import type {
	NeonToolExecutionContext,
	NeonToolResult,
} from "./lib/operation.js";

export interface EveToolContext {
	abortSignal: AbortSignal;
}

type EveToolSource = {
	description: string;
	inputSchema: z.ZodType;
	requiresApproval: boolean;
	execute: (
		input: never,
		context?: NeonToolExecutionContext,
	) => Promise<NeonToolResult<unknown>>;
};

export const toEveTool = <const Tool extends EveToolSource>(tool: Tool) => ({
	description: tool.description,
	inputSchema: tool.inputSchema,
	...(tool.requiresApproval ? { approval: () => true } : {}),
	execute: (
		input: Parameters<Tool["execute"]>[0],
		context: EveToolContext,
	): ReturnType<Tool["execute"]> =>
		tool.execute(input, { signal: context.abortSignal }) as ReturnType<
			Tool["execute"]
		>,
});
