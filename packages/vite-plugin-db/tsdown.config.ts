import { defineConfig } from "tsdown";

export default defineConfig({
	name: "vite-plugin-db",
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
});
