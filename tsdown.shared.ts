/**
 * Shared pieces of the tsdown configs, so the rule about what gets bundled is stated once.
 */

/**
 * Whether a specifier is a package import rather than a file in the package being built.
 *
 * Shape rather than `isResolved`, because rolldown calls `external` for resolved ids too and a
 * resolved absolute path must never be treated as a package: `C:\…` on Windows starts with a
 * letter, and rolldown's virtual modules start with a NUL. `#` is a package's own subpath import,
 * which resolves locally.
 */
export const isPackageImport = (id: string): boolean =>
	!id.startsWith(".") &&
	!id.startsWith("/") &&
	!id.startsWith("#") &&
	!id.startsWith("\0") &&
	!/^[a-zA-Z]:[\\/]/.test(id);

/**
 * Keep every package import a runtime import, except the private `@neon-internals/*` packages,
 * which have to be compiled in — they are never published, so a bare specifier surviving into
 * `dist` cannot resolve for anyone who installed from npm.
 *
 * tsdown externalizes declared runtime dependencies only, so without the first half a
 * devDependency reached from shipped source gets inlined with its whole transitive graph.
 */
export const externalExceptInternals = (id: string): boolean =>
	isPackageImport(id) && !id.startsWith("@neon-internals/");
