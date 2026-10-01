import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/live-kysely",
	unbundle: true,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: ["@neon/live", /^@neon\/live\//, "kysely", /^kysely\//],
});
