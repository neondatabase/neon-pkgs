import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/config-runtime",
	bundle: false,
	clean: true,
	dts: true,
	entry: [
		"src/index.ts",
		"src/v1.ts",
		"src/lib/**/*.ts",
		"!src/**/*.test.*",
		"!src/lib/fake-neon-api.ts",
	],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	// esbuild and fflate are real, auto-installed dependencies of this package — but they
	// must stay external so the published runtime resolves them from node_modules rather
	// than inlining esbuild's native binary into the bundle.
	external: ["esbuild", "fflate", "@neon/config"],
});
