import type * as z from "zod";
import type { NeonBearerCredential } from "./lib/auth.js";
import type {
	NeonToolExecutionContext,
	NeonToolResult,
} from "./lib/operation.js";

export interface EveToolContext {
	abortSignal?: AbortSignal;
}

export interface EveToolOptions {
	apiKey?: (context: EveToolContext) => NeonBearerCredential | undefined;
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

export const toEveTool = <const Tool extends EveToolSource>(
	tool: Tool,
	options?: EveToolOptions,
) => ({
	description: tool.description,
	inputSchema: tool.inputSchema,
	...(tool.requiresApproval ? { approval: () => true } : {}),
	execute: (
		input: Parameters<Tool["execute"]>[0],
		context: EveToolContext,
	): ReturnType<Tool["execute"]> =>
		tool.execute(
			input,
			executionContext(context.abortSignal, options?.apiKey?.(context)),
		) as ReturnType<Tool["execute"]>,
});
