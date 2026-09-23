import { defineConfig } from "tsdown";
import { preserveDirectives } from "./build/preserve-directives.ts";

/**
 * Keep every package import a runtime import, except the private `@neon-internals/*` packages
 * (which have to be compiled in — they are never published, so a bare specifier surviving into
 * `dist` cannot resolve for anyone who installed from npm) and the `@/*` tsconfig path alias
 * (which resolves to `./src/*`, see tsconfig.json — it has no meaning outside this package's
 * compiler settings, so it must be inlined rather than passed through as an external import).
 * The external function receives the raw import source before rolldown's tsconfig-paths-aware
 * resolver runs, so an id starting with `@/` must be excluded here for that resolution to happen.
 */
const externalExceptInternals = (id: string): boolean =>
	!id.startsWith(".") &&
	!id.startsWith("/") &&
	!id.startsWith("\\") &&
	!id.startsWith("#") &&
	!id.startsWith("\0") &&
	!/^[a-zA-Z]:[\\/]/.test(id) &&
	!id.startsWith("@neon-internals/") &&
	!id.startsWith("@/");

export default defineConfig({
	name: "@neon/auth",
	bundle: true,
	clean: true,
	dts: { resolve: [/^@neon-internals\//] },
	entry: [
		"src/index.ts",
		"src/types/index.ts",

		"src/react/index.ts",
		"src/react/adapters/index.ts",

		"src/vanilla/index.ts",
		"src/vanilla/adapters/index.ts",

		"src/next/index.ts",
		"src/next/server/index.ts",

		// Public framework-agnostic toolkit. Consumers: framework adapter
		// authors (Hono, Remix, SolidStart, Express, …). See BUILDING-AN-ADAPTER.md.
		"src/server/index.ts",
	],
	format: "esm",
	// Entry declarations are emitted under the chunk name pattern, so with a hash
	// `dist/index.d.ts` becomes `dist/index-<hash>.d.ts` and `types` stops resolving.
	hash: false,
	outDir: "dist",
	plugins: [preserveDirectives()],
	treeshake: true,
	external: externalExceptInternals,
});
