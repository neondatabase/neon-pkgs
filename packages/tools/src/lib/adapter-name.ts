import type { NeonTool } from "./operation.js";

export interface NeonAdapterNameOptions {
	name?: (tool: NeonTool) => string;
}

export const namedNeonTools = (
	tools: Readonly<Record<string, NeonTool>>,
	options?: NeonAdapterNameOptions,
): Array<{ tool: NeonTool; name: string }> => {
	const named = Object.values(tools).map((tool) => {
		if (options?.name === undefined) {
			return { tool, name: tool.id };
		}
		const name = options.name(tool);
		if (typeof name !== "string") {
			throw new TypeError(
				`Adapter tool name must be a string for ${tool.operationId}`,
			);
		}
		return { tool, name };
	});
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
