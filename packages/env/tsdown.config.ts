import { defineConfig } from "tsdown";

/**
 * Keep every package import a runtime import, except the private `@neon-internals/*` packages,
 * which have to be compiled in — they are never published, so a bare specifier surviving into
 * `dist` cannot resolve for anyone who installed from npm.
 *
 * tsdown externalizes declared runtime dependencies only, so without the first test a
 * devDependency reached from shipped source gets inlined with its whole transitive graph.
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
	name: "@neon/env",
	// Bundled so `@neon-internals/*` — private, never published — is compiled into
	// `dist` instead of surviving as a bare specifier nobody can resolve from npm.
	bundle: true,
	clean: true,
	// `resolve` because the internals are reached through `node_modules`, which the
	// declaration bundler leaves external by default. `index.ts` re-exports types from
	// `@neon-internals/env-core/env`, and without this they land in the emitted `.d.ts`
	// as names with no definition.
	dts: { resolve: [/^@neon-internals\//] },
	// The two things this package exposes: the `.` export and the `neon-env` bin.
	// Everything else is reached through them, so nothing else needs to be an entry —
	// `exports` names no subpath, so no other emitted file was ever importable.
	entry: ["src/index.ts", "src/cli.ts"],
	format: "esm",
	// Entry declarations are emitted under the chunk name pattern, so with a hash
	// `dist/index.d.ts` becomes `dist/index-<hash>.d.ts` and `types` stops resolving.
	hash: false,
	outDir: "dist",
	treeshake: true,
	external: externalExceptInternals,
});
