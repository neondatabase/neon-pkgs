import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/live-tanstack",
	unbundle: true,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: [
		"@neon/live",
		/^@neon\/live\//,
		"@standard-schema/spec",
		"@tanstack/db",
	],
});
