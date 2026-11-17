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

/**
 * Levels of `data` that keep their properties: the fields of `data`, or of each
 * list item, are typed, and objects below them are `{ "type": "object" }`. Every
 * listed level adds to `tools/list` for every tool and to what a validating
 * client can reject.
 */
const OUTPUT_PROPERTY_DEPTH = 1;
/** Levels of `data` that keep their descriptions. */
const OUTPUT_DESCRIPTION_DEPTH = 1;

const jsonType = (node: Record<string, unknown>): unknown[] | undefined => {
	const keys = Object.keys(node);
	if (keys.length !== 1 || keys[0] !== "type") {
		return undefined;
	}
	return Array.isArray(node.type) ? node.type : [node.type];
};

const compactUnion = (members: unknown[]): Record<string, unknown> => {
	const unique = members.filter(
		(member, index) =>
			members.findIndex(
				(other) => JSON.stringify(other) === JSON.stringify(member),
			) === index,
	);
	const types = unique.map((member) =>
		isPlainObject(member) ? jsonType(member) : undefined,
	);
	if (types.every((type) => type !== undefined)) {
		const flat = [...new Set(types.flat())];
		return { type: flat.length === 1 ? flat[0] : flat };
	}
	return unique.length === 1 && isPlainObject(unique[0])
		? unique[0]
		: { anyOf: unique };
};

/**
 * Types, properties, and required keys down to {@link OUTPUT_PROPERTY_DEPTH};
 * descriptions down to {@link OUTPUT_DESCRIPTION_DEPTH}. Array items share their
 * array's depth, so a list's items read like a single result. Formats, patterns,
 * bounds, and `additionalProperties` are dropped: results may carry fields the
 * spec does not list yet.
 */
const compactOutputNode = (
	node: unknown,
	depth: number,
	omit: ReadonlySet<string>,
): unknown => {
	if (!isPlainObject(node)) {
		return node;
	}
	const out: Record<string, unknown> = {};
	if (
		depth <= OUTPUT_DESCRIPTION_DEPTH &&
		typeof node.description === "string"
	) {
		out.description = node.description;
	}
	if (node.type !== undefined) {
		out.type = node.type;
	}
	if (Array.isArray(node.enum)) {
		out.enum = node.enum;
	}
	if (node.const !== undefined) {
		out.const = node.const;
	}
	const union = Array.isArray(node.anyOf)
		? node.anyOf
		: Array.isArray(node.oneOf)
			? node.oneOf
			: undefined;
	if (union !== undefined) {
		const members = union.map((member) => {
			const compact = compactOutputNode(member, depth, omit);
			if (!isPlainObject(compact)) {
				return compact;
			}
			// `.describe().nullable()` puts the description on the union member.
			const { description, ...rest } = compact;
			if (
				out.description === undefined &&
				typeof description === "string"
			) {
				out.description = description;
			}
			return rest;
		});
		Object.assign(out, compactUnion(members));
	}
	if (node.items !== undefined) {
		out.items = compactOutputNode(node.items, depth, omit);
	}
	if (depth < OUTPUT_PROPERTY_DEPTH && isPlainObject(node.properties)) {
		out.properties = Object.fromEntries(
			Object.entries(node.properties)
				.filter(([key]) => !omit.has(key))
				.map(([key, value]) => [
					key,
					compactOutputNode(value, depth + 1, omit),
				]),
		);
		const required = Array.isArray(node.required)
			? node.required.filter(
					(key) => typeof key === "string" && !omit.has(key),
				)
			: [];
		if (required.length > 0) {
			out.required = required;
		}
	}
	return out;
};

export interface McpOutputSchemaOptions {
	/**
	 * Field names the host removes from results before returning them, such as
	 * credentials. They are dropped from the schema at every level, so a result
	 * without them still validates.
	 */
	omit?: readonly string[];
}

/**
 * The JSON Schema MCP publishes for a tool's `structuredContent`:
 * `{ data: <compact output schema> }`. Failed calls return `{ error }` with
 * `isError`, which MCP does not validate.
 */
export const toMcpOutputJsonSchema = (
	outputSchema: z.ZodType,
	options: McpOutputSchemaOptions = {},
): Record<string, unknown> => ({
	type: "object",
	properties: {
		data: compactOutputNode(
			z.toJSONSchema(outputSchema, { io: "input" }),
			0,
			new Set(options.omit),
		),
	},
	required: ["data"],
});

/**
 * Publishes {@link toMcpOutputJsonSchema} and validates `structuredContent`
 * against that same compact schema, so the server rejects exactly what a
 * validating client would. Validation returns the content unchanged.
 */
export const toMcpOutputSchema = (
	outputSchema: z.ZodType,
	options: McpOutputSchemaOptions = {},
): McpStandardSchema => {
	const json = toMcpOutputJsonSchema(outputSchema, options);
	let validator: z.ZodType | undefined;
	return {
		"~standard": {
			version: 1,
			vendor: "neon",
			jsonSchema: {
				input: () => json,
				output: () => json,
			},
			validate: (value: unknown) => {
				validator ??= z.fromJSONSchema(json);
				const parsed = validator.safeParse(value);
				return parsed.success
					? { value }
					: { issues: parsed.error.issues };
			},
		},
	};
};

const ZOD_ISO_DATETIME_PATTERN = z.toJSONSchema(z.iso.datetime()).pattern;

/**
 * `z.iso.datetime()` publishes a 256-character pattern next to
 * `format: "date-time"`. Its main constraint beyond `format` is a `Z` offset,
 * so `tools/list` carries `Z$` instead. `validate` still runs the full schema.
 * Other patterns are published unchanged.
 */
const compactDateTimePatterns = (node: unknown): unknown => {
	if (Array.isArray(node)) {
		return node.map(compactDateTimePatterns);
	}
	if (!isPlainObject(node)) {
		return node;
	}
	const out = Object.fromEntries(
		Object.entries(node).map(([key, value]) => [
			key,
			compactDateTimePatterns(value),
		]),
	);
	if (
		typeof ZOD_ISO_DATETIME_PATTERN === "string" &&
		out.format === "date-time" &&
		out.pattern === ZOD_ISO_DATETIME_PATTERN
	) {
		out.pattern = "Z$";
	}
	return out;
};

export const toMcpInputSchema = (schema: z.ZodType): McpStandardSchema => {
	const json = compactDateTimePatterns(
		compactJsonSchema(z.toJSONSchema(schema, { io: "input" })),
	);
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
