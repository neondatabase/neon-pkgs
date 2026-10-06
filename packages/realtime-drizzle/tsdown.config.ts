import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/realtime-drizzle",
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
		"drizzle-orm",
		/^drizzle-orm\//,
	],
});
