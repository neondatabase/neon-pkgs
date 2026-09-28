import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/live-react",
	unbundle: true,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: ["@neon/live", /^@neon\/live\//, "react", /^react\//],
});
