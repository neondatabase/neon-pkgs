import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/effect",
	bundle: false,
	clean: true,
	dts: false,
	entry: ["src/**/*.ts", "!src/**/*.test.*", "!src/**/*.test-d.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
