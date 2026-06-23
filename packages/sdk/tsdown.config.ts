import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neondatabase/sdk",
	bundle: false,
	clean: true,
	dts: true,
	entry: ["src/index.ts", "src/client/**/*.ts"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
