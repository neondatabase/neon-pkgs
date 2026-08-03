import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/sdk",
	bundle: false,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/raw.ts",
		"src/neon/**/*.ts",
		"src/client/**/*.ts",
		"!src/**/*.test.*",
		"!src/**/*.test-d.*",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
