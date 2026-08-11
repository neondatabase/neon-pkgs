import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
	input: "../sdk/spec/neon-openapi.json",
	output: {
		path: "./src/generated",
	},
	parser: {
		patch: {
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
					if (schema.format !== "int64") {
						const minimum = nodes.min(context);
						if (minimum) chain.current = minimum;
						const maximum = nodes.max(context);
						if (maximum) chain.current = maximum;
					}
					return chain.current;
				},
			},
		},
	],
});
