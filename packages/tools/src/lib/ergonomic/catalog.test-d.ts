import type * as z from "zod";
import type { NeonTool } from "../operation.js";
import type { toolFactories } from "./catalog.js";

// Ids whose `outputSchema` cannot hold the data their tool returns.
type OutputSchemaMismatches = {
	[Id in keyof typeof toolFactories]: ReturnType<
		(typeof toolFactories)[Id]
	> extends NeonTool<z.ZodType, string, infer Data, infer Schema>
		? [Data] extends [z.input<Schema>]
			? never
			: Id
		: Id;
}[keyof typeof toolFactories];

// Fails to compile, naming the ids, when an output schema rejects its result.
export const outputSchemasHoldResults: [OutputSchemaMismatches] extends [never]
	? true
	: OutputSchemaMismatches = true;
