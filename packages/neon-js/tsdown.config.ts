import { defineConfig } from "tsdown";

/**
 * Keep every package import a runtime import, except the private `@neon-internals/*` packages,
 * which have to be compiled in — they are never published, so a bare specifier surviving into
 * `dist` cannot resolve for anyone who installed from npm.
 */
const externalExceptInternals = (id: string): boolean =>
	!id.startsWith(".") &&
	!id.startsWith("/") &&
	!id.startsWith("\\") &&
	!id.startsWith("#") &&
	!id.startsWith("\0") &&
	!/^[a-zA-Z]:[\\/]/.test(id) &&
	!id.startsWith("@neon-internals/");

export default defineConfig({
	name: "@neon/neon-js",
	bundle: true,
	clean: true,
	dts: { resolve: [/^@neon-internals\//] },
	entry: [
		"src/index.ts",
		"src/auth/index.ts",
		"src/auth/types/index.ts",
		"src/auth/react/index.ts",
		"src/auth/react/adapters/index.ts",
		"src/auth/vanilla/index.ts",
		"src/auth/vanilla/adapters/index.ts",
		"src/auth/next/index.ts",
		"src/auth/next/server/index.ts",
		// Mirrors `@neon/auth/server` so adopters of the full SDK can build framework
		// adapters without adding `@neon/auth` as a separate dependency.
		"src/auth/server/index.ts",
	],
	format: "esm",
	// Entry declarations are emitted under the chunk name pattern, so with a hash
	// `dist/index.d.ts` becomes `dist/index-<hash>.d.ts` and `types` stops resolving.
	hash: false,
	outDir: "dist",
	treeshake: true,
	external: externalExceptInternals,
});
