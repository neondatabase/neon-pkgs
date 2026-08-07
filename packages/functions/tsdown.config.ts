import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/functions",
	bundle: false,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/hono.ts",
		"src/lib/**/*.ts",
		"!src/**/*.test.*",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
