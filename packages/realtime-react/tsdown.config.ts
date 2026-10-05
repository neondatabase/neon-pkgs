import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/realtime-react",
	unbundle: true,
	clean: true,
	dts: true,
	entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.test.*"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: ["@neon/realtime", /^@neon\/realtime\//, "react", /^react\//],
});
