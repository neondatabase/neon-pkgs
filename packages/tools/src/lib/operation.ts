import { type Client, createClient } from "@neon/sdk/raw";
import type * as z from "zod";
import { type NeonBearerCredential, requireBearerCredential } from "./auth.js";
import type { NeonOutputSchema } from "./output.js";
import { toToolResult } from "./result.js";

export interface NeonToolAnnotations {
	readOnlyHint: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint: boolean;
}

export interface NeonToolCaller {
	source: string;
	userAgent?: string;
	client?: string;
}

export interface NeonToolExecutionContext {
	signal?: AbortSignal;
	apiKey?: NeonBearerCredential;
	/** SQL tools run caller SQL in a `READ ONLY` transaction or refuse to run. */
	readOnly?: boolean;
	/** Every SQL connection logs in as this Postgres role. */
	postgresRole?: string;
	/** Attribution sent with `docs.search` requests. */
	caller?: NeonToolCaller;
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

/** What a definition returns when its output schema rejects its result. */
export interface OutputSchemaRejectsResult<Result> {
	readonly outputSchemaRejectsResult: Result;
}

/**
 * `Definition` when the output schema `Data` accepts the `data` of a tool that
 * resolves to `Output`. Otherwise a type no tool consumer accepts, naming that
 * `data`. The check sits in the return type because a parameter that depends
 * on `Output` fixes it before TypeScript reads an untyped callback's return.
 */
export type CheckedOutput<Definition, Output, Data extends z.ZodType> =
	unknown extends Awaited<Output>
		? Definition
		: [JsonSafe<Awaited<Output>>] extends [z.input<Data>]
			? Definition
			: OutputSchemaRejectsResult<JsonSafe<Awaited<Output>>>;

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
	/**
	 * The structured result, `toStructuredContent(data)`: a JSON object, as MCP
	 * `structuredContent` requires. An object `data` is that object, an array is
	 * `{ items }`, `null` (a call with no response body) is `{}`, and a string,
	 * number, or boolean is `{ value }`.
	 */
	outputSchema: NeonOutputSchema;
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
	OutputData extends z.ZodType = z.ZodType,
> {
	operationId: string;
	id: Id;
	title: string;
	description: string;
	inputSchema: InputSchema;
	outputSchema: NeonOutputSchema<OutputData>;
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
	OutputData extends z.ZodType,
>(
	operation: NeonOperation<InputSchema, Id, Output, OutputData>,
) =>
	operation as CheckedOutput<
		NeonOperation<InputSchema, Id, Output, OutputData>,
		Output,
		OutputData
	>;

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
	outputSchema: operation.outputSchema,
	annotations: operation.annotations,
	requiresApproval: operation.requiresApproval,
	metadata: operation.metadata,
	async execute(input, context) {
		const parsed = await operation.inputSchema.parseAsync(input);
		const activeClient =
			context !== undefined && "apiKey" in context
				? clientWithCredential(client, context.apiKey)
				: client;
		const result = await operation.invoke(
			activeClient,
			parsed,
			context?.signal,
		);
		return toToolResult(result);
	},
});

const clientWithCredential = (
	client: Client,
	apiKey: NeonBearerCredential | undefined,
): Client => {
	if (apiKey === undefined) {
		throw new TypeError("A Neon API key or OAuth access token is required");
	}
	return createClient({
		...client.getConfig(),
		auth: requireBearerCredential(apiKey),
	});
};
