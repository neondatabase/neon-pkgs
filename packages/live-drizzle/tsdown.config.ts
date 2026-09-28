import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/live-drizzle",
	unbundle: true,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: ["@neon/live", /^@neon\/live\//, "drizzle-orm", /^drizzle-orm\//],
});
