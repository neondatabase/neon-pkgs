import { type Client, createClient } from "@neon/sdk/raw";
import type * as z from "zod";
import { type NeonBearerCredential, requireBearerCredential } from "./auth.js";
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
	/**
	 * Refuses every tool whose `metadata.readOnlySafe` is false. SQL tools run
	 * caller SQL in a `READ ONLY` transaction or refuse to run.
	 */
	readOnly?: boolean;
	/** Every SQL connection logs in as this Postgres role. */
	postgresRole?: string;
	/** Attribution sent with `docs.search` requests. */
	caller?: NeonToolCaller;
}

export interface NeonOperationMetadata {
	method: string;
	path: string;
	stability: string;
	deprecated: boolean;
	tags: readonly string[];
}

export interface NeonToolMetadata extends NeonOperationMetadata {
	/**
	 * Changes no Neon resource and returns no connection string or role
	 * password. A tool that is not refuses to run when `readOnly` is true.
	 */
	readOnlySafe: boolean;
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
	OutputSchema extends z.ZodType = z.ZodType,
> {
	operationId: string;
	id: Id;
	title: string;
	description: string;
	inputSchema: InputSchema;
	/**
	 * The shape of `execute()`'s `data`. It describes results; it does not
	 * validate them. Every catalog tool has one; hand-built tools may omit it.
	 */
	outputSchema?: OutputSchema;
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
	metadata: NeonOperationMetadata;
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

/** A generated operation bound to a client. `fromGenerated` adds the tool policy. */
export type NeonOperationTool<
	InputSchema extends z.ZodType = z.ZodType,
	Id extends string = string,
	Output = unknown,
> = Omit<NeonTool<InputSchema, Id, Output>, "metadata"> & {
	metadata: NeonOperationMetadata;
};

export const bindOperation = <
	const InputSchema extends z.ZodType,
	const Id extends string,
	Output,
>(
	operation: NeonOperation<InputSchema, Id, Output>,
	client: Client,
): NeonOperationTool<InputSchema, Id, JsonSafe<Awaited<Output>>> => ({
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
