import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neondatabase/functions",
	bundle: false,
	clean: true,
	dts: true,
	entry: ["src/index.ts", "src/v1.ts", "src/lib/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
