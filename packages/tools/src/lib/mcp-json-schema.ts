import * as z from "zod";

const SCHEMA_MAP_KEYS = new Set([
	"$defs",
	"definitions",
	"patternProperties",
	"properties",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// A property named `description` is a field, not a schema annotation.
export const compactJsonSchema = (node: unknown): unknown => {
	if (Array.isArray(node)) {
		return node.map(compactJsonSchema);
	}
	if (!isPlainObject(node)) {
		return node;
	}

	const compact: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$schema" || key === "description") {
			continue;
		}
		if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
			compact[key] = Object.fromEntries(
				Object.entries(value).map(([name, schema]) => [
					name,
					compactJsonSchema(schema),
				]),
			);
			continue;
		}
		compact[key] = compactJsonSchema(value);
	}
	return compact;
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
