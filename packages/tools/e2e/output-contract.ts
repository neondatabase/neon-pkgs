import type { NeonTool } from "../src/lib/operation.js";
import { toMcpOutputSchema } from "../src/mcp.js";

/**
 * Makes every `execute()` on these tools fail when its result breaks the output
 * schema MCP publishes, so each live call also checks the contract a validating
 * MCP client enforces. Wraps the tools in place and returns them.
 */
export const holdingOutputContract = <
	Tools extends Readonly<Record<string, NeonTool>>,
>(
	tools: Tools,
): Tools => {
	const all: Readonly<Record<string, NeonTool>> = tools;
	for (const tool of Object.values(all)) {
		const { outputSchema } = tool;
		if (outputSchema === undefined) {
			throw new Error(`${tool.operationId} has no outputSchema`);
		}
		const contract = toMcpOutputSchema(outputSchema);
		const execute = tool.execute.bind(tool);
		tool.execute = async (input, context) => {
			const result = await execute(input, context);
			const checked = contract["~standard"].validate({
				data: result.data,
			});
			if (
				typeof checked === "object" &&
				checked !== null &&
				"issues" in checked
			) {
				throw new Error(
					`${tool.operationId} result breaks its output schema: ${JSON.stringify(checked.issues)}`,
				);
			}
			return result;
		};
	}
	return tools;
};
