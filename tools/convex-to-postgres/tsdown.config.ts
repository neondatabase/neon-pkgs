import { defineConfig } from "tsdown";

export default defineConfig({
	name: "convex-to-postgres",
	bundle: false,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/test-fixtures.ts"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
