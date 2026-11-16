import { NeonClientError } from "@neon/sdk";
import type { NeonTool, NeonToolExecutionContext } from "./operation.js";

export interface NeonToolPolicyOptions {
	/** The default for `readOnly` in every execution context. */
	readOnly?: boolean;
}

/** What a `tools` predicate sees: a tool without its `execute`. */
export type NeonToolDescriptor = Pick<
	NeonTool,
	| "operationId"
	| "id"
	| "title"
	| "description"
	| "annotations"
	| "requiresApproval"
	| "metadata"
>;

export type NeonToolPredicate = (tool: NeonToolDescriptor) => boolean;

export const toolDescriptor = (tool: NeonTool): NeonToolDescriptor => ({
	operationId: tool.operationId,
	id: tool.id,
	title: tool.title,
	description: tool.description,
	annotations: tool.annotations,
	requiresApproval: tool.requiresApproval,
	metadata: tool.metadata,
});

export type NeonToolCallGuard = (context?: NeonToolExecutionContext) => void;

/** Throws for a call the effective policy forbids. */
export const toolCallGuard =
	(
		tool: NeonTool,
		options: NeonToolPolicyOptions,
		publishedId: string,
	): NeonToolCallGuard =>
	(context) => {
		const readOnly = context?.readOnly ?? options.readOnly;
		if (readOnly === true && !tool.metadata.readOnlySafe) {
			throw new NeonClientError(
				`${publishedId} is unavailable in read-only mode because it can change Neon resources or returns a connection string or role password.`,
			);
		}
	};

/** SQL tools read the effective `readOnly` to open a `READ ONLY` transaction. */
export const applyToolPolicy = <Tool extends NeonTool>(
	tool: Tool,
	options: NeonToolPolicyOptions,
	guard: NeonToolCallGuard,
): Tool => {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		execute: async (input, context) => {
			guard(context);
			const readOnly = context?.readOnly ?? options.readOnly;
			return execute(
				input,
				readOnly === undefined ? context : { ...context, readOnly },
			);
		},
	};
};
