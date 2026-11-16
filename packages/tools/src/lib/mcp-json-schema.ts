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

const isNullType = (node: unknown): boolean =>
	isPlainObject(node) &&
	node.type === "null" &&
	Object.keys(node).length === 1;

/**
 * An equivalent, shorter result schema: `additionalProperties: {}` allows what
 * omitting it allows, and `anyOf: [X, { type: "null" }]` becomes X with a
 * `"null"` type when X has no `enum` or `const` that null would fail.
 */
const compactOutputNode = (node: unknown): unknown => {
	if (Array.isArray(node)) {
		return node.map(compactOutputNode);
	}
	if (!isPlainObject(node)) {
		return node;
	}
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (
			key === "additionalProperties" &&
			isPlainObject(value) &&
			Object.keys(value).length === 0
		) {
			continue;
		}
		next[key] = compactOutputNode(value);
	}
	const { anyOf, ...rest } = next;
	if (!Array.isArray(anyOf) || anyOf.length !== 2) {
		return next;
	}
	const options = anyOf.filter((option) => !isNullType(option));
	const [option] = options;
	if (
		options.length !== 1 ||
		!isPlainObject(option) ||
		typeof option.type !== "string" ||
		"enum" in option ||
		"const" in option ||
		Object.keys(rest).some((key) => key in option)
	) {
		return next;
	}
	return { ...option, ...rest, type: [option.type, "null"] };
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

const toMcpSchema = (
	schema: z.ZodType,
	io: "input" | "output",
): McpStandardSchema => {
	const converted = compactJsonSchema(z.toJSONSchema(schema, { io }));
	const json = io === "output" ? compactOutputNode(converted) : converted;
	if (!isPlainObject(json)) {
		throw new TypeError(
			`MCP tool ${io} schemas must be JSON Schema objects`,
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

export const toMcpInputSchema = (schema: z.ZodType): McpStandardSchema =>
	toMcpSchema(schema, "input");

/** A tool result schema, converted for the result rather than the arguments. */
export const toMcpOutputSchema = (schema: z.ZodType): McpStandardSchema =>
	toMcpSchema(schema, "output");
