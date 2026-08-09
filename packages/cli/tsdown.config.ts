import { defineConfig } from "tsdown";

/**
 * Whether a specifier is a package import rather than a file in this package.
 *
 * Shape rather than `isResolved`, because rolldown calls `external` for resolved ids too and a
 * resolved absolute path must never be treated as a package. Both Windows forms have to be
 * rejected on any host, since neither looks absolute to POSIX: a drive letter, and a UNC path.
 * rolldown's virtual modules start with a NUL, and `#` is a package's own subpath import, which
 * resolves locally.
 */
const isPackageImport = (id: string): boolean =>
	!id.startsWith(".") &&
	!id.startsWith("/") &&
	!id.startsWith("\\") &&
	!id.startsWith("#") &&
	!id.startsWith("\0") &&
	!/^[a-zA-Z]:[\\/]/.test(id);

export default defineConfig({
	name: "neon",
	bundle: false,
	clean: true,
	// `neon` publishes no declarations: `packages/cli/tsconfig.json` never set
	// `declaration`, so `tsc` emitted none and `exports["."]` has no `types`.
	dts: false,
	// Every non-test source file, so each one keeps emitting to its own path under
	// `dist/` — `neon` exports a `./dist/*` wildcard, and `src/_shared` is synced-in
	// source that has to compile as this package's own.
	entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	// Every bare specifier stays a runtime import, which is what `tsc` emitted. tsdown
	// externalizes declared runtime dependencies only, so without this `src/test_utils/*`
	// — which imports vitest, express and emocks — drags those devDependencies and their
	// transitive graph into `dist/node_modules/`.
	external: isPackageImport,
});
