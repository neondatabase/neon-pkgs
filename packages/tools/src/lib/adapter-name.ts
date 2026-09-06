import type { NeonTool } from "./operation.js";

export interface NeonAdapterNameOptions {
	name?: (tool: NeonTool) => string;
}

export const namedNeonTools = (
	tools: Readonly<Record<string, NeonTool>>,
	options?: NeonAdapterNameOptions,
): Array<{ tool: NeonTool; name: string }> => {
	const named = Object.values(tools).map((tool) => ({
		tool,
		name: options?.name?.(tool) ?? tool.id,
	}));
	const seen = new Map<string, string>();
	for (const { tool, name } of named) {
		const previous = seen.get(name);
		if (previous !== undefined) {
			throw new Error(
				`Duplicate published tool name "${name}" for ${previous}, ${tool.operationId}`,
			);
		}
		seen.set(name, tool.operationId);
	}
	return named;
};
