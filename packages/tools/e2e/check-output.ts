import {
	createNeonTools,
	type NeonTool,
	type NeonToolOnExecute,
	toolIds,
	toStructuredContent,
} from "../src/index.js";

const toolsById = new Map<string, NeonTool>(
	Object.values(createNeonTools({ tools: toolIds })).map((tool) => [
		tool.id,
		tool,
	]),
);

/**
 * An `onExecute` that parses every successful result through the tool's
 * `outputSchema`, so a live response the schema rejects fails the test that
 * produced it.
 */
export const checkOutput: NeonToolOnExecute = async (event) => {
	const result = await event.execute();
	const tool = toolsById.get(event.id);
	if (tool === undefined) {
		throw new Error(`No Neon tool with id "${event.id}"`);
	}
	const parsed = tool.outputSchema.safeParse(
		toStructuredContent(result.data),
	);
	if (!parsed.success) {
		throw new Error(
			`${event.id} returned a result its outputSchema rejects: ${parsed.error.message}`,
		);
	}
	return result;
};
