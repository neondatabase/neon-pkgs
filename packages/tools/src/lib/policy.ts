import { NeonClientError } from "@neon/sdk";
import type { NeonTool } from "./operation.js";

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

/**
 * Refuses a call the effective `readOnly` forbids before it reaches Neon, and
 * passes the effective value on so SQL tools open a `READ ONLY` transaction.
 */
export const applyToolPolicy = <Tool extends NeonTool>(
	tool: Tool,
	options: NeonToolPolicyOptions,
	publishedId: string,
): Tool => {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		execute: async (input, context) => {
			const readOnly = context?.readOnly ?? options.readOnly;
			if (readOnly === true && !tool.metadata.readOnlySafe) {
				throw new NeonClientError(
					`${publishedId} is unavailable in read-only mode because it can change Neon resources or returns a connection string or role password.`,
				);
			}
			return execute(
				input,
				readOnly === undefined ? context : { ...context, readOnly },
			);
		},
	};
};
