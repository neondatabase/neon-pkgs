import { defineConfig } from "tsdown";

/**
 * Keep every package import external, including in the declaration output. Without this the
 * `.d.ts` inlines a copy of `@neon/config`'s types, and a consumer that bundles this package ends
 * up publishing two structurally identical `Config` types — one imported, one copied — which is
 * what a user sees on hover and in a mismatch error.
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
