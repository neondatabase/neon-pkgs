import { defineConfig } from "tsdown";

/**
 * Keep every package import a runtime import, except the private `@neon-internals/*` packages,
 * which have to be compiled in — they are never published, so a bare specifier surviving into
 * `dist` cannot resolve for anyone who installed from npm.
 *
 * tsdown externalizes declared runtime dependencies only, so without the shape tests a
 * devDependency reached from shipped source gets inlined with its whole transitive graph:
 * `src/test_utils/*` imports vitest, express and emocks.
 *
 * Shape rather than `isResolved`, because rolldown calls `external` for resolved ids too and a
 * resolved absolute path must never be treated as a package. Both Windows forms have to be
 * rejected on any host, since neither looks absolute to POSIX: a drive letter, and a UNC path.
 * rolldown's virtual modules start with a NUL, and `#` is a package's own subpath import, which
 * resolves locally.
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
	name: "neon",
	// Bundled so `@neon-internals/*` — private, never published — is compiled into
	// `dist` instead of surviving as a bare specifier nobody can resolve from npm.
	bundle: true,
	clean: true,
	// `neon` publishes no declarations: `packages/cli/tsconfig.json` never set
	// `declaration`, so `tsc` emitted none and `exports["."]` has no `types`.
	dts: false,
	// Every non-test source file, so each one keeps emitting to its own path under
	// `dist/` — `neon` exports a `./dist/*` wildcard, and collapsing that layout would
	// move files a caller can currently import.
	entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	external: externalExceptInternals,
	outputOptions: {
		// Shared modules land in one directory so `exports` can keep them off the
		// published surface, the way `./dist/*` would otherwise expose them.
		chunkFileNames: "_chunks/[name]-[hash].js",
	},
});
