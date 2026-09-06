import type { NeonExecutableTool } from "./lib/operation.js";

export interface EveToolContext {
	abortSignal: AbortSignal;
}

type EveToolSource = Pick<
	NeonExecutableTool,
	"description" | "inputSchema" | "requiresApproval" | "execute"
>;

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
