import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/env",
	bundle: false,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/runtime.ts",
		"src/cli.ts",
		"src/lib/**/*.ts",
		"!src/**/*.test.*",
		"!src/**/*.test-d.*",
		"!src/lib/fake-neon-api.ts",
		"!src/lib/test-utils.ts",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
