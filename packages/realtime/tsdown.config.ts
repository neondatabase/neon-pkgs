import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/realtime",
	unbundle: true,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/client.ts",
		"src/server.ts",
		"src/client/**/*.ts",
		"src/server/**/*.ts",
		"!src/**/*.test.*",
		"!src/**/*.test-helpers.ts",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
