import { defineConfig } from "tsdown";

/**
 * Keep any future package import external in the JavaScript and declaration output. `cli-core`
 * is dependency-free today; its consumers decide what to inline.
 */
const isPackageImport = (id: string): boolean =>
	!id.startsWith(".") &&
	!id.startsWith("/") &&
	!id.startsWith("\\") &&
	!id.startsWith("#") &&
	!id.startsWith("\0") &&
	!/^[a-zA-Z]:[\\/]/.test(id);

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
	external: isPackageImport,
});
