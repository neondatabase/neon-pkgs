import { defineConfig } from "@hey-api/openapi-ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// The spec documents many fields as `{ $ref, description }`, and parameters
// as a `description` beside a `$ref` schema. OpenAPI 3.0 ignores siblings of
// `$ref`, so the parser drops the description and the field reaches the tool
// schema undocumented. Inlining one level of the referenced schema at that
// site keeps it.
const keepReferenceSiblings = (
	node: unknown,
	schemas: Record<string, unknown>,
): void => {
	if (Array.isArray(node)) {
		for (const child of node) keepReferenceSiblings(child, schemas);
		return;
	}
	if (!isRecord(node)) return;
	if (
		typeof node.in === "string" &&
		typeof node.description === "string" &&
		isRecord(node.schema) &&
		typeof node.schema.$ref === "string" &&
		node.schema.description === undefined
	) {
		node.schema = { ...node.schema, description: node.description };
	}
	const reference = node.$ref;
	if (
		typeof reference === "string" &&
		reference.startsWith("#/components/schemas/") &&
		typeof node.description === "string"
	) {
		const target = schemas[reference.slice("#/components/schemas/".length)];
		if (!isRecord(target)) {
			throw new Error(`Unresolved OpenAPI reference: ${reference}`);
		}
		const { $ref: _reference, ...siblings } = node;
		for (const key of Object.keys(node)) delete node[key];
		Object.assign(node, structuredClone(target), siblings);
		return;
	}
	for (const child of Object.values(node))
		keepReferenceSiblings(child, schemas);
};

export default defineConfig({
	input: "../sdk/spec/neon-openapi.json",
	output: {
		path: "./src/generated",
	},
	parser: {
		patch: {
			input: (spec) => {
				if (
					!("components" in spec) ||
					!isRecord(spec.components?.schemas)
				) {
					throw new Error(
						"Expected an OpenAPI 3 spec with component schemas",
					);
				}
				keepReferenceSiblings(spec, spec.components.schemas);
			},
			operations: (_method, _path, operation) => {
				const responses = operation.responses;
				if (!responses || !("default" in responses)) return;
				if (!("4XX" in responses)) {
					responses["4XX"] = responses.default;
				}
				delete responses.default;
			},
		},
	},
	plugins: [
		{
			name: "zod",
			compatibilityVersion: 4,
			definitions: true,
			metadata: true,
			requests: {
				shouldExtract: true,
			},
			responses: false,
			"~resolvers": {
				number(context) {
					const { $, chain, nodes, schema, symbols } = context;
					const constant = nodes.const(context);
					if (constant) {
						chain.current = constant;
						return chain.current;
					}

					chain.current = $(symbols.z)
						.attr(schema.type === "integer" ? "int" : "number")
						.call();
					const minimum = nodes.min(context);
					if (minimum) chain.current = minimum;
					const maximum = nodes.max(context);
					if (maximum) chain.current = maximum;
					return chain.current;
				},
			},
		},
	],
});
