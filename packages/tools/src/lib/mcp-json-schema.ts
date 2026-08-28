import * as z from "zod";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const compactJsonSchema = (node: unknown): unknown => {
	if (!isPlainObject(node)) {
		return node;
	}
	const rest = { ...node };
	delete rest.$schema;
	return rest;
};

const isStandardValidate = (
	value: unknown,
): value is (input: unknown) => unknown => typeof value === "function";

export interface McpStandardSchema {
	"~standard": {
		version: number;
		vendor: string;
		jsonSchema: {
			input: () => Record<string, unknown>;
			output: () => Record<string, unknown>;
		};
		validate: (value: unknown) => unknown;
	};
}

export const toMcpInputSchema = (schema: z.ZodType): McpStandardSchema => {
	const json = compactJsonSchema(z.toJSONSchema(schema, { io: "input" }));
	if (!isPlainObject(json)) {
		throw new TypeError(
			"MCP tool input schemas must be JSON Schema objects",
		);
	}

	const standard =
		"~standard" in schema && isPlainObject(schema["~standard"])
			? schema["~standard"]
			: undefined;
	const validate = standard === undefined ? undefined : standard.validate;

	return {
		"~standard": {
			version: 1,
			vendor: "neon",
			jsonSchema: {
				input: () => json,
				output: () => json,
			},
			validate: (value: unknown) => {
				if (isStandardValidate(validate)) {
					return validate(value);
				}
				const parsed = schema.safeParse(value);
				return parsed.success
					? { value: parsed.data }
					: { issues: parsed.error.issues };
			},
		},
	};
};
