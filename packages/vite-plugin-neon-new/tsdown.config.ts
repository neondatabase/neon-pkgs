import { defineConfig } from "tsdown";

export default defineConfig({
	name: "vite-plugin-neon-new",
	bundle: false,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
