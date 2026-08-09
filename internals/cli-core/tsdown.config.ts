import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon-internals/cli-core",
	bundle: false,
	clean: true,
	// Consumers bundle this package, and their declaration bundlers can only inline
	// declarations that exist, so this one emits them even though nothing publishes it.
	dts: true,
	entry: ["src/*.ts", "!src/**/*.test.ts"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
});
