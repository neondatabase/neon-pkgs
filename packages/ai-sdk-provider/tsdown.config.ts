import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neondatabase/ai-sdk-provider",
	bundle: false,
	clean: true,
	dts: true,
	entry: ["src/index.ts", "src/lib/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
