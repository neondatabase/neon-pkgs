import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/tools",
	bundle: false,
	clean: true,
	dts: false,
	entry: [
		"src/index.ts",
		"src/mcp.ts",
		"src/mcp-v1.ts",
		"src/schemas.ts",
		"src/eve.ts",
		"src/mastra.ts",
		"src/operations.gen.ts",
		"src/lib/**/*.ts",
		"src/generated/**/*.ts",
		"!src/**/*.test.*",
		"!src/**/*.test-d.*",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
