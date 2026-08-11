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

export interface JsonSafeBlob {
	base64: string;
	contentType: string;
	size: number;
}

export type JsonSafe<Value> = unknown extends Value
	? unknown
	: Value extends null
		? null
		: Value extends void
			? null
			: Value extends bigint | Date
				? string
				: Value extends Blob
					? JsonSafeBlob
					: Value extends string | number | boolean
						? Value
						: Value extends readonly (infer Item)[]
							? JsonSafe<Item>[]
							: Value extends object
								? { [Key in keyof Value]: JsonSafe<Value[Key]> }
								: unknown;

export interface NeonToolResult<Data = unknown> {
	data: Data;
}

export interface NeonTool<
	InputSchema extends z.ZodType = z.ZodType,
	Id extends string = string,
	Output = unknown,
> {
	operationId: string;
	id: Id;
	title: string;
	description: string;
	inputSchema: InputSchema;
	annotations: NeonToolAnnotations;
	requiresApproval: boolean;
	metadata: NeonToolMetadata;
	execute(
		input: z.input<InputSchema>,
		context?: NeonToolExecutionContext,
	): Promise<NeonToolResult<Output>>;
}

export interface NeonOperation<
	InputSchema extends z.ZodType,
	Id extends string = string,
	Output = unknown,
> {
	operationId: string;
	id: Id;
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
	): Promise<Output>;
}

export const defineOperation = <
	const InputSchema extends z.ZodType,
	const Id extends string,
	Output,
>(
	operation: NeonOperation<InputSchema, Id, Output>,
) => operation;

export const bindOperation = <
	const InputSchema extends z.ZodType,
	const Id extends string,
	Output,
>(
	operation: NeonOperation<InputSchema, Id, Output>,
	client: Client,
): NeonTool<InputSchema, Id, JsonSafe<Awaited<Output>>> => ({
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
