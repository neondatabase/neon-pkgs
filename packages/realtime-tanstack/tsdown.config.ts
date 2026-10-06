import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/realtime-tanstack",
	unbundle: true,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: [
		"@neon/realtime",
		/^@neon\/realtime\//,
		"@standard-schema/spec",
		"@tanstack/db",
	],
});
