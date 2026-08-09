import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/env",
	bundle: false,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/cli.ts",
		"src/lib/**/*.ts",
		// Compiled as this package's own source — `scripts/sync-shared.mjs` copies it in.
		"src/_shared/**/*.ts",
		"!src/**/*.test.*",
		"!src/**/*.test-d.*",
		"!src/lib/fake-neon-api.ts",
		"!src/lib/test-utils.ts",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
