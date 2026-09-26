import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/sdk",
	bundle: false,
	clean: true,
	// Declarations come from `tsc -p tsconfig.build.json`. rolldown-plugin-dts 0.15 turns
	// `export * as raw` into an import of the JS runtime helper and an undeclared
	// `raw_d_exports`, which breaks every consumer that type-checks libraries.
	dts: false,
	entry: [
		"src/index.ts",
		"src/raw.ts",
		"src/neon/**/*.ts",
		"src/client/**/*.ts",
		"!src/**/*.test.*",
		"!src/**/*.test-d.*",
	],
	format: "esm",
	sourcemap: true,
	outDir: "dist",
	treeshake: true,
});
