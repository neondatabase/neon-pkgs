import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
	input: "./spec/neon-openapi.json",
	output: {
		path: "./src/client",
		postProcess: [],
	},
	parser: {
		patch: {
			// Neon's spec declares every operation's error response under the OpenAPI
			// `default` key. `@hey-api/openapi-ts` treats a `default` response as both a
			// success and an error, which leaks `GeneralError` into every `data` type
			// (e.g. `listProjects().data` would be `ProjectsResponse | GeneralError`).
			// Reclassify it as a `4XX` error response so it lands only on `error`.
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
	plugins: ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk"],
});
