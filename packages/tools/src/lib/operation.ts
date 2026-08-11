import type { Client } from "@neon/sdk/raw";
import type * as z from "zod";
import { toToolResult } from "./result.js";

export interface NeonToolAnnotations {
	readOnlyHint: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint: boolean;
}

export interface NeonToolExecutionContext {
	signal?: AbortSignal;
}

export interface NeonToolMetadata {
	method: string;
	path: string;
	stability: string;
	deprecated: boolean;
	tags: readonly string[];
}

export interface NeonToolResult {
	data: unknown;
}

export interface NeonTool<InputSchema extends z.ZodType = z.ZodType> {
	operationId: string;
	id: string;
	title: string;
	description: string;
	inputSchema: InputSchema;
	annotations: NeonToolAnnotations;
	requiresApproval: boolean;
	metadata: NeonToolMetadata;
	execute(
		input: z.input<InputSchema>,
		context?: NeonToolExecutionContext,
	): Promise<NeonToolResult>;
}

export interface NeonOperation<InputSchema extends z.ZodType> {
	operationId: string;
	id: string;
	title: string;
	description: string;
	inputSchema: InputSchema;
	annotations: NeonToolAnnotations;
	requiresApproval: boolean;
	metadata: NeonToolMetadata;
	invoke(
		client: Client,
		input: z.output<InputSchema>,
		signal?: AbortSignal,
	): Promise<unknown>;
}

export const defineOperation = <const InputSchema extends z.ZodType>(
	operation: NeonOperation<InputSchema>,
) => operation;

export const bindOperation = <const InputSchema extends z.ZodType>(
	operation: NeonOperation<InputSchema>,
	client: Client,
): NeonTool<InputSchema> => ({
	operationId: operation.operationId,
	id: operation.id,
	title: operation.title,
	description: operation.description,
	inputSchema: operation.inputSchema,
	annotations: operation.annotations,
	requiresApproval: operation.requiresApproval,
	metadata: operation.metadata,
	async execute(input, context) {
		const parsed = await operation.inputSchema.parseAsync(input);
		const result = await operation.invoke(client, parsed, context?.signal);
		return toToolResult(result);
	},
});
